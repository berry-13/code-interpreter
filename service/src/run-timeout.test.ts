import { describe, expect, test } from 'bun:test';
import { resolveRequestedRunTimeout, resolveTimeoutLadder, firstSetEnv, env } from './config';

const MAX = 300_000;

describe('resolveRequestedRunTimeout', () => {
  test('absent stays absent; the router substitutes MAX_RUN_TIMEOUT', () => {
    expect(resolveRequestedRunTimeout(undefined, MAX)).toBeUndefined();
  });

  test('accepts a positive integer below the ceiling', () => {
    expect(resolveRequestedRunTimeout(3000, MAX)).toBe(3000);
    expect(resolveRequestedRunTimeout(1, MAX)).toBe(1);
    expect(resolveRequestedRunTimeout(MAX, MAX)).toBe(MAX);
  });

  test('clamps down to the ceiling, never up', () => {
    expect(resolveRequestedRunTimeout(MAX + 1, MAX)).toBe(MAX);
    expect(resolveRequestedRunTimeout(86_400_000, MAX)).toBe(MAX);
  });

  test('rejects malformed values instead of silently ignoring them', () => {
    // An explicit JSON null is malformed, NOT omitted: treating it as absent
    // would hand a client that serializes an unset timeout as null the longest
    // run the deployment allows, silently.
    for (const bad of [null, 0, -1, 1.5, NaN, Infinity, -Infinity, '3000', true, {}, []]) {
      expect(resolveRequestedRunTimeout(bad, MAX)).toBeNull();
    }
  });
});

describe('firstSetEnv', () => {
  // Compose passes every optional variable as ${VAR:-}, so "unset" arrives as
  // an empty string. `??` accepts that and never reads the fallback, which is
  // how a knob can look wired up and do nothing in the very deployments it
  // ships in: JOB_PRIME_ALLOWANCE_MS shadowing
  // CODEAPI_DEPENDENCY_INSTALL_TIMEOUT_MS was exactly that.
  test('skips blank and unset values', () => {
    expect(firstSetEnv('', '600000')).toBe('600000');
    expect(firstSetEnv('   ', '600000')).toBe('600000');
    expect(firstSetEnv(undefined, '600000')).toBe('600000');
    expect(firstSetEnv('', undefined)).toBeUndefined();
  });

  test('an explicitly set value still wins', () => {
    expect(firstSetEnv('120000', '600000')).toBe('120000');
  });
});

describe('timeout ladder', () => {
  /* Each layer must outlive the one it waits on, or a timed-out run's
   * structured result loses the race and the caller gets a generic 500. */
  const LADDER = {
    jobTimeoutMs: 300_000,
    compileAllowanceMs: 30_000,
    primeAllowanceMs: 120_000,
    postProcessAllowanceMs: 60_000,
    gatewayAllowanceMs: 60_000,
    graceMs: 15_000,
  };

  test('the shipped configuration is ordered', () => {
    expect(env.MAX_RUN_TIMEOUT).toBeLessThanOrEqual(env.JOB_TIMEOUT);
    expect(env.SANDBOX_CALL_TIMEOUT).toBeGreaterThan(env.JOB_TIMEOUT);
    expect(env.JOB_WAIT_TIMEOUT).toBeGreaterThan(env.SANDBOX_CALL_TIMEOUT);
  });

  test('the worker budget covers every phase the sandbox spends in one call', () => {
    // The sandbox spends these sequentially and only answers at the end: a pip
    // install during prime(), a java compile, the run, then the output-file
    // uploads -- and in hardened mode the worker also brackets the call with
    // two gateway round trips. A budget covering only the run would abort
    // before the sandbox could hand back its structured TO result.
    const { sandboxCallTimeoutMs } = resolveTimeoutLadder(LADDER);
    expect(sandboxCallTimeoutMs).toBeGreaterThan(
      LADDER.jobTimeoutMs
      + LADDER.compileAllowanceMs
      + LADDER.primeAllowanceMs
      + LADDER.postProcessAllowanceMs
      + LADDER.gatewayAllowanceMs,
    );
  });

  test('the replay-state TTL outlives the request wait', () => {
    // exec_state and its tool_history hash must survive a continuation blocked
    // on its job: if they expire mid-execution the completion path recreates
    // exec_state but not the history, and a later replay re-emits tool calls
    // that were already resolved.
    const { jobWaitTimeoutMs } = resolveTimeoutLadder({ ...LADDER, primeAllowanceMs: 600_000 });
    const ttlSeconds = Math.max(600, Math.ceil(jobWaitTimeoutMs / 1000) + 60);
    expect(ttlSeconds).toBeGreaterThan(Math.ceil(jobWaitTimeoutMs / 1000));
  });

  test('the snapshot-ref margin survives the longest legitimate hold', () => {
    // The ref key must outlive (request wait + the finally block's extra wait),
    // or a long-queued run's ref expires while still outstanding and a later
    // run can delete the snapshot it was about to restore.
    const { jobWaitTimeoutMs } = resolveTimeoutLadder(LADDER);
    const refTtlSeconds = Math.ceil(jobWaitTimeoutMs / 1000) + 60;
    const keyTtlSeconds = 2 * refTtlSeconds;
    const longestHoldSeconds = Math.ceil(jobWaitTimeoutMs / 1000) + refTtlSeconds;
    expect(keyTtlSeconds).toBeGreaterThan(longestHoldSeconds);
  });

  test('an over-configured MAX_RUN_TIMEOUT is clamped to the job budget', () => {
    // Accepting 600s of run budget under a shorter wait would reintroduce exactly
    // the 500-instead-of-TO failure the ladder exists to prevent.
    const { maxRunTimeoutMs, jobWaitTimeoutMs } = resolveTimeoutLadder({
      ...LADDER,
      maxRunTimeoutRaw: '600000',
    });
    expect(maxRunTimeoutMs).toBe(300_000);
    expect(maxRunTimeoutMs).toBeLessThan(jobWaitTimeoutMs);
  });

  test('a lower MAX_RUN_TIMEOUT is honored as configured', () => {
    expect(resolveTimeoutLadder({ ...LADDER, maxRunTimeoutRaw: '5000' }).maxRunTimeoutMs).toBe(5_000);
  });

  test('malformed MAX_RUN_TIMEOUT falls back to the job budget', () => {
    for (const bad of ['0', '-1', 'abc', '', undefined]) {
      expect(resolveTimeoutLadder({ ...LADDER, maxRunTimeoutRaw: bad }).maxRunTimeoutMs).toBe(300_000);
    }
  });

  test('the ordering holds for the shipped helm values too', () => {
    // helm/codeapi/values.yaml: jobTimeout 25000, runTimeout 15000.
    const ladder = resolveTimeoutLadder({
      jobTimeoutMs: 25_000,
      compileAllowanceMs: 30_000,
      primeAllowanceMs: 120_000,
      postProcessAllowanceMs: 60_000,
      gatewayAllowanceMs: 60_000,
      graceMs: 15_000,
    });
    expect(ladder.maxRunTimeoutMs).toBe(25_000);
    expect(ladder.sandboxCallTimeoutMs).toBeGreaterThan(ladder.maxRunTimeoutMs);
    expect(ladder.jobWaitTimeoutMs).toBeGreaterThan(ladder.sandboxCallTimeoutMs);
  });
});
