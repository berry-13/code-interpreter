import axios from 'axios';
import busboy from 'busboy';
import { nanoid } from 'nanoid';
import { Router } from 'express';
import type { Response } from 'express';
import type { Readable } from 'stream';
import type { Job, QueueEvents } from 'bullmq';
import type * as t from '../types';
import { checkServiceStartUp, checkServiceShutDown } from '../lifecycle';
import { sessionAuth } from '../middleware/auth';
import { executionLimiter, uploadLimiter, downloadLimiter, fetchLimiter } from '../middleware/limits';
import { internalServiceHeaders } from '../internal-service-auth';
import { resolveSessionKey, resolveOutputBucketSessionKey, SessionKeyResolutionError, parseUploadSessionKeyInput, type SessionKeyInput } from '../session-key';
import { pyQueue, otherQueue, pyQueueEvents, otherQueueEvents, connection } from '../queue';
import { sleep, getAxiosErrorDetails, publicExecutionFailure } from '../utils';
import { env, planLimits, resolveLanguage } from '../config';
import { createPayload } from '../payload';
import {
  SESSION_STATE_FILE_ID,
  SESSION_STATE_RESTORE_MARKER,
  SESSION_STATE_TAR_FILENAME,
  isReservedSessionInputName,
  sessionStatePointerKey,
} from '../session-persist';
import { summarizeRequestedFiles } from '../execution-log';
import { getCredentialId, getPrincipalOrReject } from '../auth/principal';
import { isSyntheticPrincipalSource } from '../auth/synthetic';
import { getExecutionIdentity } from '../execution-identity';
import { jobsSubmitted } from '../metrics';
import { captureTraceCarrier, withSpan } from '../telemetry';
import { Jobs, Languages } from '../enum';
import { FileRefAuthorizationError, authorizeRequestedFiles } from './file-authorization';
import { prepareSandboxJobSecurity } from '../sandbox-egress';
import logger from '../logger';

const { INSTANCE_ID } = env;

const UPLOAD_TIMEOUT_MS = 30_000;
/* Batch cap sized for skill-priming uploads: a single skill (e.g. pptx)
 * can carry 60+ resource files including .xsd schemas, helper scripts,
 * docs, and Python __init__.py markers. The previous cap of 20 silently
 * dropped most files past the limit, surfacing as "missing files" in the
 * caller. */
const MAX_BATCH_FILES = 200;

function validateUploadRequest(req: t.AuthenticatedRequest, res: Response): string | null {
  const principal = getPrincipalOrReject(req, res);
  if (!principal) return null;
  if (req.headers['content-type']?.includes('multipart/form-data') !== true) {
    res.status(400).json({ error: 'Invalid content type. Must be multipart/form-data.' });
    return null;
  }
  if (checkServiceShutDown()) {
    res.status(503).json({ error: 'Service is shutting down' });
    return null;
  }
  if (checkServiceStartUp()) {
    res.status(503).json({ error: 'Service is starting up' });
    return null;
  }
  return principal.userId;
}

