import express, { type Request, type Response, type NextFunction } from 'express';
import type { Runtime } from '../runtime';
import type { TFile } from '../job';
import type { NsJailResult } from '../nsjail';
import { getLatestRuntimeMatchingLanguageVersion, getRuntimes } from '../runtime';
import { logger } from '../logger';
import { config } from '../config';
import { Job, ValidationError } from '../job';
import { EXECUTION_MANIFEST_HEADER, ExecutionManifestError, type ExecutionManifestClaims } from '../execution-manifest';
import { verifyExecuteRequestManifest } from '../execution-manifest-request';
import { EGRESS_GRANT_HEADER } from '../egress';
import { activeSandboxExecutions, recordSandboxExecution } from '../metrics';
import { classifySandboxSafeError } from '../safe-error';
import { withSpan } from '../telemetry';
import { checkSandboxWorkspaceHealth } from '../workspace-isolation';

const router = express.Router();
const SYNTHETIC_PRINCIPAL_SOURCE = 'synthetic_test';

export interface ExecuteRequestBody {
  /** Top-level execution session id (one sandbox `/exec` invocation).
   *  Intra-monorepo wire — service-api and sandbox ship together, so
   *  the rename is hard with no backward-compat alias. */
  session_id?: string;
  /** Output storage session id/handle used for generated file uploads. */
  output_session_id?: string;
  language: string;
  version: string;
  args?: string[];
  stdin?: string;
  files: TFile[];
  compile_memory_limit?: number;
  run_memory_limit?: number;
  run_timeout?: number;
  compile_timeout?: number;
  run_cpu_time?: number;
  compile_cpu_time?: number;
  env_vars?: Record<string, string>;
  egress_grant?: string;
  execution_manifest?: string;
  tool_call_socket?: boolean;
  /** Persistent-session marker (opt-in). When present, prime() restores a prior
   *  workspace tar found at `/mnt/data/<filename>` and, after the run, snapshots
   *  `/mnt/data` back to `output_session_id/<file_id>`. Covered by the manifest
   *  body hash like every other field. */
  persist_session?: { file_id: string; filename: string; restore_session_id?: string };
}

export const ENV_VAR_KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;
export const MAX_ENV_VAR_BYTES = 1_000_000;

