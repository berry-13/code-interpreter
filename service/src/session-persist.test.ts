import { describe, expect, test } from 'bun:test';
import {
  SESSION_STATE_FILENAME,
  SESSION_STATE_FILE_ID,
  SESSION_STATE_TAR_FILENAME,
  isReservedSessionFilename,
  isReservedSessionInputName,
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

  test('matches a reserved name used as a directory component, not just the basename', () => {
    // e.g. `.session_state.pkl/chunk` would otherwise stage a directory at the
    // reserved path, which the sandbox can never replace with the real pickle.
    expect(isReservedSessionFilename(`${SESSION_STATE_FILENAME}/chunk`)).toBe(true);
    expect(isReservedSessionFilename(`a/${SESSION_STATE_FILENAME}.tmp/b`)).toBe(true);
    expect(isReservedSessionFilename(`a\\${SESSION_STATE_FILENAME}\\b`)).toBe(true);
  });
});

describe('isReservedSessionInputName', () => {
  test('rejects the tar and namespace-snapshot names (by basename)', () => {
    expect(isReservedSessionInputName(SESSION_STATE_TAR_FILENAME)).toBe(true);
    expect(isReservedSessionInputName(SESSION_STATE_FILENAME)).toBe(true);
    expect(isReservedSessionInputName(`${SESSION_STATE_FILENAME}.tmp`)).toBe(true);
    expect(isReservedSessionInputName(`nested/${SESSION_STATE_TAR_FILENAME}`)).toBe(true);
    expect(isReservedSessionInputName(`a\\b\\${SESSION_STATE_FILENAME}`)).toBe(true);
  });
  test('allows ordinary input names', () => {
    expect(isReservedSessionInputName('data.csv')).toBe(false);
    expect(isReservedSessionInputName('workspace.tar')).toBe(false);
    expect(isReservedSessionInputName('')).toBe(false);
  });

  test('rejects a reserved name used as a directory component, not just the basename', () => {
    expect(isReservedSessionInputName(`${SESSION_STATE_TAR_FILENAME}/chunk`)).toBe(true);
    expect(isReservedSessionInputName(`a/${SESSION_STATE_FILENAME}/b`)).toBe(true);
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

  test('only restores state / registers the snapshot / fakes __main__ for an actual launch', () => {
    // An ordinary import (__name__ not in ('__main__', '__mp_main__')) must
    // run the user code in its own real globals() and return -- it must not
    // reach the state-restore, atexit-registration, or fake-__main__ setup,
    // which would replay persistence side effects a second time.
    const wrapped = wrapPythonForSessionPersistence('pass\n', 'main.py');
    const guardIdx = wrapped.indexOf("if __name__ not in ('__main__', '__mp_main__'):");
    const elseIdx = wrapped.indexOf('\nelse:\n', guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(elseIdx).toBeGreaterThan(guardIdx);
    const importBranch = wrapped.slice(guardIdx, elseIdx);
    expect(importBranch).toContain("exec(compile(_CA_SRC, '<user_code>', 'exec'), globals())");
    expect(importBranch).not.toContain('_ca_atexit.register');
    expect(importBranch).not.toContain("ModuleType('__main__')");
    expect(importBranch).not.toContain('_CA_STATE');

    const launchBranch = wrapped.slice(elseIdx);
    expect(launchBranch).toContain('_ca_atexit.register(_ca_snapshot_pinned)');
    expect(launchBranch).toContain("ModuleType('__main__')");
    expect(launchBranch).toContain('_ca_os.path.exists(_CA_STATE)');
  });
});

describe('PYTHON_SESSION_WRAPPER __name__ handling (executed)', () => {
  // Exercises the actual generated Python for all three ways this file's
  // __name__ can be bound, without touching the real /mnt/data path (the
  // wrapper's own restore/snapshot logic is redirected to a temp file by
  // monkeypatching _CA_STATE after exec so this stays a pure unit test).
  test('runs user code once as __main__, in-place for __mp_main__, and without persistence ceremony on import', () => {
    const wrapped = wrapPythonForSessionPersistence("print('ran:' + __name__)\n", 'main.py');
    const harness = `
import sys, types, runpy
_ca_state_dir = sys.argv[1]

def run_as(name):
    mod = types.ModuleType(name)
    mod.__dict__['__name__'] = name
    mod.__dict__['__builtins__'] = __builtins__
    code = compile(WRAPPED.replace("'/mnt/data/.session_state.pkl'", repr(_ca_state_dir + '/.session_state.pkl')), 'wrapper.py', 'exec')
    exec(code, mod.__dict__)
    return mod

run_as('__main__')
print('---')
run_as('__mp_main__')
print('---')
run_as('not_main')
`;
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-session-test-'));
    const harnessPath = path.join(dir, 'harness.py');
    fs.writeFileSync(harnessPath, `WRAPPED = ${JSON.stringify(wrapped)}\n` + harness);
    const { execFileSync } = require('child_process');
    const out = execFileSync('python3', [harnessPath, dir], { encoding: 'utf8' });
    const sections = out.trim().split('---\n').map((s: string) => s.trim());
    expect(sections[0]).toBe('ran:__main__');
    expect(sections[1]).toBe('ran:__mp_main__');
    expect(sections[2]).toBe('ran:not_main');
  });

  test('a workspace file shadowing a bootstrap stdlib module does not break the wrapper', () => {
    // `types` and `io` are already cached in sys.modules before any user code
    // runs (CPython's own startup needs them), so they're immune regardless
    // of sys.path order -- but `base64` is not, confirmed empirically (a
    // fresh `python3 -c` shows 'base64' absent from sys.modules pre-exec).
    // A restored workspace file named base64.py that doesn't define
    // b64decode reproduces the real crash this fix addresses: run the
    // wrapper's own script directory (which is always on sys.path, like any
    // executed script's directory) with such a file present.
    const wrapped = wrapPythonForSessionPersistence("print('user code ran')\n", 'main.py');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-session-shadow-test-'));
    fs.writeFileSync(path.join(dir, 'base64.py'), 'print("evil base64.py imported!")\n');
    const wrapperPath = path.join(dir, 'main.py');
    fs.writeFileSync(wrapperPath, wrapped.replace(/\/mnt\/data/g, dir));
    const { execFileSync } = require('child_process');
    const out = execFileSync('python3', [wrapperPath], { encoding: 'utf8', cwd: dir });
    expect(out).not.toContain('evil base64.py imported!');
    expect(out.trim()).toBe('user code ran');
  });

  test('user code can still shadow a bootstrap stdlib module with its own workspace file', () => {
    // The bootstrap's own imports run with the workspace hidden from
    // sys.path (see the fix above), but that must not leave the REAL base64
    // permanently cached in sys.modules once the workspace is restored --
    // otherwise a later plain `import base64` in user code would keep
    // hitting the module the bootstrap loaded, instead of a legitimate
    // /mnt/data/base64.py the user actually shipped, silently breaking an
    // import that would have worked fine without persistence enabled.
    const wrapped = wrapPythonForSessionPersistence(
      "import base64\nprint('marker:', getattr(base64, 'MARKER', None))\n",
      'main.py',
    );
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-session-usershadow-test-'));
    fs.writeFileSync(path.join(dir, 'base64.py'), "MARKER = 'this is the workspace copy'\n");
    const wrapperPath = path.join(dir, 'main.py');
    fs.writeFileSync(wrapperPath, wrapped.replace(/\/mnt\/data/g, dir));
    const { execFileSync } = require('child_process');
    const out = execFileSync('python3', [wrapperPath], { encoding: 'utf8', cwd: dir });
    expect(out.trim()).toBe('marker: this is the workspace copy');
  });

  test('an orphaned os.fork() child that outlives the parent does not overwrite the parent\'s persisted state', () => {
    // A raw os.fork() (unlike multiprocessing spawn/forkserver, already
    // handled separately) duplicates the whole process, atexit registry
    // included. If the parent exits without waiting for the child, and the
    // child later diverges its own copy of a variable before exiting
    // normally, the child's own atexit-triggered snapshot -- landing AFTER
    // the parent's -- would silently overwrite the parent's correct final
    // state with the child's stale/divergent one.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-session-fork-test-'));

    const run1 = wrapPythonForSessionPersistence(
      [
        'import os, sys, time',
        "x = 'parent-value'",
        'pid = os.fork()',
        'if pid == 0:',
        '    time.sleep(0.3)',
        "    x = 'CHILD-CORRUPTED-VALUE'",
        '    sys.exit(0)',
        'else:',
        "    print('parent done')",
      ].join('\n'),
      'main.py',
    );
    fs.writeFileSync(path.join(dir, 'main.py'), run1.replace(/\/mnt\/data/g, dir));
    execFileSync('python3', [path.join(dir, 'main.py')], { encoding: 'utf8', cwd: dir });
    // Give the orphaned background child time to wake up, diverge, and exit
    // (well past its 0.3s sleep) before the next run reads the snapshot.
    execFileSync('sleep', ['0.6']);

    const run2 = wrapPythonForSessionPersistence("print('restored x =', x)", 'main.py');
    fs.writeFileSync(path.join(dir, 'main.py'), run2.replace(/\/mnt\/data/g, dir));
    const out = execFileSync('python3', [path.join(dir, 'main.py')], { encoding: 'utf8', cwd: dir });

    expect(out.trim()).toBe('restored x = parent-value');
  });
});

describe('reserved constants', () => {
  test('the tar filename carries a .tar extension and the file id is upload-valid', () => {
    expect(SESSION_STATE_TAR_FILENAME.endsWith('.tar')).toBe(true);
    // Must be a 21-char nanoid so the file-server/gateway accepts the upload;
    // restore safety comes from the (id, session, name) tuple match, not the id.
    expect(/^[A-Za-z0-9_-]{21}$/.test(SESSION_STATE_FILE_ID)).toBe(true);
  });
});
