import { describe, expect, test } from 'bun:test';
import { clampTimeout } from './v2';

describe('clampTimeout', () => {
  test('absent stays absent, so the caller substitutes the ceiling', () => {
    expect(clampTimeout(undefined, 300_000)).toBeUndefined();
  });

  test('honors a request that narrows the ceiling', () => {
    expect(clampTimeout(3_000, 300_000)).toBe(3_000);
  });

  test('a request can never raise the ceiling', () => {
    expect(clampTimeout(900_000, 300_000)).toBe(300_000);
    expect(clampTimeout(Number.MAX_SAFE_INTEGER, 30_000)).toBe(30_000);
  });

  test('clamps to the lower of two differing ceilings (helm defaults)', () => {
    // Service ceiling 25000 forwards 20000; this runner's ceiling is 15000.
    // Must cap, not reject: that is the case the clamp exists for.
    expect(clampTimeout(20_000, 15_000)).toBe(15_000);
  });

  test('a non-positive ceiling means no configured limit, so nothing is clamped', () => {
    // validateConstraints skips ceilings <= 0 as "unset". Clamping to one would
    // turn every request into a zero budget on a runtime that deliberately has
    // no limit, and buildArgs would floor that at its 1-second minimum.
    expect(clampTimeout(5_000, 0)).toBe(5_000);
    expect(clampTimeout(5_000, -1)).toBe(5_000);
  });

  test('values validateConstraints must still reject pass through unchanged', () => {
    // Replacing these with the ceiling would swallow the type error and the
    // negative-value error that validateConstraints is there to report.
    expect(clampTimeout('5000' as unknown as number, 300_000)).toBe('5000' as unknown as number);
    expect(clampTimeout(NaN, 300_000)).toBeNaN();
    expect(clampTimeout(-5, 300_000)).toBe(-5);
  });
});