export function sanitizeEnvVars(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    if (!ENV_VAR_KEY_RE.test(key)) continue;
    const entryBytes = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (totalBytes + entryBytes > MAX_ENV_VAR_BYTES) {
      throw new Error(`env_vars exceeds maximum total size of ${MAX_ENV_VAR_BYTES} bytes`);
    }
    totalBytes += entryBytes;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Service-worker sends large opaque capabilities in the JSON body because
 * skill-heavy executions can make encrypted grants/manifests exceed HTTP
 * header limits and fail with 431 before this route can validate them.
 * Header fallback keeps rolling upgrades compatible.
 */
export function tokenFromBodyOrHeader(
  body: ExecuteRequestBody,
  field: 'egress_grant' | 'execution_manifest',
  headerValue: string | undefined,
): string | undefined {
  const bodyValue = body[field];
  if (typeof bodyValue === 'string' && bodyValue !== '') return bodyValue;
  return headerValue;
}

export function authorizeToolCallSocket(
  body: Pick<ExecuteRequestBody, 'tool_call_socket'>,
  manifest: ExecutionManifestClaims | undefined,
  options: {
    nowSeconds?: number;
    legacyClaimGraceUntilSeconds?: number;
    allowUnsignedLocalToolCallSocket?: boolean;
  } = {},
): boolean {
  const requested = body.tool_call_socket === true;
  const manifestAllowsSocket = manifest?.tool_call_socket === true;
  const manifestHasBodyHash = typeof manifest?.execute_body_sha256 === 'string' && manifest.execute_body_sha256 !== '';

  if (requested) {
    if (options.allowUnsignedLocalToolCallSocket === true && manifest === undefined) {
      return true;
    }
    if (!manifestAllowsSocket || !manifestHasBodyHash) {
      throw new ExecutionManifestError(
        'scope_mismatch',
        'Tool-call socket access is not authorized by the execution manifest',
      );
    }
    return true;
  }

  if (manifestAllowsSocket) {
    if (!manifestHasBodyHash) {
      throw new ExecutionManifestError(
        'scope_mismatch',
        'Tool-call socket access requires a body-bound execution manifest',
      );
    }
    return true;
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    manifest?.tool_call_socket === undefined &&
    manifestHasBodyHash &&
    options.legacyClaimGraceUntilSeconds !== undefined &&
    nowSeconds < options.legacyClaimGraceUntilSeconds
  ) {
    return true;
  }

  return false;
}

function getJob(
  body: ExecuteRequestBody,
  egressGrantToken?: string,
  toolCallSocketEnabled = false,
  isSynthetic = false,
): Job {
  const {
    session_id, language, version, args, stdin, files,
    compile_memory_limit, run_memory_limit,
    run_timeout, compile_timeout,
    run_cpu_time, compile_cpu_time,
    env_vars,
  } = body;

  if (!language || typeof language !== 'string') {
    throw { message: 'language is required as a string' };
  }
  if (!version || typeof version !== 'string') {
    throw { message: 'version is required as a string' };
  }
  if (!files || !Array.isArray(files)) {
    throw { message: 'files is required as an array' };
  }
  if (body.tool_call_socket !== undefined && typeof body.tool_call_socket !== 'boolean') {
    throw { message: 'tool_call_socket must be a boolean if specified' };
  }
  if (body.persist_session !== undefined) {
    const ps = body.persist_session;
    if (
      typeof ps !== 'object' || ps === null ||
      typeof ps.file_id !== 'string' || ps.file_id.length === 0 ||
      typeof ps.filename !== 'string' || ps.filename.length === 0 ||
      (ps.restore_session_id !== undefined && typeof ps.restore_session_id !== 'string')
    ) {
      throw { message: 'persist_session must be { file_id, filename, restore_session_id? }' };
    }
  }
  for (const [i, file] of files.entries()) {
    if (typeof file.content !== 'string' && typeof file.id !== 'string') {
      throw { message: `files[${i}].content is required as a string if no id is provided` };
    }
  }

  const rt = getLatestRuntimeMatchingLanguageVersion(language, version);
  if (!rt) {
    throw { message: `${language}-${version} runtime is unknown` };
  }

  if (
    rt.language !== 'file' &&
    !files.some(file => !file.encoding || file.encoding === 'utf8')
  ) {
    throw { message: 'files must include at least one utf8 encoded file' };
  }

  validateConstraints(body, rt);

  // Rollout flag-skew guard: if the service injected the synthetic state file
  // but this sandbox has persistence disabled, the marker is dropped below, so
  // the file would otherwise be downloaded and echoed as an ordinary input.
  // Strip it here so a hidden state object can never leak to the caller.
  let effectiveFiles = files;
  if (body.persist_session && !config.persist_sessions) {
    effectiveFiles = files.filter(
      f => !(f.id && f.storage_session_id && f.name === body.persist_session!.filename),
    );
  }

  return new Job({
    session_id: session_id ?? null,
    runtime: rt,
    args: args ?? [],
    stdin: stdin ?? '',
    files: effectiveFiles,
    timeouts: {
      run: run_timeout ?? rt.timeouts.run,
      compile: compile_timeout ?? rt.timeouts.compile,
    },
    cpu_times: {
      run: run_cpu_time ?? rt.cpu_times.run,
      compile: compile_cpu_time ?? rt.cpu_times.compile,
    },
    memory_limits: {
      run: run_memory_limit ?? rt.memory_limits.run,
      compile: compile_memory_limit ?? rt.memory_limits.compile,
    },
    extra_env_vars: sanitizeEnvVars(env_vars),
    output_session_id: body.output_session_id,
    egress_grant: egressGrantToken,
    tool_call_socket_enabled: toolCallSocketEnabled,
    is_synthetic: isSynthetic,
    persist_session: config.persist_sessions ? body.persist_session : undefined,
  });
}

function validateConstraints(body: ExecuteRequestBody, rt: Runtime): void {
  const constraints = ['memory_limit', 'timeout', 'cpu_time'] as const;
  const types = ['compile', 'run'] as const;

  for (const constraint of constraints) {
    for (const type of types) {
      const key = `${type}_${constraint}` as keyof ExecuteRequestBody;
      const value = body[key];
      if (value === undefined || value === null) continue;

      if (typeof value !== 'number') {
        throw { message: `If specified, ${key} must be a number` };
      }

      const limitMap: Record<string, Record<string, number>> = {
        memory_limit: rt.memory_limits,
        timeout: rt.timeouts,
        cpu_time: rt.cpu_times,
      };

      const configured = limitMap[constraint]?.[type] ?? 0;
      if (configured <= 0) continue;
      if (value > configured) {
        throw { message: `${key} cannot exceed the configured limit of ${configured}` };
      }
      if (value < 0) {
        throw { message: `${key} must be non-negative` };
      }
    }
  }
}

/**
 * True when the run step ended via a signal (SIGKILL from a timeout, or any
 * other signal death) rather than a normal Python exit. The persisted-session
 * atexit snapshot only runs on normal interpreter shutdown (clean exit OR an
 * uncaught exception -- both still process atexit); a signal kill bypasses
 * it entirely, so `.session_state.pkl` on disk is stale (from the prior run,
 * not this one) even though ordinary file writes this run made before being
 * killed are not buffered and would still be captured by a persist.
 */
export function wasKilledBySignal(run: NsJailResult | undefined): boolean {
  // status 'SG' covers cgroup OOM kills that the nsjail log parser detects
  // without extracting an explicit signal (see nsjail.ts) -- the interpreter
  // died without running atexit either way. TO/OL/EL statuses already force
  // signal=SIGKILL in the parser, so the signal check covers those.
  return Boolean(run?.signal) || run?.status === 'SG';
}

function manifestErrorStatus(error: ExecutionManifestError): number {
  if (error.reason === 'missing_secret') return 500;
  if (error.reason === 'missing_header') return 401;
  if (error.reason === 'malformed') return 400;
  return 403;
}

router.use((req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.headers['content-type']?.startsWith('application/json')) {
    return res.status(415).json({ message: 'requests must be of type application/json' });
  }
  next();
});

