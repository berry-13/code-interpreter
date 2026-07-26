import { describe, expect, test } from 'bun:test';
import { resolveRequestedRunTimeout, env } from './config';

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
  test('sandbox call budget sits above the job budget', () => {
    expect(env.SANDBOX_CALL_TIMEOUT).toBeGreaterThan(env.JOB_TIMEOUT);
  });

  test('request wait sits above the sandbox call budget', () => {
    expect(env.JOB_WAIT_TIMEOUT).toBeGreaterThan(env.SANDBOX_CALL_TIMEOUT);
  });

  test('the run-timeout ceiling never exceeds what the service will wait for', () => {
    expect(env.MAX_RUN_TIMEOUT).toBeLessThanOrEqual(env.JOB_WAIT_TIMEOUT);
  });
});