function sendFileRefAuthorizationError(
  error: unknown,
  res: Response,
  req?: t.AuthenticatedRequest,
): boolean {
  if (error instanceof FileRefAuthorizationError) {
    const queryEntityId = typeof req?.query?.entity_id === 'string' ? req.query.entity_id : undefined;
    logger.warn('File reference authorization rejected', {
      status: error.status,
      reason: error.reason,
      message: error.message,
      requestUserId: req?.codeApiAuthContext?.userId,
      requestApiKeyId: req ? getCredentialId(req) : undefined,
      requestEntityId: queryEntityId,
      tenantId: req?.codeApiAuthContext?.tenantId,
      ...error.context,
    });
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

/**
 * Mirrors `sendFileRefAuthorizationError`'s return-true-when-handled
 * shape and logs the rejection before responding. Without the log,
 * sessionKey misconfigurations (e.g. middleware not populating
 * `codeApiAuthContext`, malformed kind/version on uploads) would
 * surface as 500/400s in the response body with zero server-side
 * trail — silent in production logs and easy to miss until a user
 * reports it. Includes auth/request context so the failure mode is
 * traceable without correlating HTTP captures.
 */
function sendSessionKeyResolutionError(
  error: unknown,
  res: Response,
  req: t.AuthenticatedRequest,
  context: string,
): boolean {
  if (error instanceof SessionKeyResolutionError) {
    logger.error(`[${INSTANCE_ID}] sessionKey resolution failed (${context})`, {
      status: error.status,
      message: error.message,
      method: req.method,
      path: req.path,
      requestUserId: req.codeApiAuthContext?.userId,
      authContextUserId: req.codeApiAuthContext?.userId,
      tenantId: req.codeApiAuthContext?.tenantId,
    });
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

const router = Router();

/* Atomically advance the session-state pointer (compare-and-swap). Advances
 * when the key still holds the value this run restored from (`cur == ARGV[1]`),
 * or when the key is absent AND this is a true first run (expected `''`).
 * Returns whether the swap happened, so a run whose baseline was overtaken by
 * a concurrent run doesn't roll the pointer back to stale state.
 *
 * A missing key must NOT satisfy a non-empty expectation: two continuations
 * can restore snapshot A, the faster one advances the pointer to B, and B's
 * key can then TTL-expire before the slower run finishes -- letting the
 * slower run's CAS "succeed" against the absent key would publish its stale
 * A-based snapshot over B's lineage, silently losing B's changes. The
 * mid-run-lapse case this arm used to cover (a run that started seconds
 * before SESSION_STATE_TTL_SECONDS elapsed) is instead handled where it
 * belongs: claimPriorSnapshotRef floors the pointer's TTL at the max
 * in-flight window when the claim is taken, so a pointer can no longer
 * expire under a legitimately claimed run. A CAS that still finds the key
 * missing is therefore genuinely stale (or a first run racing an expiry) and
 * discarding its snapshot is the safe outcome. */
const CAS_ADVANCE_SESSION_POINTER = `
local cur = redis.call('GET', KEYS[1])
if (cur == false and ARGV[1] == '') or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0`;

async function casAdvanceSessionPointer(
  key: string,
  expected: string | null,
  next: string,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await connection.eval(
    CAS_ADVANCE_SESSION_POINTER, 1, key, expected ?? '', next, String(ttlSeconds),
  );
  return result === 1;
}

/* Reads the session pointer and claims a ref on whatever snapshot it names, in
 * one Redis round trip. A plain GET followed by a separate INCR (two round
 * trips) leaves a window where a concurrent run's own finishing sequence --
 * CAS-advance the pointer past this snapshot, then decrement its ref to zero
 * and delete it -- can complete entirely in between: this run's GET would
 * have already returned the now-deleted snapshot id, and its later INCR would
 * claim a ref on an object that's gone, so its restore 404s and the run
 * silently starts from an empty workspace. Folding both into one script
 * closes the window: Redis serializes all commands from all clients, so
 * either this claim lands before the other run's DECR (which then sees the
 * live ref and skips the delete) or after its CAS-advance (in which case this
 * run reads the already-advanced pointer, never claiming the stale id at
 * all). */
const CLAIM_PRIOR_SNAPSHOT_REF = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ptrTtl = redis.call('TTL', KEYS[1])
  if ptrTtl >= 0 and ptrTtl < tonumber(ARGV[2]) then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
  end
  local refKey = 'snapshotrefs:' .. cur
  redis.call('INCR', refKey)
  redis.call('EXPIRE', refKey, ARGV[1])
end
return cur`;

/** Returns the session pointer's current snapshot id (or null if unset),
 *  having atomically claimed a ref on it in the same call.
 *
 *  The claim also FLOORS the pointer's own TTL at `pointerFloorSeconds`
 *  (extending only when the remaining TTL is below it, never resetting a
 *  healthy TTL): a pointer within seconds of SESSION_STATE_TTL_SECONDS
 *  expiry could otherwise lapse while the claiming job is still queued or
 *  running -- a second request arriving after that expiry would see no
 *  prior snapshot, run cold, and CAS its cold state into the absent key,
 *  making the original job's valid restored state lose its own CAS and be
 *  discarded. The floor is the max in-flight job window, NOT a full TTL
 *  refresh: a full refresh here would extend a possibly-dead pointer by the
 *  whole SESSION_STATE_TTL on every attempt. The floor does still prolong a
 *  dead pointer while retries keep arriving -- that case is handled by the
 *  restore-failure streak (noteRestoreFailure), which RELEASES the pointer
 *  after a few consecutive failed restores regardless of claim activity. */
async function claimPriorSnapshotRef(
  pointerKey: string,
  refTtlSeconds: number,
  pointerFloorSeconds: number,
): Promise<string | null> {
  const result = await connection.eval(
    CLAIM_PRIOR_SNAPSHOT_REF, 1, pointerKey, String(refTtlSeconds), String(pointerFloorSeconds),
  );
  return typeof result === 'string' && result.length > 0 ? result : null;
}

/* Releases one ref. A plain DECR on a key that has already EXPIRED would mint
 * a fresh counter at -1 and read as "last ref drained" -- but a missing key
 * means the refcount is simply UNKNOWN. EXISTS+DECR in one script is atomic
 * (Redis serializes scripts), and a missing key reports a positive remainder
 * so the caller stays conservative and keeps the snapshot, the same stance
 * the pointer-read failure path below takes. */
const RELEASE_SNAPSHOT_REF = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 1 end
return redis.call('DECR', KEYS[1])`;

/* How long the `finally` block below keeps waiting for its own still-queued
 * job before giving up and releasing the ref anyway -- past max run time +
 * a generous queue-wait margin, so neither a crash nor a backed-up queue can
 * hold a ref forever. */
const SNAPSHOT_REF_TTL_SECONDS = Math.ceil(env.JOB_TIMEOUT / 1000) + 60;

/* TTL on the `snapshotrefs:<id>` KEY itself -- deliberately LONGER than any
 * single claim can legitimately be held. A claim is taken before the
 * request's own JOB_TIMEOUT-bounded wait, and the finally block waits at
 * most SNAPSHOT_REF_TTL_SECONDS more before releasing unconditionally, so a
 * live claim spans at most ~(JOB_TIMEOUT + SNAPSHOT_REF_TTL_SECONDS), which
 * this doubles past. The key outliving every live claim is what makes the
 * refcount trustworthy: if it merely matched the claim TTL, a long-queued
 * run's ref could expire while still outstanding, a later run's claim would
 * recreate the key at a fresh count of 1, and draining that count to zero
 * would delete a snapshot the still-queued run was about to restore. By the
 * time this key can actually expire, every earlier claimant has already
 * released or given up its wait. Each new claim's EXPIRE only ever pushes
 * the deadline further out, never closer. */
const SNAPSHOT_REF_KEY_TTL_SECONDS = 2 * SNAPSHOT_REF_TTL_SECONDS;

/* Consecutive failed restores tolerated before the session pointer is
 * released. One or two misses are treated as transient (file-server blip) and
 * cost nothing but a skipped TTL refresh; a streak this long means the
 * snapshot object is gone or corrupt, and keeping the pointer would brick the
 * session -- especially since every new claim floors the pointer's TTL, so
 * active retries alone would keep a dead pointer alive indefinitely. */
const SESSION_RESTORE_FAILURE_LIMIT = 3;

/* Keyed by the SNAPSHOT id, not the sessionKey: a streak must die with the
 * pointer it indicts. Keyed by sessionKey, a stale count (pointer expired
 * naturally at 1-2 failures) would survive into the session's NEXT lifetime
 * -- a cold run publishes a fresh snapshot, then a single transient miss on
 * it inherits the old count, crosses the limit, and RELEASE_DEAD_POINTER
 * deletes the brand-new pointer. Snapshot-scoped keys can't leak across
 * lifetimes, and orphans age out via their TTL. */
function restoreFailureKey(snapshotSession: string): string {
  return `sessionrestorefails:${snapshotSession}`;
}

/* Deletes the pointer only if it still names the snapshot whose restore kept
 * failing -- a concurrent run that already advanced it must not be undone. */
const RELEASE_DEAD_POINTER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0`;

/**
 * Records one failed restore of `priorSnapshotSession`. After
 * SESSION_RESTORE_FAILURE_LIMIT consecutive failures the pointer is released
 * (CAS-guarded), so the next run starts a fresh session instead of retrying a
 * dead snapshot forever. The abandoned snapshot object itself is left to the
 * bucket lifecycle policy, like any other orphan (see the KNOWN GAP note in
 * session-persist.ts).
 */
async function noteRestoreFailure(sessionKey: string, priorSnapshotSession: string): Promise<void> {
  const failKey = restoreFailureKey(priorSnapshotSession);
  try {
    const fails = await connection.incr(failKey);
    await connection.expire(failKey, env.SESSION_STATE_TTL_SECONDS);
    if (fails >= SESSION_RESTORE_FAILURE_LIMIT) {
      const released = await connection.eval(RELEASE_DEAD_POINTER, 1, sessionStatePointerKey(sessionKey), priorSnapshotSession);
      if (released === 1) {
        logger.warn(`[${INSTANCE_ID}] Released session pointer after ${fails} consecutive failed restores`);
      }
      await connection.del(failKey);
    }
  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Failed to record restore failure:`, error);
  }
}

/** Fire-and-forget delete of a session's hidden snapshot object. */
function deleteSessionSnapshot(outputSession: string): void {
  axios.delete(
    `${env.FILE_SERVER_URL}/sessions/${encodeURIComponent(outputSession)}/objects/${encodeURIComponent(SESSION_STATE_FILE_ID)}`,
    { headers: internalServiceHeaders() },
  ).catch((error) => {
    logger.warn(`[${INSTANCE_ID}] Failed to delete session snapshot:`, getAxiosErrorDetails(error));
  });
}

router.post('/exec', executionLimiter, async (req: t.AuthenticatedRequest, res) => {
  const principal = getPrincipalOrReject(req, res);
  if (!principal) return;
  const apiKeyId = getCredentialId(req);
  const userId = principal.userId;
  const identity = getExecutionIdentity(req, userId);
  const isSyntheticRequest = isSyntheticPrincipalSource(identity.principalSource);

  if (checkServiceShutDown()) {
    return res.status(503).json({ error: 'Service is shutting down' });
  }

  if (checkServiceStartUp()) {
    return res.status(503).json({ error: 'Service is starting up' });
  }

  const body = req.body as t.RequestBody;
  const { user_id, lang: rawLang, code, files } = body;
  const language = resolveLanguage(rawLang);
  if (language == null) {
    return res.status(400).json({ error: `Unsupported language: ${rawLang}` });
  }

  let authorizedFiles: t.RequestFile[];
  try {
    authorizedFiles = await authorizeRequestedFiles({
      req,
      files,
      store: connection,
    });
    body.files = authorizedFiles.length > 0 ? authorizedFiles : undefined;
  } catch (error) {
    if (sendFileRefAuthorizationError(error, res, req)) return;
    logger.error(`[${INSTANCE_ID}] Error authorizing file refs:`, error);
    return res.status(500).json({ error: 'Internal server error' });
  }

  /* Output bucket sessionKey is hardcoded user-private regardless of
   * input file kinds — outputs always belong to the requesting user.
   * Skill executions do NOT produce a skill-scoped output bucket; that's
   * a deliberate behavioral change from the legacy entity_id-driven
   * derivation. See codeapi #1455 / Phase C design. */
  let sessionKey: string;
  try {
    sessionKey = resolveOutputBucketSessionKey(req);
  } catch (error) {
    if (sendSessionKeyResolutionError(error, res, req, 'resolveOutputBucketSessionKey')) return;
    throw error;
  }

  /* The execute call generates a fresh session id used as both the
   * Job.uuid (top-level execution scope) and the storage prefix for any
   * output files this run produces (worker writes to `<uuid>/<file_id>`).
   * The two roles share the value by design — naming it
   * `session_id` since the primary semantic is "the running
   * sandbox invocation." */
  const session_id = nanoid();
  const execution_id = nanoid();
  await connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);

  // Persistent-session pointer bookkeeping (used across the injection, advance,
  // and finally blocks). `snapshotRefKey` refcounts in-flight restores of the
  // prior snapshot so a concurrent run can't delete it before this run primes.
  let priorSnapshotSession: string | null = null;
  let snapshotRefKey: string | null = null;
  let pointerAdvanced = false;
  // Hoisted out of the try block so `finally` can wait on the job's actual
  // terminal state (not just this request's own wait) before releasing its
  // snapshot ref -- see the finally block below.
  let job: Job<t.JobData, t.JobResult, Jobs.execute> | undefined;
  let queueEvents: QueueEvents | undefined;

  try {
    if (!isSyntheticRequest) {
      logger.info('Request received', {
        userId,
        apiKeyId,
        user: user_id,
        session_id,
        language,
        files: summarizeRequestedFiles(authorizedFiles),
        sessionKey,
      });
    }

    /* isPyPlot is a static scan of THIS run's own source only -- it must stay
     * that way. It was briefly broadened to also fire on any persistent-
     * session continuation (to catch a restored `plt` alias used without a
     * fresh `import matplotlib`), but createPayload() embeds isPyPlot-true
     * code inside the matplotlib.py template. Routing EVERY continuation
     * through that broke a literal `from __future__ import ...` in the
     * user's own code: it becomes a SyntaxError once it's no longer the
     * first statement of its compilation unit (matplotlib.py's own imports
     * now precede it). That's still true regardless of where in the
     * template the user code sits, so isPyPlot stays a per-run scan.
     * Reverted; the restored-`plt`-without-reimport gap is a known, smaller
     * limitation. (A related bug this broadening also hit -- user code
     * running inside the template's function scope, so `x += 1` on a
     * restored global raised UnboundLocalError -- is now fixed: user code
     * runs at module scope, see matplotlib.py.) */
    const isPyPlot = language === Languages.py && (code.includes('import matplotlib') || code.includes('import seaborn'));
    const rawPayload = createPayload({
      req,
      isPyPlot,
      session_id,
    });

    /* Persistent sessions (opt-in). Rendezvous on the caller's own auth-derived
     * sessionKey via a Redis pointer to the previous run's output session:
     *   - Mark the payload so the sandbox snapshots /mnt/data back to THIS run's
     *     output session (the only session the egress grant lets it write).
     *   - If a prior snapshot exists, inject it as a synthetic input file. Being
     *     an input file, its storage_session_id flows into the manifest/grant
     *     read_sessions + input_files, authorizing the sandbox to fetch it — no
     *     file-server or Redis-auth change needed. Done before
     *     prepareSandboxJobSecurity so it is covered by the signed manifest. */
    // Reserve every persistence artifact name: the state tar (identified in
    // the sandbox by name only, since egress masks file id/session) and the
    // namespace snapshot `.session_state.pkl` (+ its tempfile). A user input
    // with any of these names would shadow restored state or be mistaken for
    // the injected snapshot.
    // Also reject refs to the hidden snapshot by its fixed storage ID (or
    // any prefix that file-server's prefix matching would resolve to it):
    // the snapshot upload creates a normal `upload:` cache entry under the
    // caller's own session, so authorizeRequestedFiles would accept
    // `id: codeapi-session-state` with a harmless-looking name and stage
    // the internal workspace tar as an ordinary input -- bypassing the
    // download/list routes that deliberately hide this artifact.
    // DELIBERATELY outside the env.PERSIST_SESSIONS gate: snapshot objects
    // written while the feature was enabled outlive a rollback (their
    // `upload:` cache entries included), and the list/download routes keep
    // hiding them unconditionally -- so the input-ref door must stay closed
    // unconditionally too. Only the injection/pointer logic below is gated.
    const reservedInput = (authorizedFiles ?? []).find(
      f => isReservedSessionInputName(f.name) || (typeof f.id === 'string' && isSessionStateFileId(f.id)),
    );
    if (reservedInput) {
      return res.status(400).json({ error: `File name '${reservedInput.name}' is reserved for session persistence` });
    }

    if (env.PERSIST_SESSIONS) {
      rawPayload.persist_session = {
        file_id: SESSION_STATE_FILE_ID,
        filename: SESSION_STATE_TAR_FILENAME,
      };
      // Reads the pointer and claims a ref on the snapshot it names in one
      // atomic call, so a concurrent run's finish sequence can't advance past
      // and delete that snapshot in the gap between reading and claiming it
      // (see claimPriorSnapshotRef). The key TTL strictly dominates the
      // longest legitimate hold (see SNAPSHOT_REF_KEY_TTL_SECONDS) so expiry
      // can't erase an outstanding ref, while still bounding a crashed
      // handler's leak.
      priorSnapshotSession = await claimPriorSnapshotRef(
        sessionStatePointerKey(sessionKey),
        SNAPSHOT_REF_KEY_TTL_SECONDS,
        // Pointer TTL floor = the same max in-flight window, so the pointer
        // can't expire under a job that just claimed it (see claim docs).
        SNAPSHOT_REF_KEY_TTL_SECONDS,
      );
      if (priorSnapshotSession) {
        snapshotRefKey = `snapshotrefs:${priorSnapshotSession}`;
        // Presence marker only -- never the raw prior session id, which
        // prepareSandboxEgress does not rewrite and would otherwise reach the
        // sandbox unmasked (see SESSION_STATE_RESTORE_MARKER). The sandbox
        // locates the snapshot via the injected file entry below, whose
        // id/session ARE masked like every other file ref.
        rawPayload.persist_session.restore_session_id = SESSION_STATE_RESTORE_MARKER;
        rawPayload.files.push({
          id: SESSION_STATE_FILE_ID,
          storage_session_id: priorSnapshotSession,
          name: SESSION_STATE_TAR_FILENAME,
        });
      }
    }

    const sandboxSecurity = prepareSandboxJobSecurity({
      req,
      executionId: execution_id,
      userId,
      sessionKey,
      outputSessionId: session_id,
      payload: rawPayload,
    });

    const queue = language === Languages.py ? pyQueue : otherQueue;
    queueEvents = language === Languages.py ? pyQueueEvents : otherQueueEvents;
    const queueName = language === Languages.py ? 'python' : 'other';

    job = await withSpan('codeapi.job.enqueue', {
      'messaging.system': 'bullmq',
      'messaging.destination.name': queueName,
      'codeapi.language': language,
    }, () => {
      const traceCarrier = captureTraceCarrier();
      return queue.add(Jobs.execute, {
        code,
        userId,
        payload: sandboxSecurity.payload,
        apiKeyId,
        isSynthetic: isSyntheticRequest,
        isPyPlot,
        principalSource: identity.principalSource,
        executionId: execution_id,
        tenantId: identity.storageNamespace,
        canonicalUserId: identity.canonicalUserId,
        executionManifestClaims: sandboxSecurity.executionManifestClaims,
        egressGrantClaims: sandboxSecurity.egressGrantClaims,
        egressGrantToken: sandboxSecurity.egressGrantToken,
        _otel: traceCarrier,
      }, {
        removeOnComplete: {
          age: 60,
          count: 1,
        },
        removeOnFail: {
          age: 180,
          count: 1,
        },
        attempts: 1,
        jobId: session_id,
      });
    }, 'PRODUCER');
    jobsSubmitted.inc({ language });
    // Narrowed local bindings: `job`/`queueEvents` are `let ... | undefined` so
    // `finally` can use them after any early return, but that means TS can't
    // narrow them across closures below (they're captured, not re-checked).
    const currentJob = job;
    const currentQueueEvents = queueEvents;

    req.on('close', async () => {
      try {
        await currentJob.remove();
        logger.info(`[${INSTANCE_ID}] Job ${currentJob.id} removed due to client disconnect`);
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error removing job ${currentJob.id} on client disconnect:`, error);
      }
    });

    const result = await withSpan('codeapi.job.wait_until_finished', {
      'messaging.system': 'bullmq',
      'messaging.destination.name': queueName,
      'codeapi.language': language,
    }, () => currentJob.waitUntilFinished(currentQueueEvents, env.JOB_TIMEOUT), 'CONSUMER');

    /* Track the restore-failure streak: a failed restore feeds it (releasing
     * the pointer once the streak hits the limit); any healthy outcome for a
     * run that had a prior snapshot resets it, so only CONSECUTIVE failures
     * count and a transient blip between successes never accumulates. */
    if (env.PERSIST_SESSIONS && priorSnapshotSession) {
      if ((result as t.ExecuteResult)?.session_state_restore_failed) {
        await noteRestoreFailure(sessionKey, priorSnapshotSession);
      } else {
        await connection.del(restoreFailureKey(priorSnapshotSession)).catch(() => { /* best effort */ });
      }
    }

    /* Advance the persistent-session pointer only when the sandbox actually
     * wrote a fresh snapshot to this run's output session. On a skip (oversize
     * / error) we leave the pointer on the last good snapshot so continuity
     * survives. TTL refresh means an active session never expires. */
    if (env.PERSIST_SESSIONS && (result as t.ExecuteResult)?.session_state_persisted) {
      try {
        // Compare-and-swap the pointer: only advance if it still equals what
        // this run restored from. If two runs for the same session overlap, both
        // restore the same prior snapshot; without CAS the slower-to-finish run
        // would advance the pointer to state that omits the other's changes
        // (a rollback). With CAS, the run whose baseline is now stale simply
        // does not advance -- its snapshot is discarded, not the newer one.
        pointerAdvanced = await casAdvanceSessionPointer(
          sessionStatePointerKey(sessionKey),
          priorSnapshotSession,
          session_id,
          env.SESSION_STATE_TTL_SECONDS,
        );
        if (!pointerAdvanced) {
          // A concurrent run already advanced the pointer; this run's snapshot is
          // now orphaned and stale -- drop it (no other run references it).
          logger.warn(`[${INSTANCE_ID}] Session pointer moved concurrently; discarding this run's snapshot`);
          deleteSessionSnapshot(session_id);
        }
        // Deletion of the SUPERSEDED prior snapshot happens in `finally`, after
        // this run releases its ref, so a concurrent run that still needs to
        // restore it isn't left with a 404.
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Failed to advance session-state pointer:`, error);
      }
    } else if (
      env.PERSIST_SESSIONS &&
      priorSnapshotSession &&
      !(result as t.ExecuteResult)?.session_state_restore_failed
    ) {
      // This run restored a prior snapshot but didn't write a fresh one (oversize
      // workspace, upload failure, etc.). The comment above promises an active
      // session's pointer never expires, but that's only true when a fresh
      // snapshot advances it -- a session that stays over cap for longer than
      // SESSION_STATE_TTL_SECONDS across consecutive skipped persists would
      // otherwise have its pointer lapse and lose the last good snapshot even
      // though it's still live. Refresh the TTL on the existing pointer instead.
      // Reusing the CAS advance script with `next == expected == priorSnapshotSession`
      // rewrites the same value while the key is live, without ever
      // clobbering a pointer a concurrent run has since advanced (an
      // already-expired key stays expired -- the CAS no longer recreates
      // missing pointers for continuations, see its comment).
      //
      // EXCEPT after a FAILED restore (the guard above): if the snapshot
      // object is truly gone (lifecycle cleanup) or corrupt, every retry
      // fails, skips persist, and would land here -- refreshing would pin the
      // dead pointer alive forever. Failed restores instead feed a failure
      // streak (see noteRestoreFailure below) that RELEASES the pointer
      // after a few consecutive misses, so the session recovers promptly
      // even under active retries; a one-off transient miss merely skips
      // one refresh and resets the streak on the next success.
      try {
        await casAdvanceSessionPointer(
          sessionStatePointerKey(sessionKey),
          priorSnapshotSession,
          priorSnapshotSession,
          env.SESSION_STATE_TTL_SECONDS,
        );
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Failed to refresh session-state pointer TTL:`, error);
      }
    }

    if (!isSyntheticRequest) {
      logger.info('Execution completed', { session_id, user_id });
    }
    return res.status(200).json(result);
  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | User ID: ${user_id} | Error during execution:`, error);
    const publicFailure = publicExecutionFailure(error);
    if (publicFailure) {
      return res.status(publicFailure.status).json(publicFailure.body);
    }
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    // Release this run's ref on the prior snapshot and delete it only once the
    // pointer has advanced past it AND no other in-flight run still holds a ref
    // (which would otherwise 404 its restore). Runs regardless of success/error.
    if (snapshotRefKey && priorSnapshotSession) {
      if (job && queueEvents) {
        // The wait above can reject (or this whole handler can throw) while the
        // job itself is still queued/active -- e.g. the queue is backed up past
        // JOB_TIMEOUT, so our own wait times out before the job even starts. If
        // we released the ref anyway, a concurrent run that had already advanced
        // the pointer could delete priorSnapshotSession before this still-queued
        // job restores from it. Confirm the job has actually reached a terminal
        // state first, waiting a bit longer if not -- safe to do here since the
        // HTTP response was already sent above. Bounded by the same TTL margin
        // as the ref key itself, so a stuck job can't hold this open forever.
        const state = await job.getState().catch(() => 'unknown');
        if (state !== 'completed' && state !== 'failed') {
          await job.waitUntilFinished(queueEvents, SNAPSHOT_REF_TTL_SECONDS * 1000).catch(() => { /* released below regardless of outcome */ });
        }
      }
      const remaining = Number(await connection.eval(RELEASE_SNAPSHOT_REF, 1, snapshotRefKey).catch(() => 1));
      if (remaining <= 0 && priorSnapshotSession !== session_id) {
        // We're the last in-flight referencer. Delete the prior snapshot only if
        // the pointer no longer references it -- i.e. some run has advanced past
        // it -- rather than keying on this run advancing. That covers the overlap
        // where one run advances (but sees refs outstanding, so it skips the
        // delete) and a later non-advancing run drains the final ref: without the
        // live check that superseded snapshot would leak. The pointer only ever
        // moves to fresh session ids and never back, so once it != the prior
        // snapshot no future run can restore from it or re-take a ref, making the
        // delete safe. A GET failure, or a missing key (pointer TTL lapsed
        // without ever being replaced -- e.g. a continuation restored the prior
        // snapshot and then failed to persist a replacement), both stay
        // conservative (keep the snapshot): only a live pointer that actually
        // names a *different* session proves supersession.
        const currentPointer = await connection
          .get(sessionStatePointerKey(sessionKey))
          .catch(() => priorSnapshotSession);
        if (currentPointer && currentPointer !== priorSnapshotSession) {
          deleteSessionSnapshot(priorSnapshotSession);
        }
      }
    }
  }
});

router.get('/download/:session_id/:fileId', downloadLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  // The hidden persistent-session snapshot is internal state, not a user file.
  if (isSessionStateFileId(fileId)) {
    return res.status(404).json({ error: 'File not found' });
  }

  let exists = 0;
  const uploadKey = `upload:${req.sessionKey}${session_id}${fileId}`;
  for (let i = 0; i < env.MAX_UPLOAD_CHECKS; i++) {
    exists = await connection.exists(uploadKey);
    if (exists === 1) {
      break;
    }
    await sleep(env.MAX_UPLOAD_WAIT);
  }

  if (exists === 0) {
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | File ID: ${fileId} | File not found in cache`);
    return res.status(404).json({
      error: 'File not found',
      details: 'The file may have expired or does not exist'
    });
  }

  try {
    const response = await axios({
      method: 'get',
      url: `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
      headers: internalServiceHeaders(),
      responseType: 'stream'
    });

    res.set(response.headers);
    response.data.pipe(res);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Session ID: ${session_id} | File ID: ${fileId} | Error downloading file:`, errorDetails);

    return res.status(500).json({
      error: 'Error downloading file',
      details: (error as Error).message
    });
  }
});