/** Replay PTC payloads (user code + tool definitions + inlined
 * `_ptc_history.json` + pyplot assets) can far exceed Express's default
 * ~100kb body limit. The parser is installed *here* rather than globally
 * in `index.ts` because a global parser would run before this route and
 * its limit would be the effective cap (see the long comment in
 * `index.ts` for the routing-order rationale). Keep the limit configurable:
 * analyst workflows may send large scripts or replay payloads, while file
 * bytes should still move through the gateway/file path. */
router.post('/execute', express.json({ limit: config.execute_body_limit }), async (req: Request, res: Response) => {
  const started = performance.now();
  let job: Job | undefined;
  let cleanedUp = false;
  let activeExecution = false;
  let metricsLanguage = 'unknown';
  let metricsOutcome: Parameters<typeof recordSandboxExecution>[0]['outcome'] = 'execution_error';

  const cleanupHandler = async (): Promise<void> => {
    if (!job || cleanedUp) return;
    cleanedUp = true;
    await job.cleanup();
  };

  const markActiveExecution = (): void => {
    if (activeExecution) return;
    activeExecution = true;
    activeSandboxExecutions.inc();
  };

  /* Keep cleanup owned by the route `finally`. Request/response close events
   * can fire while NsJail is still running; releasing a per-job UID before
   * the child exits would let another job reuse that UID concurrently. */

  try {
    let verifiedManifest: ExecutionManifestClaims | undefined;
    let toolCallSocketEnabled = false;

    if (config.require_execution_manifest) {
      try {
        verifiedManifest = verifyExecuteRequestManifest({
          headerValue: tokenFromBodyOrHeader(req.body, 'execution_manifest', req.header(EXECUTION_MANIFEST_HEADER)),
          publicKey: config.execution_manifest_public_key,
          secret: config.execution_manifest_secret,
          body: req.body,
          bodyHashRequiredAfterSeconds: config.execution_manifest_body_hash_required_after_seconds,
        });
      } catch (error) {
        metricsOutcome = 'manifest_error';
        if (error instanceof ExecutionManifestError) {
          const status = manifestErrorStatus(error);
          logger.warn({ reason: error.reason, status }, 'Rejected sandbox request by execution manifest');
          return res.status(status).json({ message: error.message });
        }
        logger.error({ err: error }, 'Execution manifest validation failed unexpectedly');
        return res.status(500).json({ message: 'Execution manifest validation failed' });
      }
    }

    try {
      toolCallSocketEnabled = authorizeToolCallSocket(req.body, verifiedManifest, {
        legacyClaimGraceUntilSeconds: config.tool_call_socket_legacy_claim_grace_until_seconds,
        allowUnsignedLocalToolCallSocket: !config.hardened_sandbox_mode && !config.require_execution_manifest,
      });
    } catch (error) {
      metricsOutcome = 'manifest_error';
      if (error instanceof ExecutionManifestError) {
        const status = manifestErrorStatus(error);
        logger.warn({ reason: error.reason, status }, 'Rejected sandbox request by tool-call socket manifest scope');
        return res.status(status).json({ message: error.message });
      }
      throw error;
    }

    try {
      job = getJob(
        req.body,
        tokenFromBodyOrHeader(req.body, 'egress_grant', req.header(EGRESS_GRANT_HEADER) ?? undefined),
        toolCallSocketEnabled,
        verifiedManifest?.principal_source === SYNTHETIC_PRINCIPAL_SOURCE,
      );
      metricsLanguage = job.runtime.language;
      markActiveExecution();
    } catch (error) {
      metricsOutcome = 'bad_request';
      /** Validation paths in `getJob`/`sanitizeEnvVars` may throw either
       * plain `{ message }` objects (the historical shape used by the
       * inline validators above) or proper `Error` instances (used by
       * `sanitizeEnvVars` so callers get a real stack trace and can do
       * `instanceof Error` checks). `res.json(err)` for an `Error` would
       * serialize to `{}` because `message` is a non-enumerable property,
       * dropping the reason on the floor. Normalize both shapes to
       * `{ message }` so the client always sees why the request was
       * rejected. */
      const message = error instanceof Error
        ? error.message
        : (error as { message?: unknown })?.message;
      return res.status(400).json({ message: message || 'Bad request' });
    }

    try {
      await withSpan('codeapi.sandbox.prime', {
        'codeapi.language': job.runtime.language,
      }, () => job!.prime());
      const result = await withSpan('codeapi.sandbox.run', {
        'codeapi.language': job.runtime.language,
      }, () => job!.execute());

      if (result.run === undefined) {
        result.run = result.compile;
      }

      if (result.files && result.files.length > 0) {
        /* Upload returns the set of file IDs that were actually transferred to
         * the file server. Files we minted IDs for but failed to ship (e.g. the
         * EFAULT-from-Bun-fetch incident) are pruned from the response so they
         * never become phantom IDs that the next prime() will hammer with 404
         * retries before giving up. Inherited refs that were inlined from
         * autoLoadDirkeep / unchanged inputs have no `path` and are passed
         * through unchanged — they were never local to upload. */
        const uploaded = await withSpan('codeapi.sandbox.upload_generated_files', {
          'codeapi.language': job.runtime.language,
        }, () => job!.uploadGeneratedFiles())
          .catch((err) => {
            logger.error({ job: job!.uuid, err }, 'File upload failed');
            return new Set<string>();
          });

        const generatedIds = new Set(job.getGeneratedFileIds());
        const before = result.files.length;
        const failedUploads = result.files.filter(
          f => generatedIds.has(f.id) && !uploaded.has(f.id),
        );
        result.files = result.files.filter(
          f => !generatedIds.has(f.id) || uploaded.has(f.id),
        );
        const dropped = before - result.files.length;
        if (dropped > 0) {
          logger.warn(
            { job: job.uuid, dropped, kept: result.files.length },
            'Pruned files from response because upload did not reach file_server',
          );
          /* Persistent sessions: a file pruned from the response must not
           * ride the snapshot either. Restored next run, it would be
           * baselined as an unchanged carry-over and suppressed from every
           * later response -- an artifact sitting in /mnt/data that never
           * got (and never will get) a downloadable ref. Excluding just the
           * failed files keeps the snapshot consistent with what the caller
           * was told, without discarding the run's other state (variables,
           * modified files) over a transient upload blip. */
          job.excludeFromSessionSnapshot(failedUploads.map(f => f.name));
        }
      }

      /* Persistent sessions: snapshot the workspace (files + dill namespace)
       * back to the current output session. No-op unless a persist_session
       * marker is set; always non-fatal. The service advances the
       * `sessionstate:<sessionKey>` Redis pointer only when this returns true.
       *
       * Skip entirely when the run was killed by a signal (timeout -> SIGKILL,
       * or any other signal death): the Python wrapper's snapshot runs from
       * `atexit`, which a signal kill never reaches, so `.session_state.pkl`
       * on disk is whatever the LAST successful run left there -- stale, not
       * this run's -- while ordinary file writes this run made before being
       * killed (including a mid-write, truncated file) are NOT buffered and
       * WOULD still land in the tar. Persisting that mix would advance the
       * session pointer to a torn snapshot: files reflecting the killed run,
       * variables reflecting the run before it. Leaving the pointer on the
       * last good snapshot (as any other skipped persist already does) is
       * safer than manufacturing a snapshot no single run ever produced. A
       * plain nonzero exit (an uncaught exception, or the user's own
       * `sys.exit(n)`) still runs atexit normally and is not skipped here.
       * Exits that bypass atexit WITHOUT a signal -- os._exit(0), os.exec*
       * -- can't be told apart from a clean exit here; persistSessionState
       * itself catches those by fingerprinting the restored pickle and
       * skipping when this run never rewrote it.
       *
       * The compile phase gets the same treatment: a compile killed by
       * signal (timeout) leaves `result.run` undefined, so checking only the
       * run phase would fall through and persist a workspace holding partial
       * compiler outputs from a run that never executed. */
      if (wasKilledBySignal(result.compile) || wasKilledBySignal(result.run)) {
        result.session_state_persisted = false;
      } else {
        result.session_state_persisted = await withSpan('codeapi.sandbox.persist_session', {
          'codeapi.language': job.runtime.language,
        }, () => job!.persistSessionState())
          .catch((err) => {
            logger.error({ job: job!.uuid, err }, 'Session persist failed');
            return false;
          });
      }
      /* Tell the service when the prior snapshot could not be restored, so
       * its pointer-TTL refresh (which otherwise fires on every skipped
       * persist) doesn't pin a dead/corrupt snapshot alive forever. */
      if (job.sessionRestoreDidFail()) {
        result.session_state_restore_failed = true;
      }
      /* Rollout flag-skew: the service expected a restore (persist_session
       * with a restore marker) but THIS runner has persistence disabled, so
       * getJob stripped the marker and nothing was restored or persisted.
       * Without this, the response carries neither session_state flag, and
       * the service's skipped-persist branch would refresh the old pointer
       * as if the restore succeeded -- keeping stale state alive while this
       * run executed cold and its changes are silently dropped from the
       * session. Reporting it as a failed restore skips that refresh; if the
       * skew persists, the failure streak eventually releases the pointer,
       * which is the intended pressure valve during a misrollout. */
      const requestedPersist = (req.body as { persist_session?: { restore_session_id?: string } })?.persist_session;
      if (!config.persist_sessions && requestedPersist?.restore_session_id) {
        result.session_state_restore_failed = true;
      }

      metricsOutcome = 'success';
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof ValidationError) {
        metricsOutcome = 'validation_error';
        return res.status(400).json({ message: error.message });
      }
      const safeError = classifySandboxSafeError(error);
      if (safeError) {
        metricsOutcome = 'execution_error';
        logger.error({ job: job?.uuid, err: error, safeError: safeError.body.error }, 'Sandbox setup failed');
        return res.status(safeError.status).json(safeError.body);
      }
      metricsOutcome = 'execution_error';
      logger.error({ job: job?.uuid, err: error }, 'Error executing job');
      return res.status(500).json({
        error: 'sandbox_execution_failed',
        message: 'Sandbox execution failed',
      });
    } finally {
      await cleanupHandler();
    }
  } finally {
    if (activeExecution) {
      activeSandboxExecutions.dec();
    }
    recordSandboxExecution({
      language: metricsLanguage,
      outcome: metricsOutcome,
      durationSeconds: (performance.now() - started) / 1000,
    });
  }
});

router.get('/health', async (_req: Request, res: Response) => {
  try {
    return res.status(200).json(await checkSandboxWorkspaceHealth());
  } catch (error) {
    logger.error({ err: error }, 'Sandbox workspace health check failed');
    return res.status(503).json({
      status: 'unhealthy',
      error: 'workspace_unavailable',
      message: 'Sandbox workspace root is unavailable',
    });
  }
});

router.get('/runtimes', (_req: Request, res: Response) => {
  const runtimes = getRuntimes().map(rt => ({
    language: rt.language,
    version: rt.version.raw,
    aliases: rt.aliases,
    runtime: rt.runtime,
  }));
  return res.status(200).json(runtimes);
});

export default router;
