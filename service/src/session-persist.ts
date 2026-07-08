/**
 * Persistent-session support (opt-in, OFF by default; gated by
 * `env.PERSIST_SESSIONS`). See the design in the plan and the matching
 * sandbox-side round-trip in `api/src/job.ts`.
 *
 * Two layers of continuity ride on a single durable artifact — the `/mnt/data`
 * workspace, snapshotted to object storage under the caller's own auth-derived
 * `sessionKey` and re-materialized on the next run:
 *   1. Files:   any file the user left under `/mnt/data`.
 *   2. Variables (Python): a `dill`-serialized snapshot of the run's global
 *      namespace, written to `SESSION_STATE_SANDBOX_PATH` (which lives inside
 *      `/mnt/data`, so it rides along in the same tar — not a second transport).
 *
 * This module owns only the Python-side wrapper that produces/consumes the
 * variable snapshot. The file/tar transport is entirely in `api/src/job.ts`.
 */

/** Basename of the serialized Python namespace, inside the `/mnt/data` mount. */
export const SESSION_STATE_FILENAME = '.session_state.pkl';

/**
 * Object id (under the run's output session) that the workspace snapshot tar is
 * written to, and read back from the previous run's output session. Must stay a
 * 21-char nanoid so the file-server/gateway upload validation accepts it. The
 * sandbox does not trust this id alone to identify prior state -- it matches the
 * full (id, storage_session_id, name) tuple the service injected (the session
 * id being an unpredictable per-run value), so a user file merely named like
 * the state tar can never be mistaken for it.
 */
export const SESSION_STATE_FILE_ID = 'codeapi-session-state';

/** Logical name of the workspace tar; the `.tar` suffix drives its stored ext. */
export const SESSION_STATE_TAR_FILENAME = 'session-workspace.tar';

/**
 * Redis key mapping a caller's sessionKey to the output session id of their
 * last run that produced a snapshot. This is the cross-call rendezvous: the
 * next run reads it to authorize + fetch the prior snapshot. Refreshed (with
 * `SESSION_STATE_TTL_SECONDS`) on every successful persist, so an active
 * session never expires and an abandoned one is collected when the key lapses.
 */
export function sessionStatePointerKey(sessionKey: string): string {
  return `sessionstate:${sessionKey}`;
}

/** Absolute in-sandbox path (`submissionDir` is bind-mounted at `/mnt/data`). */
export const SESSION_STATE_SANDBOX_PATH = `/mnt/data/${SESSION_STATE_FILENAME}`;

/**
 * Reserved basenames the persistence layer writes into the submission dir.
 * The output-file classifier must skip these so the private state blob is
 * never surfaced back to the user as a generated file (it still rides inside
 * the workspace tar). Mirrors the intent of `isReservedPtcFilename`.
 */
export const SESSION_RESERVED_BASENAMES: ReadonlySet<string> = new Set([
  SESSION_STATE_FILENAME,
  `${SESSION_STATE_FILENAME}.tmp`,
]);

/** True when `name`'s basename is a reserved session-state artifact. */
export function isReservedSessionFilename(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  const base = name.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return base !== undefined && SESSION_RESERVED_BASENAMES.has(base);
}

/**
 * True when a user input file name would collide with any persistence artifact
 * the sandbox writes into `/mnt/data` -- the workspace tar OR the namespace
 * snapshot. Basename-based so nested paths are caught too. The router rejects
 * such inputs when persistence is on: otherwise a user file named
 * `.session_state.pkl` would overwrite the restored namespace (and be loaded as
 * pickle state), or one named like the tar would be mistaken for prior state.
 */
export function isReservedSessionInputName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  const base = name.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  if (base === undefined) return false;
  return base === SESSION_STATE_TAR_FILENAME || SESSION_RESERVED_BASENAMES.has(base);
}

/**
 * Python bootstrap that restores the prior namespace, arms an `atexit`
 * snapshot, and then runs the user code via `exec(compile(...))` in a
 * dedicated namespace dict.
 *
 * Why `exec(compile(src, '<user_code>', 'exec'), ns)` rather than prepending a
 * preamble to the user's source:
 *   - User line numbers are preserved (the unit compiled as `<user_code>`
 *     starts at line 1), and the source is registered in `linecache` so
 *     tracebacks still show the offending line.
 *   - `from __future__ import ...` stays valid (it remains the first statement
 *     of its own compilation unit); a prepended preamble would break it.
 *   - `ns` is a clean dict we fully control, so the snapshot captures exactly
 *     the user's globals — the same model Jupyter/IPython use to run a cell.
 *
 * Snapshot policy (best-effort, never fatal):
 *   - Runs from `atexit`, so it fires on normal completion AND after an
 *     uncaught exception (interpreter shutdown still runs atexit). A hard
 *     timeout (SIGKILL) or `os._exit` skips it — acceptable: no state that run.
 *   - Names starting with `_` and module objects are excluded. Each remaining
 *     value is probed with `dumps` individually; unserializable ones (open
 *     handles, sockets, threads, some native objects) are dropped rather than
 *     failing the whole snapshot.
 *   - `dill` is preferred (handles closures/lambdas/local classes); stdlib
 *     `pickle` is the fallback if `dill` is not present in the runtime.
 *
 * The `__USERCODE_B64__` placeholder is replaced with base64 of the (already
 * pyplot-wrapped, if applicable) user code — base64 avoids all source-quoting
 * hazards regardless of what the user code contains.
 */
