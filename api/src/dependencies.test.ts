import { describe, expect, test } from 'bun:test';
import { resolveDependencies, validatePipDependencies } from './dependencies';

const LIMITS = { maxCount: 5 };

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { message?: string }).message ?? String(e);
  }
  throw new Error('expected a throw');
}

describe('validatePipDependencies', () => {
  test('accepts pinned specs', () => {
    expect(validatePipDependencies(['numpy==2.1.0', 'six==1.16.0'], LIMITS)).toEqual([
      'numpy==2.1.0',
      'six==1.16.0',
    ]);
  });

  test('accepts hashed specs and trims', () => {
    const h = '--hash=sha256:' + 'a'.repeat(64);
    expect(validatePipDependencies([`  cowsay==6.1 ${h}  `], LIMITS)).toEqual([`cowsay==6.1 ${h}`]);
  });

  test('rejects unpinned / range specs', () => {
    expect(messageOf(() => validatePipDependencies(['numpy>=2.0'], LIMITS))).toMatch(/pinned/);
    expect(messageOf(() => validatePipDependencies(['numpy~=2.0'], LIMITS))).toMatch(/pinned|exact/);
    expect(messageOf(() => validatePipDependencies(['numpy'], LIMITS))).toMatch(/pinned/);
  });

  test('rejects option/injection attempts', () => {
    expect(messageOf(() => validatePipDependencies(['--index-url=http://evil==1'], LIMITS))).toMatch(/name/);
    expect(messageOf(() => validatePipDependencies(['numpy==2.1.0 ; rm -rf /'], LIMITS))).toMatch(/hash/);
    expect(messageOf(() => validatePipDependencies(['numpy==2.1.0 --index-url=http://x'], LIMITS))).toMatch(/hash/);
    expect(messageOf(() => validatePipDependencies(['-rrequirements.txt==1'], LIMITS))).toMatch(/name/);
    expect(messageOf(() => validatePipDependencies(['pkg==${HOME}'], LIMITS))).toMatch(/exact/);
  });

  test('enforces max count', () => {
    const many = Array.from({ length: 6 }, (_, i) => `p${i}==1.0`);
    expect(messageOf(() => validatePipDependencies(many, LIMITS))).toMatch(/maximum/);
  });

  test('rejects a partially hashed set', () => {
    const h = '--hash=sha256:' + 'b'.repeat(64);
    expect(messageOf(() => validatePipDependencies([`a==1.0 ${h}`, 'b==2.0'], LIMITS))).toMatch(/every package or none/);
  });

  test('rejects malformed hash', () => {
    expect(messageOf(() => validatePipDependencies(['a==1.0 --hash=sha256:xyz'], LIMITS))).toMatch(/invalid --hash/);
  });

  test('rejects non-string / empty', () => {
    expect(messageOf(() => validatePipDependencies([123 as unknown as string], LIMITS))).toMatch(/must be a string/);
    expect(messageOf(() => validatePipDependencies([], LIMITS))).toMatch(/not be empty/);
    expect(messageOf(() => validatePipDependencies('numpy==1' as unknown as string[], LIMITS))).toMatch(/array/);
  });
});

describe('resolveDependencies', () => {
  test('returns undefined when none declared', () => {
    expect(resolveDependencies(undefined, 'python', { allow: true, maxCount: 5 })).toBeUndefined();
    expect(resolveDependencies({}, 'python', { allow: true, maxCount: 5 })).toBeUndefined();
  });

  test('refuses when the feature is disabled', () => {
    expect(messageOf(() => resolveDependencies({ pip: ['numpy==2.1.0'] }, 'python', { allow: false, maxCount: 5 })))
      .toMatch(/disabled/);
  });

  test('refuses pip on non-python runtimes', () => {
    expect(messageOf(() => resolveDependencies({ pip: ['numpy==2.1.0'] }, 'bash', { allow: true, maxCount: 5 })))
      .toMatch(/only supported for python/);
  });

  test('validates and returns pip specs', () => {
    expect(resolveDependencies({ pip: ['numpy==2.1.0'] }, 'python', { allow: true, maxCount: 5 }))
      .toEqual({ pip: ['numpy==2.1.0'] });
  });
});
