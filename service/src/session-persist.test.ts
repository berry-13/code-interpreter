import { describe, expect, test } from 'bun:test';
import {
  SESSION_STATE_FILENAME,
  SESSION_STATE_FILE_ID,
  SESSION_STATE_TAR_FILENAME,
  isReservedSessionFilename,
  sessionStatePointerKey,
  wrapPythonForSessionPersistence,
} from './session-persist';

describe('isReservedSessionFilename', () => {
  test('matches the snapshot file and its tempfile by basename', () => {
    expect(isReservedSessionFilename(SESSION_STATE_FILENAME)).toBe(true);
    expect(isReservedSessionFilename(`${SESSION_STATE_FILENAME}.tmp`)).toBe(true);
    expect(isReservedSessionFilename(`sub/dir/${SESSION_STATE_FILENAME}`)).toBe(true);
    expect(isReservedSessionFilename(`sub\\dir\\${SESSION_STATE_FILENAME}`)).toBe(true);
  });

  test('does not match unrelated or lookalike names', () => {
    expect(isReservedSessionFilename('data.csv')).toBe(false);
    expect(isReservedSessionFilename('my_session_state.pkl')).toBe(false);
    expect(isReservedSessionFilename('')).toBe(false);
    expect(isReservedSessionFilename(undefined as unknown as string)).toBe(false);
  });
});

describe('sessionStatePointerKey', () => {
  test('namespaces the pointer under sessionstate:', () => {
    expect(sessionStatePointerKey('tenantA:user:u1')).toBe('sessionstate:tenantA:user:u1');
  });
});

describe('wrapPythonForSessionPersistence', () => {
  test('embeds the user code as base64 and does not inline it verbatim', () => {
    const user = "raise ValueError('boom')\nsecret_marker = 1\n";
    const wrapped = wrapPythonForSessionPersistence(user, 'main.py');
    // The literal source must not appear (it is base64-encoded), so a preamble
    // cannot break `from __future__` imports or shift user line numbers.
    expect(wrapped).not.toContain("raise ValueError('boom')");
    expect(wrapped).toContain(Buffer.from(user, 'utf-8').toString('base64'));
  });

  test('runs the decoded source via exec(compile(...)) with a linecache entry', () => {
    const wrapped = wrapPythonForSessionPersistence('x = 1\n', 'main.py');
    expect(wrapped).toContain("compile(_CA_SRC, '<user_code>', 'exec')");
    expect(wrapped).toContain('_ca_linecache.cache');
    expect(wrapped).toContain('atexit');
  });

  test('references the shared snapshot path and prefers dill over pickle', () => {
    const wrapped = wrapPythonForSessionPersistence('pass\n', 'main.py');
    expect(wrapped).toContain(`/mnt/data/${SESSION_STATE_FILENAME}`);
    expect(wrapped).toContain('import dill as _ca_pk');
    expect(wrapped).toContain('import pickle as _ca_pk');
  });

  test('sanitizes the entry filename into __file__ and leaves no placeholder', () => {
    const wrapped = wrapPythonForSessionPersistence('pass\n', 'we!rd/name.py');
    expect(wrapped).not.toContain('__CA_ENTRY__');
    expect(wrapped).not.toContain('__USERCODE_B64__');
    expect(wrapped).toContain('/mnt/data/we_rd_name.py');
  });
});

describe('reserved constants', () => {
  test('the tar filename carries a .tar extension and the file id is stable', () => {
    expect(SESSION_STATE_TAR_FILENAME.endsWith('.tar')).toBe(true);
    expect(SESSION_STATE_FILE_ID).toBe('codeapi-session-state');
  });
});
