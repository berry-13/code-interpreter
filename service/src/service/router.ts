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
 * when the key still holds the value this run restored from (`cur == ARGV[1]`)
 * OR when the key is absent (`cur == false`). Returns whether the swap happened,
 * so a run whose baseline was overtaken by a concurrent run doesn't roll the
 * pointer back to stale state.
 *
 * The `cur == false` arm covers two cases with one rule: a genuine first run
 * (expected `''`), AND a continuation whose pointer TTL lapsed mid-run -- e.g. a
 * run that started just before `SESSION_STATE_TTL_SECONDS` elapsed, or a TTL
 * misconfigured below the max job time. Absent that arm, the expired-pointer run
 * would treat its own fresh snapshot as stale and (with the finally block) delete
 * both snapshots, losing all persisted state for an active session. Advancing on
 * a missing key is safe: the pointer is only ever SET forward or TTL-expired,
 * never deleted, so `cur == false` means no live pointer exists to clobber, and
 * any concurrent run that already advanced makes `cur` a non-empty id that
 * matches neither arm -- so rollback is still prevented. */
const CAS_ADVANCE_SESSION_POINTER = `
local cur = redis.call('GET', KEYS[1])
if cur == false or cur == ARGV[1] then
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

/* Bound on both the snapshot ref key's own TTL and how long the `finally`
 * block below will keep waiting for a still-queued job before giving up and
 * releasing the ref anyway -- past max run time + a generous queue-wait
 * margin, so neither a crash nor a backed-up queue can hold a ref forever. */
const SNAPSHOT_REF_TTL_SECONDS = Math.ceil(env.JOB_TIMEOUT / 1000) + 60;

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
    if (env.PERSIST_SESSIONS) {
      // Reserve every persistence artifact name: the state tar (identified in
      // the sandbox by name only, since egress masks file id/session) and the
      // namespace snapshot `.session_state.pkl` (+ its tempfile). A user input
      // with any of these names would shadow restored state or be mistaken for
      // the injected snapshot.
      const reservedInput = (authorizedFiles ?? []).find(f => isReservedSessionInputName(f.name));
      if (reservedInput) {
        return res.status(400).json({ error: `File name '${reservedInput.name}' is reserved when persistent sessions are enabled` });
      }
      rawPayload.persist_session = {
        file_id: SESSION_STATE_FILE_ID,
        filename: SESSION_STATE_TAR_FILENAME,
      };
      priorSnapshotSession = await connection.get(sessionStatePointerKey(sessionKey));
      if (priorSnapshotSession) {
        // Hold a ref on the snapshot this run will restore from, so a concurrent
        // run that supersedes the pointer can't delete it before we prime. TTL
        // bounds it past the max run + queue wait so a crash can't leak the ref.
        snapshotRefKey = `snapshotrefs:${priorSnapshotSession}`;
        await connection.multi()
          .incr(snapshotRefKey)
          .expire(snapshotRefKey, SNAPSHOT_REF_TTL_SECONDS)
          .exec()
          .catch(() => { /* best effort; delete path also guards on advance */ });
        rawPayload.persist_session.restore_session_id = priorSnapshotSession;
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
    } else if (env.PERSIST_SESSIONS && priorSnapshotSession) {
      // This run restored a prior snapshot but didn't write a fresh one (oversize
      // workspace, upload failure, etc.). The comment above promises an active
      // session's pointer never expires, but that's only true when a fresh
      // snapshot advances it -- a session that stays over cap for longer than
      // SESSION_STATE_TTL_SECONDS across consecutive skipped persists would
      // otherwise have its pointer lapse and lose the last good snapshot even
      // though it's still live. Refresh the TTL on the existing pointer instead.
      // Reusing the CAS advance script with `next == expected == priorSnapshotSession`
      // rewrites the same value (whether the key is still live or already
      // expired) without ever clobbering a pointer a concurrent run has since
      // advanced.
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
      const remaining = await connection.decr(snapshotRefKey).catch(() => 1);
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
  if (fileId === SESSION_STATE_FILE_ID) {
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

  if (fileId === SESSION_STATE_FILE_ID) {
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
  if (fileId === SESSION_STATE_FILE_ID) {
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
