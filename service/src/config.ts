import * as dotenv from 'dotenv';
dotenv.config();
import { nanoid } from 'nanoid';
import type * as t from './types';
import { Languages } from './enum';

export const languageConfig: Record<Languages | string, t.LanguageConfig | undefined> = {
  [Languages.bash]: { language: 'bash', version: '5.2.0', fileName: 'script.sh' },
  [Languages.java]: { language: 'java', version: '21.0.11', fileName: 'Main.java' },
  [Languages.js]: { language: 'bun-js', version: '1.3.14', fileName: 'index.js' },
  [Languages.node]: { language: 'node', version: '24.15.0', fileName: 'index.js' },
  [Languages.py]: { language: 'python', version: '3.14.4', fileName: 'main.py' },
  [Languages.ts]: { language: 'bun-ts', version: '1.3.14', fileName: 'main.ts' },
};

const languageAliases: Record<string, Languages> = {
  // Python
  python: Languages.py,
  py: Languages.py,

  // JavaScript (Bun)
  javascript: Languages.js,
  js: Languages.js,
  'bun-js': Languages.js,
  bun: Languages.js,

  // JavaScript (Node.js)
  node: Languages.node,
  nodejs: Languages.node,
  'node-js': Languages.node,
  'node-javascript': Languages.node,

  // TypeScript (Bun)
  typescript: Languages.ts,
  ts: Languages.ts,
  'bun-ts': Languages.ts,
  'bun-typescript': Languages.ts,

  // Bash
  bash: Languages.bash,
  sh: Languages.bash,

  // Java (Temurin JDK)
  java: Languages.java,
  jdk: Languages.java,
  openjdk: Languages.java,
};

export function resolveLanguage(lang: string): Languages | undefined {
  return languageAliases[lang.toLowerCase()];
}

const defaultJobTimeoutMs = Number(process.env.JOB_TIMEOUT) || 300000;
const defaultMaxFileSize = Number(process.env.MAX_FILE_SIZE) || 25 * 1024 * 1024;
const defaultExecutionManifestTtlSeconds = Math.min(Math.ceil((defaultJobTimeoutMs + 60000) / 1000), 600);
const EGRESS_GRANT_GRACE_MS = 10 * 60 * 1000;

/** Parse an env var as a positive integer, falling back on anything
 *  fractional, negative, zero, non-finite, or unset. */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/* Timeout ladder. Each layer must outlive the layer it waits on, otherwise the
 * inner layer's structured result loses the race with the outer layer's
 * give-up and the caller gets a generic `Internal server error` instead of the
 * sandbox's timeout result (`code: 137, signal: SIGKILL, status: "TO"`):
 *
 *   run budget           <= MAX_RUN_TIMEOUT (itself <= JOB_TIMEOUT)
 *   < worker's abort     prime + compile + JOB_TIMEOUT + 1 grace  (SANDBOX_CALL_TIMEOUT)
 *   < service's wait     prime + compile + JOB_TIMEOUT + 2 grace  (JOB_WAIT_TIMEOUT)
 *
 * Before this, all three sat at 300000: a runaway program's SIGKILL result was
 * produced at the same instant every layer above it gave up. The graces only
 * extend how long each layer waits for a result already on its way; they never
 * extend how long user code may run, which the sandbox alone decides.
 *
 * The ladder covers one job's time INSIDE a worker. Queue delay sits outside
 * it: the service's wait starts at enqueue, the worker's abort only once a
 * worker picks the job up, so on a backed-up queue the outer wait can still
 * expire first. That case is reported distinctly (see the handler's queue-delay
 * branch), not dressed up as an execution failure.
 *
 * The terms, in the order the sandbox spends them:
 *  - prime: input downloads, workspace restore, and -- when dynamic
 *    dependencies are enabled -- a pip install bounded by
 *    CODEAPI_DEPENDENCY_INSTALL_TIMEOUT_MS, all BEFORE compile starts.
 *  - compile: SANDBOX_COMPILE_TIMEOUT, spent before the run for java.
 *  - run: the run budget itself.
 * Job.execute() spends them sequentially, so the worker has to cover the sum.
 * These are the RUNNER's variables: set them here too if you raise them there,
 * or this layer under-provisions by the difference. */
