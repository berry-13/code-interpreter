import { describe, expect, test } from 'bun:test';
import { envFlag, legacyPackagesDirectory } from './config';

describe('legacy package directory fallback', () => {
  test('preserves custom legacy data directories', () => {
    expect(legacyPackagesDirectory('/custom/data')).toBe('/custom/data/packages');
    expect(legacyPackagesDirectory('/custom/data/packages')).toBe('/custom/data/packages');
    expect(legacyPackagesDirectory('/')).toBe('/packages');
  });

  test('ignores empty legacy data directories', () => {
    expect(legacyPackagesDirectory(undefined)).toBeUndefined();
    expect(legacyPackagesDirectory('   ')).toBeUndefined();
  });
});

describe('envFlag', () => {
  /* Compose forwards `${VAR:-}`, so an unset knob arrives as '' rather than
   * undefined. Reading that blank as an explicit "not true" silently turned
   * CODEAPI_DEPENDENCY_REQUIRE_PINNED off for every deployment that left it
   * alone -- the opposite of the documented default. */
  test('treats blank the same as unset', () => {
    expect(envFlag(undefined, true)).toBe(true);
    expect(envFlag('', true)).toBe(true);
    expect(envFlag('   ', true)).toBe(true);
    expect(envFlag(undefined, false)).toBe(false);
    expect(envFlag('', false)).toBe(false);
  });

  test('honours an explicit value in either direction', () => {
    expect(envFlag('true', false)).toBe(true);
    expect(envFlag('false', true)).toBe(false);
    // Anything that is not exactly 'true' is false, as before.
    expect(envFlag('yes', true)).toBe(false);
    expect(envFlag('1', true)).toBe(false);
  });
});
