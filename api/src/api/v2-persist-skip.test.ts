import { describe, it, expect } from 'bun:test';
import { wasKilledBySignal } from './v2';
import type { NsJailResult } from '../nsjail';

/**
 * Unit tests for `wasKilledBySignal`, which gates whether the persistent-
 * session workspace snapshot is attempted after a run. The Python wrapper's
 * variable snapshot runs from `atexit`, which a signal kill (timeout ->
 * SIGKILL, or any other signal death) never reaches -- but ordinary file
 * writes made before the kill are not buffered and would still land in a
 * persisted tar, alongside a stale (pre-this-run) variable pickle. Skipping
 * the whole persist on a signal kill avoids advancing the session pointer to
 * that torn, no-single-run-ever-produced-it snapshot.
 */

function makeRun(overrides: Partial<NsJailResult>): NsJailResult {
  return {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
    output: '',
    memory: null,
    message: null,
    status: null,
    cpu_time: null,
    wall_time: null,
    ...overrides,
  };
}

describe('wasKilledBySignal', () => {
  it('is true when the run carries a signal (e.g. SIGKILL from a timeout)', () => {
    expect(wasKilledBySignal(makeRun({ signal: 'SIGKILL', status: 'TO' }))).toBe(true);
  });

  it('is true for any other signal death, not just SIGKILL', () => {
    expect(wasKilledBySignal(makeRun({ signal: 'SIGSEGV' }))).toBe(true);
  });

  it('is false for a clean exit', () => {
    expect(wasKilledBySignal(makeRun({ code: 0, signal: null }))).toBe(false);
  });

  it('is false for a plain nonzero exit (uncaught exception or sys.exit(n)) -- atexit still runs', () => {
    expect(wasKilledBySignal(makeRun({ code: 1, signal: null }))).toBe(false);
  });

  it('is false when there is no run result at all', () => {
    expect(wasKilledBySignal(undefined)).toBe(false);
  });
});
