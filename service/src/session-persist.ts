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
 * session's pointer never expires.
 *
 * KNOWN GAP: an abandoned session's pointer key lapsing (TTL expiry) only
 * removes this Redis key -- it does NOT delete the snapshot object the
 * pointer referenced. `deleteSessionSnapshot` only ever runs on explicit
 * supersession (a newer run's CAS-advance draining the last ref on the old
 * one), which never happens for a session nobody calls again. Every
 * abandoned session therefore leaves its last snapshot tar in object storage
 * indefinitely. Closing this needs either an in-process sweep (a companion,
 * longer-TTL tracker key per session, scanned periodically, comparing
 * against whether the real pointer still exists -- mirroring the janitor
 * pattern in service/src/service/programmatic-router.ts +
 * replay-state.ts's `cleanupStaleExecutions`/`scanKeys`) or an object
 * lifecycle policy on the underlying bucket/prefix, which is entirely a
 * file-server/storage deployment concern outside this repo.
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

/** Every `/`- or `\`-delimited segment of `name`, empty segments dropped. */
function pathSegments(name: string): string[] {
  return name.replace(/\\/g, '/').split('/').filter(Boolean);
}

/** True when any path segment of `name` (not just its basename) is a
 *  reserved session-state artifact. Checking every segment -- not just
 *  `.pop()` -- matters because a name like `.session_state.pkl/chunk` would
 *  otherwise pass validation and stage a directory at the reserved path,
 *  which the sandbox then can't replace with the actual pickle file. */
export function isReservedSessionFilename(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  return pathSegments(name).some(segment => SESSION_RESERVED_BASENAMES.has(segment));
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
  return pathSegments(name).some(
    segment => segment === SESSION_STATE_TAR_FILENAME || SESSION_RESERVED_BASENAMES.has(segment),
  );
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
const PYTHON_SESSION_WRAPPER = String.raw`import sys as _ca_sys
# Running this file puts its own directory ('/mnt/data', the workspace) on
# sys.path -- normal Python behavior for the script being executed, and one
# user code depends on to import its own helper modules. But it also means a
# workspace file left by a prior run (persisted or restored) and named like
# one of the stdlib modules this bootstrap itself needs -- e.g. types.py,
# base64.py, io.py -- would shadow the real module for these imports too,
# since they run before user code and see the same sys.path. That can brick
# every future continuation of the session: e.g. a shadowing types.py without
# ModuleType fails the fake-'__main__' setup below on every run, even ones
# whose own code never touches matplotlib/multiprocessing/types at all. Strip
# the workspace out of sys.path for just this bootstrap's own imports, then
# restore it before compiling/running user code, so user imports keep
# resolving their own /mnt/data modules exactly as before.
_ca_saved_path = list(_ca_sys.path)
_ca_sys.path[:] = [_ca_p for _ca_p in _ca_sys.path if _ca_p not in ('', '/mnt/data')]
_ca_preexisting_mods = set(_ca_sys.modules.keys())
import os as _ca_os, atexit as _ca_atexit, base64 as _ca_b64, linecache as _ca_linecache, types as _ca_types, io as _ca_io, importlib as _ca_importlib
try:
    import dill as _ca_pk
    _ca_using_dill = True
except Exception:
    import pickle as _ca_pk
    _ca_using_dill = False
_ca_sys.path[:] = _ca_saved_path
# We already hold our own references (_ca_os, _ca_b64, ...), so evict any of
# THESE SPECIFIC names that this import just newly added to sys.modules
# (some, like types/io, are typically already cached by CPython's own
# startup and stay put; others, like base64, typically aren't). Otherwise a
# later plain "import base64" in user code -- now with /mnt/data restored to
# sys.path -- would still hit the module WE loaded while the workspace was
# hidden, rather than performing a fresh lookup that lets a legitimate
# workspace base64.py shadow it, exactly as it would without persistence.
for _ca_modname in ('os', 'atexit', 'base64', 'linecache', 'types', 'io', 'importlib', 'dill', 'pickle'):
    if _ca_modname not in _ca_preexisting_mods:
        _ca_sys.modules.pop(_ca_modname, None)

_CA_STATE = '/mnt/data/.session_state.pkl'
_CA_SRC = _ca_b64.b64decode('__USERCODE_B64__').decode('utf-8')
_ca_linecache.cache['<user_code>'] = (len(_CA_SRC), None, _CA_SRC.splitlines(True), '<user_code>')

if __name__ not in ('__main__', '__mp_main__'):
    # Ordinary import of this wrapped entry file (e.g. user code does
    # "import main" to reuse a function/class it defined earlier). Run in
    # this module's own real globals, like any normal import -- no fake
    # '__main__' namespace, no state restore, no atexit snapshot. Those all
    # belong to the actual launch ('__main__') or a spawn/forkserver child
    # ('__mp_main__'); re-arming them here would re-run the user's code a
    # second time under a synthetic '__main__' identity (firing their
    # "if __name__ == '__main__'" guard when it shouldn't) and register a
    # second atexit snapshot that could race the real one.
    exec(compile(_CA_SRC, '<user_code>', 'exec'), globals())
else:
    if __name__ == '__mp_main__':
        # 'spawn'/'forkserver' multiprocessing re-imports this entry module in
        # the child under the name __mp_main__ to rebuild top-level defs (the
        # target function/class) WITHOUT re-running the user's
        # "if __name__ == __main__" block. Run the user code in-place --
        # globals() is exactly the dict the bootstrap copies into the
        # __mp_main__ module, so top-level defs land where multiprocessing
        # resolves them -- and leave __name__ == '__mp_main__' so the guard
        # stays False. Forcing a '__main__' namespace here (as the primary
        # path does) would re-fire the guarded block in every child and
        # multiprocessing would raise the "started a process before
        # bootstrapping is complete" RuntimeError. No atexit snapshot here:
        # the child is a transient worker, not the run whose namespace we
        # persist, and its atexit could clobber the pickle. State IS restored
        # below, though: a function/class defined in a PRIOR run (and only
        # reachable now via the persisted namespace, not this run's own
        # source) can still be used as a multiprocessing target -- the child
        # must resolve it via __main__.<name> the same way the parent does.
        _ca_ns = globals()
    else:
        # Run user code in a real module registered as sys.modules['__main__'],
        # not a bare dict, so user-defined classes/functions pickle correctly
        # (pickle resolves them via __main__.<name>) and spawn-style
        # multiprocessing can find them. Our own _ca_* helpers stay in the
        # wrapper module's separate globals, so they never leak into the user
        # namespace. ModuleType('__main__') seeds __name__ for us, so the
        # "if __name__ == __main__" guard and the pyplot template still behave.
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
            # Re-import module aliases by name first (so "import pandas as pd"
            # in one cell leaves pd bound in the next), then restore pickled
            # values.
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
            # Without dill, dumps() alone can't tell whether a value will
            # actually survive a restore. Stdlib pickle serializes a
            # top-level function/class BY REFERENCE (__main__.<name>), and
            # that reference genuinely resolves right now, mid-run -- but
            # ALSO serializes anything that transitively contains one (a
            # class instance, a list of instances, a dict of them, ...) the
            # same way. On the next run, restore happens BEFORE user code
            # re-defines those names, so pickle.load() hits a missing
            # __main__ attribute and raises -- aborting the WHOLE pickle
            # stream and dropping every other value in the same snapshot,
            # simple variables included. dill serializes these by value
            # instead, so it doesn't share the failure mode; only the
            # plain-pickle fallback needs the extra check. Round-tripping
            # through a scratch stand-in __main__ (swapped in only for this
            # probe; nothing else runs while it's briefly in place)
            # reproduces exactly what the next run's fresh, not-yet-populated
            # __main__ will see, so it catches every shape of this failure in
            # one general check instead of enumerating types.
            _ca_probe_main = None if _ca_using_dill else _ca_types.ModuleType('__main__')
            if _ca_probe_main is not None:
                _ca_probe_main.__dict__['__builtins__'] = __builtins__
            for k, v in list(_ca_ns.items()):
                if k.startswith('_'):
                    continue
                # Record module aliases by import name so they can be
                # re-imported on the next run rather than lost (the
                # advertised "namespace carries").
                if isinstance(v, _ca_types.ModuleType):
                    name = getattr(v, '__name__', None)
                    if isinstance(name, str) and name:
                        mods[k] = name
                    continue
                # Skip open file handles. dill CAN pickle a file handle, but
                # restoring one reopens the path in its original mode -- for
                # a write handle that TRUNCATES the user's file on the next
                # run. Excluding io objects keeps a leftover with-block file
                # handle from wiping the file it wrote. (Sockets/threads/locks
                # fail dumps below and are dropped there.)
                if isinstance(v, _ca_io.IOBase):
                    continue
                try:
                    _ca_blob = _ca_pk.dumps(v)
                except Exception:
                    continue
                if _ca_probe_main is not None:
                    _ca_real_main = _ca_sys.modules.get('__main__')
                    _ca_sys.modules['__main__'] = _ca_probe_main
                    try:
                        _ca_pk.loads(_ca_blob)
                    except Exception:
                        continue
                    finally:
                        _ca_sys.modules['__main__'] = _ca_real_main
                ok[k] = v
            try:
                tmp = _CA_STATE + '.tmp'
                with open(tmp, 'wb') as f:
                    _ca_pk.dump({'__ca_v__': 1, 'ns': ok, 'mods': mods}, f)
                _ca_os.replace(tmp, _CA_STATE)
            except Exception as e:
                print('[session] state snapshot skipped: %r' % (e,), file=_ca_sys.stderr)
                # A continuation restored the PREVIOUS run's pickle and it is
                # still on disk (restore can't delete it -- spawn/forkserver
                # children re-read it to resolve __main__ targets). Leaving it
                # here would tar THIS run's files with the LAST run's
                # variables -- a mixed snapshot no single run ever produced.
                # Drop the stale pickle (and any partial tmp) best-effort so a
                # failed snapshot degrades to "files carry, variables reset",
                # the same shape as a first run.
                for stale in (tmp, _CA_STATE):
                    try:
                        _ca_os.remove(stale)
                    except OSError:
                        pass

        _ca_atexit.register(_ca_snapshot)
        # A raw os.fork() (unlike multiprocessing's spawn/forkserver, already
        # handled above) duplicates the WHOLE process, atexit registry
        # included: the child inherits this exact registration. If the child
        # later exits normally (not via os._exit/a signal), its own interpreter
        # shutdown would run _ca_snapshot() too, using its own copy-on-write
        # _ca_ns -- a snapshot of a DIFFERENT, divergent execution than the
        # parent's, capable of overwriting the parent's real final state if
        # the child's write lands after it. Unregister the hook in the child
        # only, right after the fork -- the parent keeps it untouched, so only
        # the one process whose namespace this snapshot actually describes
        # ever persists it.
        try:
            _ca_os.register_at_fork(after_in_child=lambda: _ca_atexit.unregister(_ca_snapshot))
        except (AttributeError, ValueError):
            pass  # register_at_fork is POSIX-only; not expected to be missing here

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
