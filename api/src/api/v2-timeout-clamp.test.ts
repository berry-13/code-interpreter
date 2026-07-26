import { describe, expect, test } from 'bun:test';
import { clampTimeout } from './v2';

describe('clampTimeout', () => {
  test('falls back to the ceiling when unset', () => {
    expect(clampTimeout(undefined, 300_000)).toBe(300_000);
  });

  test('honors a request that narrows the ceiling', () => {
    expect(clampTimeout(3_000, 300_000)).toBe(3_000);
  });

  test('a request can never raise the ceiling', () => {
    expect(clampTimeout(900_000, 300_000)).toBe(300_000);
    expect(clampTimeout(Number.MAX_SAFE_INTEGER, 30_000)).toBe(30_000);
  });

  test('malformed values fall back to the ceiling, not to zero', () => {
    for (const bad of [0, -5, NaN, Infinity, '5000' as unknown as number]) {
      expect(clampTimeout(bad as number, 300_000)).toBe(300_000);
    }
  });
});
