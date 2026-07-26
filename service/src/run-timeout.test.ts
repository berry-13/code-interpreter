import { describe, expect, test } from 'bun:test';
import { resolveRequestedRunTimeout, resolveTimeoutLadder, env } from './config';

const MAX = 300_000;

describe('resolveRequestedRunTimeout', () => {
  test('absent stays absent, so the sandbox applies its own default', () => {
    expect(resolveRequestedRunTimeout(undefined, MAX)).toBeUndefined();
    expect(resolveRequestedRunTimeout(null, MAX)).toBeUndefined();
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
    for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, '3000', true, {}, []]) {
      expect(resolveRequestedRunTimeout(bad, MAX)).toBeNull();
    }
  });
});

describe('timeout ladder', () => {
  /* Each layer must outlive the one it waits on, or a timed-out run's
   * structured result loses the race and the caller gets a generic 500. */
  const LADDER = { jobTimeoutMs: 300_000, compileAllowanceMs: 30_000, graceMs: 15_000 };

  test('the shipped configuration is ordered', () => {
    expect(env.MAX_RUN_TIMEOUT).toBeLessThanOrEqual(env.JOB_TIMEOUT);
    expect(env.SANDBOX_CALL_TIMEOUT).toBeGreaterThan(env.JOB_TIMEOUT);
    expect(env.JOB_WAIT_TIMEOUT).toBeGreaterThan(env.SANDBOX_CALL_TIMEOUT);
  });

  test('the worker budget covers the full compile-plus-run path', () => {
    // A java job compiles for up to compile_timeout and THEN runs to its own
    // deadline; a worker budget that only covered the run would abort before
    // the sandbox could hand back its structured TO result.
    const { sandboxCallTimeoutMs } = resolveTimeoutLadder(LADDER);
    expect(sandboxCallTimeoutMs).toBeGreaterThan(
      LADDER.jobTimeoutMs + LADDER.compileAllowanceMs,
    );
  });

  test('an over-configured MAX_RUN_TIMEOUT is clamped to the job budget', () => {
    // Accepting 600s of run budget under a 345s wait would reintroduce exactly
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
    const ladder = resolveTimeoutLadder({ jobTimeoutMs: 25_000, compileAllowanceMs: 30_000, graceMs: 15_000 });
    expect(ladder.maxRunTimeoutMs).toBe(25_000);
    expect(ladder.sandboxCallTimeoutMs).toBeGreaterThan(ladder.maxRunTimeoutMs);
    expect(ladder.jobWaitTimeoutMs).toBeGreaterThan(ladder.sandboxCallTimeoutMs);
  });
});