const JOB_WAIT_GRACE_MS = positiveIntEnv(process.env.JOB_WAIT_GRACE_MS, 15_000);
const COMPILE_ALLOWANCE_MS = positiveIntEnv(process.env.SANDBOX_COMPILE_TIMEOUT, 30_000);
const PRIME_ALLOWANCE_MS = positiveIntEnv(
  process.env.JOB_PRIME_ALLOWANCE_MS ?? process.env.CODEAPI_DEPENDENCY_INSTALL_TIMEOUT_MS,
  120_000,
);

/** Build the timeout ladder from its inputs, enforcing the ordering above.
 *
 *  `maxRun` is clamped to the job budget rather than trusted: an operator who
 *  sets MAX_RUN_TIMEOUT above JOB_TIMEOUT would otherwise get requests accepted
 *  with a run budget that outlives the very waits meant to observe it -- the
 *  exact 500-instead-of-`TO` failure this ladder exists to prevent. Raising
 *  JOB_TIMEOUT is how you buy longer runs; the rest follows from it. */
export function resolveTimeoutLadder(args: {
  jobTimeoutMs: number;
  compileAllowanceMs: number;
  primeAllowanceMs: number;
  graceMs: number;
  maxRunTimeoutRaw?: string;
}): { maxRunTimeoutMs: number; sandboxCallTimeoutMs: number; jobWaitTimeoutMs: number } {
  const { jobTimeoutMs, compileAllowanceMs, primeAllowanceMs, graceMs, maxRunTimeoutRaw } = args;
  const sandboxCallTimeoutMs = jobTimeoutMs + compileAllowanceMs + primeAllowanceMs + graceMs;
  return {
    maxRunTimeoutMs: Math.min(positiveIntEnv(maxRunTimeoutRaw, jobTimeoutMs), jobTimeoutMs),
    sandboxCallTimeoutMs,
    jobWaitTimeoutMs: sandboxCallTimeoutMs + graceMs,
  };
}

const timeoutLadder = resolveTimeoutLadder({
  jobTimeoutMs: defaultJobTimeoutMs,
  compileAllowanceMs: COMPILE_ALLOWANCE_MS,
  primeAllowanceMs: PRIME_ALLOWANCE_MS,
  graceMs: JOB_WAIT_GRACE_MS,
  maxRunTimeoutRaw: process.env.MAX_RUN_TIMEOUT,
});

/** Resolve a caller-supplied `run_timeout` (ms) against the server ceiling.
 *
 *  Returns `undefined` when absent (the router substitutes MAX_RUN_TIMEOUT, so
 *  every job carries an explicit budget), `null` when present but malformed --
 *  callers surface that as a 400 rather than silently ignoring it, which is the
 *  behavior this replaces -- and otherwise the value clamped down to `maxMs`.
 *  Clamping is one-directional
 *  BY DESIGN: a request may only narrow the operator's ceiling, never raise it,
 *  so a client cannot buy itself a longer hold on a sandbox slot than the
 *  deployment allows. */
export function resolveRequestedRunTimeout(raw: unknown, maxMs: number): number | null | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return null;
  }
  return Math.min(raw, maxMs);
}

export function resolveEgressGrantTtlSeconds(rawTtlSeconds: string | undefined, jobTimeoutMs: number): number {
  const defaultTtlSeconds = Math.max(1, Math.ceil((jobTimeoutMs + EGRESS_GRANT_GRACE_MS) / 1000));
  if (rawTtlSeconds == null || rawTtlSeconds.trim() === '') {
    return defaultTtlSeconds;
  }

  const configuredTtlSeconds = Number(rawTtlSeconds);
  if (!Number.isFinite(configuredTtlSeconds) || configuredTtlSeconds <= 0) {
    return defaultTtlSeconds;
  }

  return Math.max(1, Math.ceil(configuredTtlSeconds));
}

