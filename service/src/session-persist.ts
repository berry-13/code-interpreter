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
 * Placeholder the service sends as `persist_session.restore_session_id`
 * instead of the real prior output-session id. The sandbox treats the field
 * purely as a presence marker ("a prior snapshot was injected; match it by
 * filename") -- the actual fetch goes through the injected file entry, whose
 * id/session the egress layer masks into opaque handles like every other file
 * ref. Sending the raw id would leak the previous run's storage session to
 * the sandbox on every continuation, bypassing that masking.
 */
export const SESSION_STATE_RESTORE_MARKER = 'expected';

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
import os as _ca_os, atexit as _ca_atexit, base64 as _ca_b64, linecache as _ca_linecache, types as _ca_types, io as _ca_io, importlib as _ca_importlib, importlib.util as _ca_importlib_util, shutil as _ca_shutil
try:
    import dill as _ca_pk
    _ca_using_dill = True
except Exception:
    import pickle as _ca_pk
    _ca_using_dill = False
_ca_sys.path[:] = _ca_saved_path
# Evict EVERY module these imports newly added to sys.modules -- not just
# the names imported explicitly, but their transitive dependencies too
# (dill alone pulls in tempfile, pathlib, dataclasses, ...). Any of them
# left cached would make a later matching import in user code -- now with
# /mnt/data restored to sys.path -- hit the module WE loaded while the
# workspace was hidden, rather than perform a fresh lookup that lets a
# legitimate workspace tempfile.py/base64.py shadow it, exactly as it
# would without persistence. The evicted modules are kept aside rather
# than dropped: dill resolves its OWN internals through sys.modules
# lazily at load()/dump() time, so the restore/snapshot paths below pin
# this exact set back in while they run (see _ca_pin_hidden). Without the
# pin, a workspace shadow of a dill dependency would be re-imported INTO
# the pickling machinery itself: every value probe then fails, silently
# bricking the session's variable persistence.
_ca_hidden_mods = {}
for _ca_modname in list(_ca_sys.modules):
    if _ca_modname not in _ca_preexisting_mods:
        _ca_hidden_mods[_ca_modname] = _ca_sys.modules.pop(_ca_modname)

def _ca_pin_hidden():
    # Swap the bootstrap's own (real-stdlib) modules back into sys.modules
    # so dill's lazy sibling imports resolve to the modules it was loaded
    # with, never a workspace file. Returns whatever entries (user imports
    # of the same names, i.e. their shadows) were displaced, for
    # _ca_unpin_hidden to restore.
    _ca_displaced = {}
    for _ca_name, _ca_mod in _ca_hidden_mods.items():
        if _ca_name in _ca_sys.modules:
            _ca_displaced[_ca_name] = _ca_sys.modules[_ca_name]
        _ca_sys.modules[_ca_name] = _ca_mod
    return _ca_displaced

def _ca_unpin_hidden(_ca_displaced):
    for _ca_name in _ca_hidden_mods:
        if _ca_name in _ca_displaced:
            _ca_sys.modules[_ca_name] = _ca_displaced[_ca_name]
        else:
            _ca_sys.modules.pop(_ca_name, None)

_CA_STATE = '/mnt/data/.session_state.pkl'
# Import name the wrapped entry file resolves to (e.g. 'main' for main.py).
# Module aliases to it are neither persisted nor restored, and values that
# pickle BY REFERENCE through it are dropped by the snapshot probe -- see the
# mods loops and _ca_snapshot below.
_CA_ENTRY_MOD = _ca_os.path.splitext('__CA_ENTRY__')[0]
_CA_ENTRY_MOD_BYTES = _CA_ENTRY_MOD.encode('utf-8')
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
        # NOTE: children normally never see this wrapper anymore -- the launch
        # path below rewrites the on-disk entry file with the plain user
        # source before user code runs, so spawn children runpy that source
        # exactly like vanilla Python. This branch remains as the fallback
        # for when that rewrite could not be performed.
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
            # Pin only around the load itself: dill may lazily re-import its
            # own submodules here. The alias re-import loop below must stay
            # UNPINNED so a user alias resolves workspace shadows normally.
            # The entry module is BLOCKED during the load: new snapshots never
            # reference it (the probe in _ca_snapshot drops such values), but
            # a legacy pickle could, and letting the unpickler import the
            # CURRENT entry file would execute this run's payload before its
            # primary execution. Failing the load (restore skipped) is the
            # safe degradation.
            _ca_displaced = _ca_pin_hidden()
            _ca_had_entry = _CA_ENTRY_MOD in _ca_sys.modules
            _ca_entry_saved = _ca_sys.modules.get(_CA_ENTRY_MOD)
            _ca_sys.modules[_CA_ENTRY_MOD] = None
            # Also hide the workspace from imports for the load's duration: a
            # legacy pickle may hold a value pickled by reference through a
            # workspace module ("import helper; obj = helper.C()"), and
            # letting the unpickler import /mnt/data/helper.py here would
            # replay its top-level side effects before the payload runs. New
            # snapshots drop such values (see the probe in _ca_snapshot);
            # failing the load (restore skipped) is the safe degradation for
            # old ones. Site-packages refs are unaffected -- only the
            # workspace comes off sys.path.
            _ca_load_path = list(_ca_sys.path)
            _ca_sys.path[:] = [_ca_p for _ca_p in _ca_sys.path if _ca_p not in ('', '/mnt/data')]
            try:
                with open(_CA_STATE, 'rb') as _ca_f:
                    _ca_state = _ca_pk.load(_ca_f)
            finally:
                _ca_sys.path[:] = _ca_load_path
                if _ca_had_entry:
                    _ca_sys.modules[_CA_ENTRY_MOD] = _ca_entry_saved
                else:
                    _ca_sys.modules.pop(_CA_ENTRY_MOD, None)
                _ca_unpin_hidden(_ca_displaced)
            # Envelope: {'__ca_v__':1, 'ns': {values}, 'mods': {alias: modname}}.
            # Re-import module aliases by name first (so "import pandas as pd"
            # in one cell leaves pd bound in the next), then restore pickled
            # values.
            if isinstance(_ca_state, dict) and _ca_state.get('__ca_v__') == 1:
                for _ca_alias, _ca_modname in _ca_state.get('mods', {}).items():
                    # Never re-import an alias to the entry module itself
                    # (a prior run's "import main"): importing the wrapped
                    # entry file at restore time would exec the CURRENT
                    # payload once through the ordinary-import branch above,
                    # and then the wrapper runs it again as __main__ --
                    # doubling every top-level side effect. Snapshots no
                    # longer record such aliases, but pickles written before
                    # that fix still carry them.
                    if _ca_modname == _CA_ENTRY_MOD:
                        continue
                    # Workspace modules are not re-imported eagerly either
                    # (snapshots no longer record them; this guards legacy
                    # pickles): importing a restored helper.py here would
                    # replay its top-level side effects before the payload
                    # runs. find_spec on the TOP-LEVEL name locates without
                    # executing -- and unlike find_spec on a dotted name,
                    # never imports a parent package as a side effect.
                    try:
                        _ca_spec = _ca_importlib_util.find_spec(_ca_modname.split('.')[0])
                    except Exception:
                        _ca_spec = None
                    if _ca_spec is not None:
                        _ca_origin = getattr(_ca_spec, 'origin', None) or ''
                        _ca_locs = list(getattr(_ca_spec, 'submodule_search_locations', None) or [])
                        if _ca_origin.startswith('/mnt/data') or any(str(_ca_loc).startswith('/mnt/data') for _ca_loc in _ca_locs):
                            continue
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
            # Modules loaded from the workspace this run ("import helper" for
            # /mnt/data/helper.py). Values pickled BY REFERENCE through one
            # would make the next run's restore import that file before the
            # payload executes, replaying its top-level side effects (or
            # aborting the whole restore if the class is gone) -- the same
            # hazard the entry-module block below handles. The probe blocks
            # every one of these names alongside the entry module, so such
            # values fail the round-trip and are dropped. __main__ stays
            # exempt: its handling is the scratch-module swap below.
            _ca_ws_mods = {}
            for _ca_wn, _ca_wm in list(_ca_sys.modules.items()):
                if _ca_wn in ('__main__', '__mp_main__') or _ca_wm is None:
                    continue
                if (getattr(_ca_wm, '__file__', None) or '').startswith('/mnt/data'):
                    _ca_ws_mods[_ca_wn] = _ca_wm
            _ca_probe_block = set(_ca_ws_mods)
            _ca_probe_block.add(_CA_ENTRY_MOD)
            _ca_probe_block_bytes = [_ca_bn.encode('utf-8') for _ca_bn in _ca_probe_block]
            for k, v in list(_ca_ns.items()):
                if k.startswith('_'):
                    continue
                # Record module aliases by import name so they can be
                # re-imported on the next run rather than lost (the
                # advertised "namespace carries"). EXCEPT aliases to the
                # entry module ("import main"): the next run's entry file
                # holds that run's DIFFERENT source, so re-importing it at
                # restore time would execute that payload twice (once via
                # the import branch, once as __main__). And EXCEPT modules
                # living in the workspace ("import helper" for a restored
                # helper.py): unlike a site-packages library, re-importing
                # one at restore time replays ITS top-level side effects on
                # every continuation, and can bind the stale module before
                # the current payload replaces the file. Neither alias
                # carries.
                if isinstance(v, _ca_types.ModuleType):
                    name = getattr(v, '__name__', None)
                    mod_file = getattr(v, '__file__', None) or ''
                    if (isinstance(name, str) and name and name != _CA_ENTRY_MOD
                            and not mod_file.startswith('/mnt/data')):
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
                # Round-trip the blob in an environment shaped like the NEXT
                # run's restore: the scratch __main__ (stdlib-pickle path,
                # see above) and -- for BOTH picklers -- the entry module
                # blocked. A value whose class came from an ordinary
                # "import main" serializes BY REFERENCE through module
                # 'main' and passes a bare dumps because 'main' is
                # importable right now; at the next run's restore that
                # import would execute the NEW payload out of order (or
                # abort the whole stream if the class is gone). Setting
                # sys.modules['main'] = None makes the probe's import raise
                # WITHOUT executing the entry file, so such values are
                # dropped like any other non-portable value. (The alias
                # skip above covers module objects; this covers values that
                # merely reference the module.) Workspace modules get the
                # same treatment as the entry module -- see _ca_probe_block.
                # The dill path only pays for the loads when the blob can
                # actually name a blocked module -- a cheap bytes scan,
                # false positives just probe once.
                if _ca_probe_main is not None or any(_ca_bb in _ca_blob for _ca_bb in _ca_probe_block_bytes):
                    _ca_real_main = _ca_sys.modules.get('__main__')
                    _ca_saved_blocked = {}
                    for _ca_bn in _ca_probe_block:
                        _ca_saved_blocked[_ca_bn] = (_ca_bn in _ca_sys.modules, _ca_sys.modules.get(_ca_bn))
                        _ca_sys.modules[_ca_bn] = None
                    if _ca_probe_main is not None:
                        _ca_sys.modules['__main__'] = _ca_probe_main
                    try:
                        _ca_pk.loads(_ca_blob)
                    except Exception:
                        continue
                    finally:
                        if _ca_probe_main is not None:
                            _ca_sys.modules['__main__'] = _ca_real_main
                        for _ca_bn, (_ca_bhad, _ca_bmod) in _ca_saved_blocked.items():
                            if _ca_bhad:
                                _ca_sys.modules[_ca_bn] = _ca_bmod
                            else:
                                _ca_sys.modules.pop(_ca_bn, None)
                ok[k] = v
            try:
                tmp = _CA_STATE + '.tmp'
                # User code may have left a DIRECTORY at the pickle path or
                # its tmp sibling; open()/os.replace() would fail on those on
                # every later continuation too (the collision rides the
                # snapshot tar), permanently bricking variable persistence.
                # Clear non-file collisions first so the session recovers.
                # Symlinks can't appear here: the sandbox strips them from
                # the workspace before archiving and on restore.
                for _ca_c in (tmp, _CA_STATE):
                    if _ca_os.path.isdir(_ca_c):
                        _ca_shutil.rmtree(_ca_c, ignore_errors=True)
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
                # the same shape as a first run. rmtree handles a directory
                # planted at either path (os.remove can't), so the collision
                # never rides the snapshot even if it appeared mid-write.
                for stale in (tmp, _CA_STATE):
                    try:
                        _ca_os.remove(stale)
                    except IsADirectoryError:
                        _ca_shutil.rmtree(stale, ignore_errors=True)
                    except OSError:
                        pass

        # On disk the entry file currently holds THIS bootstrap wrapper, yet
        # __file__ advertises it as the user's own script: code reading its
        # own source (Path(__file__).read_text(), inspect on __main__) and
        # spawn-multiprocessing children (which runpy __main__.__file__)
        # would see base64 wrapper goo where the submitted source used to
        # be. Materialize the real source over the entry file for the run's
        # duration -- this wrapper is already fully compiled, the file is
        # not re-read by this process -- and put the wrapper bytes back at
        # exit, AFTER the state snapshot (atexit is LIFO; this registration
        # precedes the snapshot's), so the api-side output walker sees the
        # staged bytes unchanged and doesn't surface the entry file as a
        # generated output. Spawn children therefore exec the plain user
        # source exactly like vanilla Python -- which also means (as in
        # vanilla) a multiprocessing target must be defined by the CURRENT
        # run's source; a target existing only in the restored namespace no
        # longer resolves in children.
        _CA_ENTRY_PATH = '/mnt/data/__CA_ENTRY__'
        _ca_wrapper_bytes = None
        def _ca_restore_entry():
            if _ca_wrapper_bytes is None:
                return
            try:
                with open(_CA_ENTRY_PATH, 'wb') as f:
                    f.write(_ca_wrapper_bytes)
            except Exception:
                pass
        try:
            with open(_CA_ENTRY_PATH, 'rb') as _ca_f:
                _ca_wrapper_bytes = _ca_f.read()
            _ca_atexit.register(_ca_restore_entry)
            with open(_CA_ENTRY_PATH, 'w') as _ca_f:
                _ca_f.write(_CA_SRC)
        except Exception:
            # Entry unreadable/unwritable: __file__ then exposes the wrapper
            # (and children fall back to the __mp_main__ branch) -- never
            # fatal.
            _ca_wrapper_bytes = None

        def _ca_snapshot_pinned():
            # By snapshot time user code may have imported ITS OWN shadow of
            # a bootstrap dependency (that was the point of the eviction
            # above); pin the real set while dill probes/dumps, then put the
            # user's entries back. User atexit callbacks run before this one
            # (atexit is LIFO and this registration precedes user code), so
            # nothing user-visible executes during the pin window except
            # daemon threads, which are torn down mid-flight anyway.
            _ca_displaced = _ca_pin_hidden()
            try:
                _ca_snapshot()
            finally:
                _ca_unpin_hidden(_ca_displaced)

        _ca_atexit.register(_ca_snapshot_pinned)
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
            _ca_os.register_at_fork(after_in_child=lambda: (
                _ca_atexit.unregister(_ca_snapshot_pinned),
                # The child must not put the wrapper bytes back either -- it
                # would flip the entry file mid-parent-run; only the launch
                # process restores it, at its own exit.
                _ca_atexit.unregister(_ca_restore_entry),
            ))
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
    // Global: the entry placeholder appears twice (_CA_ENTRY_MOD and
    // __file__); a plain string .replace would leave the literal second one.
    .replace(/__CA_ENTRY__/g, entryFileName.replace(/[^A-Za-z0-9._-]/g, '_'))
    .replace('__USERCODE_B64__', b64);
}