router.post('/upload', uploadLimiter, async (req: t.AuthenticatedRequest, res: Response) => {
  try {
    const userId = validateUploadRequest(req, res);
    if (userId == null) return;

    const session_id = nanoid();
    /* `kind`/`id`/`version?` form fields drive the upload-bucket
     * sessionKey via `resolveSessionKey`, replacing the legacy
     * `entity_id` form field. Same validation rules as /exec
     * `RequestFile`: kind is required, version is required for
     * `'skill'` and forbidden otherwise. */
    let uploadKind: string | undefined;
    let uploadId: string | undefined;
    let uploadVersionRaw: string | undefined;
    let readOnly = false;
    let hasResponded = false;

    const planFileSize = planLimits[req.planId ?? '']?.max_file_size ?? planLimits.default.max_file_size;
    /* preservePath keeps subdirectory components in the multipart filename
     * (e.g. `pptx/editing.md`). The busboy 1.x default strips to basename,
     * which collapses skill-file paths and breaks the caller's filename
     * lookups (skill files look "missing" even when uploaded). */
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: planFileSize },
      preservePath: true,
    });

    const uploadPromises: Promise<t.UploadResult>[] = [];

    bb.on('field', (fieldname: string, val: string) => {
      if (fieldname === 'kind') {
        uploadKind = val;
      } else if (fieldname === 'id') {
        uploadId = val;
      } else if (fieldname === 'version') {
        uploadVersionRaw = val;
      } else if (fieldname === 'read_only') {
        /* `read_only=true` declares these uploads as infrastructure inputs
         * (e.g. skill files) — the sandbox API and downstream callers
         * MUST treat them as never-emit-back artifacts even if sandboxed
         * code modifies the bytes on disk. Persisted as MinIO object
         * metadata downstream so it travels with the file. */
        readOnly = val.toLowerCase() === 'true';
      }
    });

    bb.on('file', (_fieldname: string, file: Readable, info: busboy.FileInfo) => {
      const { filename, mimeType } = info;
      const fileId = nanoid();
      const abortController = new AbortController();

      file.on('limit', () => {
        if (hasResponded) {
          logger.warn(`[${INSTANCE_ID}] Post-process file size limit exceeded: ${filename} | Session: ${session_id}`);
          return;
        }
        hasResponded = true;
        logger.warn(`[${INSTANCE_ID}] File size limit exceeded: ${filename} | Session: ${session_id}`);
        abortController.abort();
        file.resume();
        res.status(413).json({ error: 'File size limit exceeded' });
      });

      const uploadPromise = new Promise<t.UploadResult>((resolve, reject) => {
        const uploadTimeout = setTimeout(() => {
          abortController.abort();
          file.resume();
          reject(new Error('Upload timeout'));
        }, UPLOAD_TIMEOUT_MS);

        let sessionKeyInput: SessionKeyInput;
        try {
          sessionKeyInput = parseUploadSessionKeyInput({
            kind: uploadKind,
            id: uploadId,
            version: uploadVersionRaw,
            authContextUserId: req.codeApiAuthContext?.userId ?? userId,
          });
        } catch (err) {
          clearTimeout(uploadTimeout);
          file.resume();
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        let sessionKey: string;
        try {
          sessionKey = resolveSessionKey(req, sessionKeyInput);
        } catch (err) {
          clearTimeout(uploadTimeout);
          file.resume();
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);
        logger.info(`[${INSTANCE_ID}] Upload: Session ID: ${session_id} | User ID: ${userId} | Session key: ${sessionKey}`);

        const putHeaders: Record<string, string> = {
          'Content-Type': mimeType,
          /* file-server URL-decodes this header before storing metadata.
           * Encoding here preserves `/` as `%2F` in transit and keeps
           * non-ASCII filenames legal as HTTP header values. */
          'X-Original-Filename': encodeURIComponent(filename),
        };
        if (readOnly) {
          putHeaders['X-Read-Only'] = 'true';
        }
        axios.put<t.UploadResult>(
          `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
          file,
          {
            headers: internalServiceHeaders(putHeaders),
            maxBodyLength: planFileSize,
            maxContentLength: planFileSize,
            signal: abortController.signal,
          }
        )
          .then(response => {
            clearTimeout(uploadTimeout);
            resolve(response.data);
          })
          .catch(error => {
            clearTimeout(uploadTimeout);
            reject(error);
          });
      });

      uploadPromises.push(uploadPromise);
    });

    bb.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process busboy error for session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Busboy error for session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing upload' });
    });

    bb.on('finish', async () => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process upload already responded for session ${session_id}`);
        void Promise.allSettled(uploadPromises);
        return;
      }
      hasResponded = true;
      try {
        const results = await Promise.all(uploadPromises);
        const response: t.UploadResponse = {
          message: 'success',
          storage_session_id: session_id,
          files: results,
        };
        res.status(200).json(response);
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error uploading files for session ${session_id}:`, error);
        if (!res.headersSent) {
          if (error instanceof Error) {
            if (error.message === 'Upload timeout') {
              res.status(504).json({ error: 'Upload timeout' });
            } else {
              res.status(500).json({ error: 'Error uploading files' });
            }
          } else {
            res.status(500).json({ error: 'Error uploading files' });
          }
        }
      }
    });

    req.pipe(bb);

    req.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process request error for session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Request error for session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing request' });
    });

  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Unexpected upload error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  }
});

router.post('/upload/batch', uploadLimiter, async (req: t.AuthenticatedRequest, res: Response) => {
  try {
    const userId = validateUploadRequest(req, res);
    if (userId == null) return;

    const session_id = nanoid();
    /* `kind`/`id`/`version?` form fields drive the batch's sessionKey
     * — the same shape as `/upload`. See `/upload` for the full
     * rationale. */
    let uploadKind: string | undefined;
    let uploadId: string | undefined;
    let uploadVersionRaw: string | undefined;
    let readOnly = false;
    let sessionKeySet = false;
    let hasResponded = false;
    let filesLimitReached = false;
    /* `SessionKeyResolutionError.status` spans 400 | 500 — 400 is a
     * client-input fault (per-file rejection is OK), 500 signals a
     * server misconfiguration (e.g. strict-mode tenantId gap) where
     * masking the failure as a per-file error string would hide an
     * operational breakage behind a 200/400 response. Latch the first
     * 500 we see and convert it into a single 500 batch response on
     * `bb.on('finish')`. */
    let serverError: SessionKeyResolutionError | undefined;

    const planFileSize = planLimits[req.planId ?? '']?.max_file_size ?? planLimits.default.max_file_size;
    /* See note on the single-upload busboy above for why preservePath is set. */
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: planFileSize, files: MAX_BATCH_FILES },
      preservePath: true,
    });

    const uploadPromises: Promise<t.BatchUploadFileResult>[] = [];

    bb.on('field', (fieldname: string, val: string) => {
      if (fieldname === 'kind') {
        uploadKind = val;
      } else if (fieldname === 'id') {
        uploadId = val;
      } else if (fieldname === 'version') {
        uploadVersionRaw = val;
      } else if (fieldname === 'read_only') {
        /* See `/upload` for semantics. The flag applies to every file in
         * this batch — sized for skill priming where all files share the
         * same read-only intent. */
        readOnly = val.toLowerCase() === 'true';
      }
    });

    bb.on('filesLimit', () => {
      filesLimitReached = true;
      logger.warn(`[${INSTANCE_ID}] Batch upload files limit reached (${MAX_BATCH_FILES}) for session ${session_id}`);
    });

    bb.on('file', (_fieldname: string, file: Readable, info: busboy.FileInfo) => {
      const { filename, mimeType } = info;
      const fileId = nanoid();
      const abortController = new AbortController();

      file.on('limit', () => {
        logger.warn(`[${INSTANCE_ID}] Batch upload file size limit exceeded: ${filename} | Session: ${session_id}`);
        abortController.abort('size_limit');
        file.resume();
      });

      const uploadPromise = new Promise<t.BatchUploadFileResult>((resolve) => {
        /** If abort('size_limit') fires first, its microtask-queued .catch resolves the promise and clears this timeout before it can fire. */
        const uploadTimeout = setTimeout(() => {
          abortController.abort('timeout');
          file.resume();
          resolve({ status: 'error', filename, error: 'Upload timeout' });
        }, UPLOAD_TIMEOUT_MS);

        let sessionKeyInput: SessionKeyInput;
        try {
          sessionKeyInput = parseUploadSessionKeyInput({
            kind: uploadKind,
            id: uploadId,
            version: uploadVersionRaw,
            authContextUserId: req.codeApiAuthContext?.userId ?? userId,
          });
        } catch (err) {
          clearTimeout(uploadTimeout);
          file.resume();
          const message = err instanceof Error ? err.message : 'Invalid upload identity';
          resolve({ status: 'error', filename, error: message });
          return;
        }

        let sessionKey: string;
        try {
          sessionKey = resolveSessionKey(req, sessionKeyInput);
        } catch (err) {
          clearTimeout(uploadTimeout);
          file.resume();
          /* Latch 500-class errors so `bb.on('finish')` can surface
           * them as a single batch-level 500. Per-file degradation is
           * the right call for 400-class faults but masks server
           * misconfiguration. */
          if (err instanceof SessionKeyResolutionError && err.status === 500 && !serverError) {
            serverError = err;
          }
          const message = err instanceof Error ? err.message : 'Failed to resolve sessionKey';
          resolve({ status: 'error', filename, error: message });
          return;
        }
        if (!sessionKeySet) {
          connection.set(`session:${session_id}`, sessionKey, 'EX', env.SESSION_CACHE_TTL);
          sessionKeySet = true;
          logger.info(`[${INSTANCE_ID}] Batch upload: Session ID: ${session_id} | User ID: ${userId} | Session key: ${sessionKey}`);
        }

        const putHeaders: Record<string, string> = {
          'Content-Type': mimeType,
          /* file-server URL-decodes this header before storing metadata.
           * Encoding here preserves `/` as `%2F` in transit and keeps
           * non-ASCII filenames legal as HTTP header values. */
          'X-Original-Filename': encodeURIComponent(filename),
        };
        if (readOnly) {
          putHeaders['X-Read-Only'] = 'true';
        }
        axios.put<t.UploadResult>(
          `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
          file,
          {
            headers: internalServiceHeaders(putHeaders),
            maxBodyLength: planFileSize,
            maxContentLength: planFileSize,
            signal: abortController.signal,
          }
        )
          .then(response => {
            clearTimeout(uploadTimeout);
            resolve({ status: 'success', filename: response.data.filename, fileId: response.data.fileId });
          })
          .catch(error => {
            clearTimeout(uploadTimeout);
            if (abortController.signal.aborted) {
              const reason = abortController.signal.reason === 'timeout' ? 'Upload timeout' : 'File size limit exceeded';
              resolve({ status: 'error', filename, error: reason });
              return;
            }
            const message = error instanceof Error ? error.message : 'Unknown upload error';
            logger.error(`[${INSTANCE_ID}] Batch upload file failed: ${filename} | Session: ${session_id}`, { error: message });
            resolve({ status: 'error', filename, error: message });
          });
      });

      uploadPromises.push(uploadPromise);
    });

    bb.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process busboy error for batch session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Busboy error for batch session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing upload' });
    });

    bb.on('finish', async () => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process batch upload already responded for session ${session_id}`);
        return;
      }
      hasResponded = true;

      try {
        const results = await Promise.all(uploadPromises);

        /* If sessionKey resolution faulted with a 500 status (server
         * misconfiguration — see `serverError` declaration above),
         * surface the fault as a single batch-level 500 instead of
         * per-file errors. This avoids quietly returning 200 with
         * `partial_success` when a tenantId gap or similar makes
         * EVERY upload structurally impossible. */
        if (serverError) {
          logger.error(
            `[${INSTANCE_ID}] Batch upload faulted on sessionKey resolution: ${serverError.message}`,
            { session_id, files: results.length },
          );
          res.status(500).json({ error: serverError.message });
          return;
        }

        if (results.length === 0) {
          res.status(400).json({ error: 'No files provided' });
          return;
        }

        /* SessionKey was set inline in the per-file handler under
         * `sessionKeySet`. No batch-level fallback needed: if zero files
         * succeeded, no session was created. */

        let succeeded = 0;
        let failed = 0;
        for (const r of results) {
          if (r.status === 'success') succeeded++;
          else failed++;
        }

        let message: t.BatchUploadResponse['message'];
        if (failed === 0) message = 'success';
        else if (succeeded === 0) message = 'error';
        else message = 'partial_success';

        const statusCode = message === 'error' ? 400 : 200;
        const response: t.BatchUploadResponse = {
          message,
          storage_session_id: session_id,
          files: results,
          succeeded,
          failed,
          ...(filesLimitReached ? { filesLimitReached: true, maxFiles: MAX_BATCH_FILES } : {}),
        };
        res.status(statusCode).json(response);
      } catch (error) {
        logger.error(`[${INSTANCE_ID}] Error in batch upload finish for session ${session_id}:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error processing batch upload' });
        }
      }
    });

    req.pipe(bb);

    req.on('error', (error) => {
      if (hasResponded) {
        logger.warn(`[${INSTANCE_ID}] Post-process request error for batch session ${session_id}:`, error);
        return;
      }
      hasResponded = true;
      logger.error(`[${INSTANCE_ID}] Request error for batch session ${session_id}:`, error);
      res.status(500).json({ error: 'Error processing request' });
    });

  } catch (error) {
    logger.error(`[${INSTANCE_ID}] Unexpected batch upload error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  }
});

/** Best-effort extraction of the stored file_id from any file-list detail-level
 *  item (a bare `<session>/<id>.<ext>` string, `{ name }`, or `{ id }`). */
function objectFileIdFromListItem(item: unknown): string | undefined {
  if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
    return (item as { id: string }).id;
  }
  const name = typeof item === 'string'
    ? item
    : (item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined);
  if (typeof name !== 'string') return undefined;
  const base = name.split('/').filter(Boolean).pop() ?? name;
  return base.replace(/\.[^.]+$/, '');
}

/**
 * True when a route-param `:fileId` can refer to the hidden persistent-session
 * snapshot. file-server's object GET/DELETE handlers resolve `:fileId` by
 * PREFIX match against `<session>/<fileId>` (see file-server.ts), so it is not
 * enough to block the bare id and the extension-qualified form: ANY strict
 * prefix (`codeapi-session-stat`, `codeapi-s`, ...) also resolves to the
 * stored `codeapi-session-state.tar` object there. Reject every prefix of the
 * stored name, plus any `<id>.<ext>` spelling (mirroring
 * `objectFileIdFromListItem` above). Over-blocking is harmless: real object
 * ids are full-length nanoids, which can never be a strict prefix of the
 * 21-char reserved id, and an exact-length collision is blocked by design.
 */
function isSessionStateFileId(fileId: string): boolean {
  if (fileId.length === 0) return false;
  return (
    `${SESSION_STATE_FILE_ID}.tar`.startsWith(fileId) ||
    fileId.replace(/\.[^.]+$/, '') === SESSION_STATE_FILE_ID
  );
}

router.get('/files/:session_id', fetchLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id } = req.params;
  const { detail = 'simple' } = req.query;

  try {
    const response = await axios.get(`${env.FILE_SERVER_URL}/sessions/${session_id}/objects`, {
      params: { detail },
      headers: internalServiceHeaders({ 'Accept': 'application/json' })
    });

    // Hide the hidden persistent-session snapshot object: it lives in the same
    // output session as user artifacts but is internal state, not a downloadable
    // file. (No-op unless persistence is enabled.)
    const data = Array.isArray(response.data)
      ? response.data.filter(item => objectFileIdFromListItem(item) !== SESSION_STATE_FILE_ID)
      : response.data;
    return res.status(200).json(data);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Error fetching file info for session ${session_id}:`, errorDetails);
    return res.status(500).json({
      error: 'Error fetching file information',
    });
  }
});