export const env = {
  PORT: process.env.SERVICE_PORT ?? 3112,
  LOCAL_MODE: process.env.LOCAL_MODE === 'true',
  HARDENED_SANDBOX_MODE: process.env.CODEAPI_HARDENED_SANDBOX_MODE === 'true',
  INSTANCE_ID: process.env.INSTANCE_ID ?? nanoid(),
  HTTP_JSON_LIMIT: process.env.CODEAPI_HTTP_JSON_LIMIT ?? '50mb',
  SANDBOX_ENDPOINT: process.env.SANDBOX_ENDPOINT ?? 'http://localhost:2000/api/v2',
  EGRESS_GATEWAY_URL: process.env.EGRESS_GATEWAY_URL ?? '',
  FILE_SERVER_URL: process.env.FILE_SERVER_URL ?? 'http://localhost:3000',
  TOOL_CALL_SERVER_URL: process.env.TOOL_CALL_SERVER_URL ?? 'http://localhost:3033',
  EGRESS_GATEWAY_PORT: Number(process.env.EGRESS_GATEWAY_PORT) || 3190,
  EGRESS_GATEWAY_FILE_SERVER_URL: process.env.EGRESS_GATEWAY_FILE_SERVER_URL ?? process.env.FILE_SERVER_URL ?? 'http://localhost:3000',
  EGRESS_GATEWAY_TOOL_CALL_SERVER_URL: process.env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL ?? process.env.TOOL_CALL_SERVER_URL ?? 'http://localhost:3033',
  EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES: Number(process.env.EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES) || 1024 * 1024,
  EGRESS_GATEWAY_MAX_FILE_BYTES: Number(process.env.EGRESS_GATEWAY_MAX_FILE_BYTES ?? process.env.SANDBOX_MAX_FILE_SIZE) || 10_000_000,
  EGRESS_GATEWAY_MAX_PATH_LENGTH: Number(process.env.EGRESS_GATEWAY_MAX_PATH_LENGTH ?? process.env.SANDBOX_MAX_PATH_LENGTH) || 256,
  EGRESS_GATEWAY_MAX_NESTING_DEPTH: Number(process.env.EGRESS_GATEWAY_MAX_NESTING_DEPTH ?? process.env.SANDBOX_MAX_NESTING_DEPTH) || 10,
  EGRESS_GATEWAY_REQUEST_TIMEOUT_MS: Number(process.env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS) || 30_000,
  EGRESS_GATEWAY_REVOKE_TIMEOUT_MS: Number(process.env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS) || 5_000,
  EGRESS_LEDGER_REQUIRED: process.env.CODEAPI_EGRESS_LEDGER_REQUIRED === 'true' || process.env.CODEAPI_HARDENED_SANDBOX_MODE === 'true',
  EGRESS_LEDGER_TTL_GRACE_SECONDS: Number(process.env.CODEAPI_EGRESS_LEDGER_TTL_GRACE_SECONDS) || 300,
  EGRESS_GRANT_SECRET: process.env.CODEAPI_EGRESS_GRANT_SECRET ?? '',
  EGRESS_GRANT_TTL_SECONDS: resolveEgressGrantTtlSeconds(process.env.EGRESS_GRANT_TTL_SECONDS, defaultJobTimeoutMs),
  PYTHON_CONCURRENCY: Number(process.env.PYTHON_CONCURRENCY) || 1,
  OTHER_CONCURRENCY: Number(process.env.OTHER_CONCURRENCY) || 8,
  JOB_WINDOW: Number(process.env.JOB_WINDOW) || 1000,
  MAX_UPLOAD_CHECKS: Number(process.env.MAX_UPLOAD_CHECKS) || 14,
  MAX_UPLOAD_WAIT: Number(process.env.MAX_UPLOAD_WAIT) || 500,
  MAX_FILE_SIZE: defaultMaxFileSize,
  JOB_TIMEOUT: defaultJobTimeoutMs, // 5 minutes (increased for complex matplotlib rendering)
  /* Worker's budget for driving one job through the sandbox: the full
   * compile-plus-run path, one grace above what it waits on. See the ladder at
   * JOB_WAIT_GRACE_MS. */
  SANDBOX_CALL_TIMEOUT: timeoutLadder.sandboxCallTimeoutMs,
  /* How long a request waits for its job result: one grace above the worker,
   * so the worker's own outcome (including a timeout result) always arrives
   * first. See the ladder at JOB_WAIT_GRACE_MS. */
  JOB_WAIT_TIMEOUT: timeoutLadder.jobWaitTimeoutMs,
  /* Ceiling on a caller-supplied `run_timeout`, never above JOB_TIMEOUT: a run
   * budget that outlives the waits observing it defeats the ladder. The sandbox
   * clamps to its own SANDBOX_RUN_TIMEOUT on top of this. */
  MAX_RUN_TIMEOUT: timeoutLadder.maxRunTimeoutMs,
  // Execution Rate Limits
  EXEC_LIMIT_WINDOW: Number(process.env.RATE_LIMIT_WINDOW) || 30 * 1000, // 30 seconds
  EXEC_MAX_REQUESTS: Number(process.env.MAX_REQUESTS) || 20, // execution requests per window
  // Upload Rate Limits
  UPLOAD_LIMIT_WINDOW: Number(process.env.UPLOAD_LIMIT_WINDOW) || 5 * 60 * 1000, // 5 minutes
  UPLOAD_MAX_REQUESTS: Number(process.env.UPLOAD_MAX_REQUESTS) || 30, // 30 uploads per 5 minutes
  // Download Rate Limits
  DOWNLOAD_LIMIT_WINDOW: Number(process.env.DOWNLOAD_LIMIT_WINDOW) || 60 * 1000, // 1 minute
  DOWNLOAD_MAX_REQUESTS: Number(process.env.DOWNLOAD_MAX_REQUESTS) || 60, // 60 downloads per minute
  // Files List Rate Limits
  FETCH_LIMIT_WINDOW: Number(process.env.FETCH_LIMIT_WINDOW) || 60 * 1000, // 1 minute
  FETCH_MAX_REQUESTS: Number(process.env.FETCH_MAX_REQUESTS) || 120, // 120 requests per minute
  // Redis Key Cache Config
  SESSION_CACHE_TTL: Number(process.env.SESSION_CACHE_TTL) || 86400,
  /* Persistent sessions (opt-in, OFF by default). When enabled, each run's
   * /mnt/data workspace (including a dill-serialized Python namespace) is
   * snapshotted to object storage under the caller's own sessionKey and
   * restored on the next run — so variables and files carry across calls with
   * no client-side change. Keyed on the auth-derived, manifest-bound sessionKey
   * (never a client-supplied id). See service/src/preamble.ts (snapshot code)
   * and api/src/job.ts (workspace round-trip). */
  PERSIST_SESSIONS: process.env.CODEAPI_PERSIST_SESSIONS === 'true',
  // Cap on the persisted workspace tar; oversize snapshots are skipped (the run
  // still succeeds), so a runaway workspace can't balloon object storage.
  SESSION_STATE_MAX_BYTES: positiveIntEnv(process.env.CODEAPI_SESSION_STATE_MAX_BYTES, 104_857_600),
  // Idle expiry for the persisted state object. Refreshed on every run, so an
  // active session never expires; an abandoned one is collected after this.
  // Clamped to a positive integer: the value goes straight into Redis
  // SET ... EX / EXPIRE, which reject fractional/negative/non-finite expiries
  // -- a bad value would make every pointer advance/refresh fail and every
  // run start cold despite persistence being enabled.
  SESSION_STATE_TTL_SECONDS: positiveIntEnv(process.env.CODEAPI_SESSION_STATE_TTL_SECONDS, 604_800),
  /** Strict tenant isolation. When true, sessionKey resolution fails closed
   *  (500) on requests whose auth context lacks `tenantId`, instead of
   *  silently falling back to the `'legacy'` tenant prefix. Default OFF in
   *  code so single-tenant deploys without an auth tenancy concept keep
   *  working; multi-tenant deploys MUST set this to `true` before any tenant
   *  is multi-homed, otherwise a missing tenantId would silently bucket
   *  cross-tenant requests under the same `'legacy'` prefix. */
  TENANT_ISOLATION_STRICT: process.env.CODEAPI_TENANT_ISOLATION_STRICT === 'true',
  // Signed execution manifests. Prefer private/public key mode for split-runner
  // deployments so sandbox-runner receives only a verifier, not a signing secret.
  EXECUTION_MANIFEST_PRIVATE_KEY: process.env.CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY ?? '',
  EXECUTION_MANIFEST_PUBLIC_KEY: process.env.CODEAPI_EXECUTION_MANIFEST_PUBLIC_KEY ?? '',
  // Legacy HMAC fallback for non-split deployments. Do not mount into sandbox-runner.
  EXECUTION_MANIFEST_SECRET: process.env.CODEAPI_EXECUTION_MANIFEST_SECRET ?? '',
  EXECUTION_MANIFEST_TTL_SECONDS: Math.min(
    Number(process.env.EXECUTION_MANIFEST_TTL_SECONDS) || defaultExecutionManifestTtlSeconds,
    600,
  ),
  EXECUTION_MANIFEST_MAX_UPLOAD_BYTES: Number(process.env.EXECUTION_MANIFEST_MAX_UPLOAD_BYTES) || defaultMaxFileSize,
  EXECUTION_MANIFEST_MAX_OUTPUT_FILES: Number(process.env.EXECUTION_MANIFEST_MAX_OUTPUT_FILES) || 50,
  EXECUTION_MANIFEST_MAX_REQUESTS: Number(process.env.EXECUTION_MANIFEST_MAX_REQUESTS) || 1000,
  // Redis - Alternative DNS Lookup for AWS ElastiCache TLS connections
  REDIS_USE_ALTERNATIVE_DNS_LOOKUP: process.env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP === 'true',
  /**
   * Programmatic Tool Calling execution model.
   * - `replay` (default): Temporal-style replay. Sandbox exits between round-trips;
   *   tool results are persisted in Redis and replayed into a fresh sandbox on each
   *   continuation until the code either completes or surfaces new tool calls.
   *   Safe to scale horizontally since all state lives in Redis.
   * - `blocking`: legacy path. Sandbox process stays alive across tool round-trips
   *   via a long-polling HTTP callback through the Tool Call Server. Retained as
   *   an explicit opt-in during rollout; scheduled for removal in a follow-up.
   */
  PTC_MODE: (process.env.PTC_MODE === 'blocking' ? 'blocking' : 'replay') as 'replay' | 'blocking',
  PTC_DEBUG: process.env.PTC_DEBUG === 'true',
};

const default_run_memory_limit = 256 * 1024 * 1024;

type PlanLimit = {
  run_memory_limit?: number;
  max_file_size?: number;
};

type PlanLimits = {
  default: Required<PlanLimit>;
} & {
  [key: string]: PlanLimit | undefined;
};

/**
 * The plan catalog is deployment config, not code: CODEAPI_PLAN_LIMITS is a
 * JSON object keyed by the `plan_id` JWT claim. Unknown or absent plan ids
 * fall back to the default tier, which is the only entry defined in code.
 */
export function parsePlanLimits(raw: string | undefined): Record<string, PlanLimit> {
  if (raw == null || raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CODEAPI_PLAN_LIMITS is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CODEAPI_PLAN_LIMITS must be a JSON object keyed by plan id');
  }
  return parsed as Record<string, PlanLimit>;
}

export const planLimits: PlanLimits = {
  ...parsePlanLimits(process.env.CODEAPI_PLAN_LIMITS),
  default: {
    run_memory_limit: Number(process.env.SANDBOX_RUN_MEMORY_LIMIT) || default_run_memory_limit,
    max_file_size: env.MAX_FILE_SIZE,
  },
};