const PYTHON_SESSION_WRAPPER = String.raw`import sys as _ca_sys, os as _ca_os, atexit as _ca_atexit, base64 as _ca_b64, linecache as _ca_linecache, types as _ca_types, io as _ca_io, importlib as _ca_importlib
_CA_STATE = '/mnt/data/.session_state.pkl'
try:
    import dill as _ca_pk
except Exception:
    import pickle as _ca_pk

_CA_SRC = _ca_b64.b64decode('__USERCODE_B64__').decode('utf-8')
_ca_linecache.cache['<user_code>'] = (len(_CA_SRC), None, _CA_SRC.splitlines(True), '<user_code>')

if __name__ == '__mp_main__':
    # 'spawn'/'forkserver' multiprocessing re-imports this entry module in the
    # child under the name __mp_main__ to rebuild top-level defs (the target
    # function/class) WITHOUT re-running the user's "if __name__ == __main__"
    # block. Run the user code in-place -- globals() is exactly the dict the
    # bootstrap copies into the __mp_main__ module, so top-level defs land where
    # multiprocessing resolves them -- and leave __name__ == '__mp_main__' so the
    # guard stays False. Forcing a '__main__' namespace here (as the primary path
    # does) would re-fire the guarded block in every child and multiprocessing
    # would raise the "started a process before bootstrapping is complete"
    # RuntimeError. No atexit snapshot here: the child is a transient worker, not
    # the run whose namespace we persist, and its atexit could clobber the
    # pickle. State IS restored below, though: a function/class defined in a
    # PRIOR run (and only reachable now via the persisted namespace, not this
    # run's own source) can still be used as a multiprocessing target -- the
    # child must resolve it via __main__.<name> the same way the parent does.
    _ca_ns = globals()
else:
    # Run user code in a real module registered as sys.modules['__main__'], not a
    # bare dict, so user-defined classes/functions pickle correctly (pickle
    # resolves them via __main__.<name>) and spawn-style multiprocessing can find
    # them. Our own _ca_* helpers stay in the wrapper module's separate globals,
    # so they never leak into the user namespace. ModuleType('__main__') seeds
    # __name__ for us, so the "if __name__ == __main__" guard and the pyplot
    # template still behave.
    _ca_main = _ca_types.ModuleType('__main__')
    _ca_main.__dict__['__builtins__'] = __builtins__
    _ca_main.__dict__['__file__'] = '/mnt/data/__CA_ENTRY__'
    _ca_sys.modules['__main__'] = _ca_main
    _ca_ns = _ca_main.__dict__

if _ca_os.path.exists(_CA_STATE):
    try:
        with open(_CA_STATE, 'rb') as _ca_f:
            _ca_state = _ca_pk.load(_ca_f)
        # Envelope: {'__ca_v__':1, 'ns': {values}, 'mods': {alias: modname}}.
        # Re-import module aliases by name first (so "import pandas as pd" in
        # one cell leaves pd bound in the next), then restore pickled values.
        if isinstance(_ca_state, dict) and _ca_state.get('__ca_v__') == 1:
            for _ca_alias, _ca_modname in _ca_state.get('mods', {}).items():
                try:
                    _ca_ns[_ca_alias] = _ca_importlib.import_module(_ca_modname)
                except Exception:
                    pass
            _ca_ns.update(_ca_state.get('ns', {}))
        else:
            _ca_ns.update(_ca_state)  # legacy raw-dict snapshot
        _ca_ns['__name__'] = __name__  # preserve '__mp_main__' in spawn children
    except Exception as _ca_e:
        print('[session] state restore skipped: %r' % (_ca_e,), file=_ca_sys.stderr)

if __name__ == '__mp_main__':
    exec(compile(_CA_SRC, '<user_code>', 'exec'), _ca_ns)
else:
    def _ca_snapshot():
        ok = {}
        mods = {}
        for k, v in list(_ca_ns.items()):
            if k.startswith('_'):
                continue
            # Record module aliases by import name so they can be re-imported on
            # the next run rather than lost (the advertised "namespace carries").
            if isinstance(v, _ca_types.ModuleType):
                name = getattr(v, '__name__', None)
                if isinstance(name, str) and name:
                    mods[k] = name
                continue
            # Skip open file handles. dill CAN pickle a file handle, but restoring
            # one reopens the path in its original mode -- for a write handle that
            # TRUNCATES the user's file on the next run. Excluding io objects keeps
            # a leftover with-block file handle from wiping the file it wrote.
            # (Sockets/threads/locks fail dumps below and are dropped there.)
            if isinstance(v, _ca_io.IOBase):
                continue
            try:
                _ca_pk.dumps(v)
            except Exception:
                continue
            ok[k] = v
        try:
            tmp = _CA_STATE + '.tmp'
            with open(tmp, 'wb') as f:
                _ca_pk.dump({'__ca_v__': 1, 'ns': ok, 'mods': mods}, f)
            _ca_os.replace(tmp, _CA_STATE)
        except Exception as e:
            print('[session] state snapshot skipped: %r' % (e,), file=_ca_sys.stderr)

    _ca_atexit.register(_ca_snapshot)

    exec(compile(_CA_SRC, '<user_code>', 'exec'), _ca_ns)
`;

/**
 * Wrap already-assembled Python source (plain user code, or the pyplot
 * template with user code embedded) so its global namespace is restored before
 * and snapshotted after the run. `entryFileName` is the sandbox entry filename
 * (e.g. `main.py`) used only to give the user code a plausible `__file__`.
 */
export function wrapPythonForSessionPersistence(code: string, entryFileName: string): string {
  const b64 = Buffer.from(code, 'utf-8').toString('base64');
  return PYTHON_SESSION_WRAPPER
    .replace('__CA_ENTRY__', entryFileName.replace(/[^A-Za-z0-9._-]/g, '_'))
    .replace('__USERCODE_B64__', b64);
}