/**
 * Single-file metadata lookup for caller-side freshness checks.
 * LibreChat's `primeSkillFiles` reads `lastModified` from this response
 * to decide whether a previously-uploaded skill bundle is still alive
 * in the sandbox or needs to be re-uploaded. Without this route on the
 * public service-api, that freshness GET 404s and every priming call
 * falls through to a fresh upload (massive egress at scale).
 *
 * Proxies the file-server's `/metadata` variant — which returns
 * `{ lastModified, size, etag, ... }` from `minioClient.statObject` —
 * authenticated by `sessionAuth` so the requester must own the
 * `(session_id, entity_id)` pair the file was stored under.
 */
router.get('/sessions/:session_id/objects/:fileId', fetchLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  if (isSessionStateFileId(fileId)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const response = await axios.get(
      `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}/metadata`,
      { headers: internalServiceHeaders({ Accept: 'application/json' }) },
    );

    return res.status(200).json(response.data);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return res.status(404).json({ error: 'File not found' });
    }
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(
      `[${INSTANCE_ID}] Error fetching object metadata - Session ID: ${session_id} | File ID: ${fileId}:`,
      errorDetails,
    );
    return res.status(500).json({ error: 'Error fetching object metadata' });
  }
});

router.delete('/files/:session_id/:fileId', fetchLimiter, sessionAuth, async (req: t.AuthenticatedRequest, res: Response) => {
  const { session_id, fileId } = req.params;

  // The hidden snapshot object is not client-addressable.
  if (isSessionStateFileId(fileId)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const response = await axios.delete(
      `${env.FILE_SERVER_URL}/sessions/${session_id}/objects/${fileId}`,
      { headers: internalServiceHeaders() }
    );

    await connection.del(`upload:${req.sessionKey}${session_id}${fileId}`);
    logger.info(`[${INSTANCE_ID}] File deleted: Session ID: ${session_id} | File ID: ${fileId}`);
    return res.status(200).json(response.data);
  } catch (error) {
    const errorDetails = getAxiosErrorDetails(error);
    logger.error(`[${INSTANCE_ID}] Error deleting file - Session ID: ${session_id} | File ID: ${fileId}:`, errorDetails);
    return res.status(500).json({
      error: 'Error deleting file',
    });
  }
});

export default router;
