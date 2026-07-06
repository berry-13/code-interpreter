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
 * written to, and read back from the previous run's output session. Server-side
 * only, so it need not satisfy the client `isValidId` nanoid shape.
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
const PYTHON_SESSION_WRAPPER = String.raw`import sys as _ca_sys, os as _ca_os, atexit as _ca_atexit, base64 as _ca_b64, linecache as _ca_linecache, types as _ca_types, io as _ca_io
_CA_STATE = '/mnt/data/.session_state.pkl'
try:
    import dill as _ca_pk
except Exception:
    import pickle as _ca_pk

# Namespace the user code runs in. Presents as __main__ so the "if __name__ ==
# __main__" guard and the pyplot template behave as they do without persistence.
_ca_ns = {'__name__': '__main__', '__builtins__': __builtins__, '__file__': '/mnt/data/__CA_ENTRY__'}

if _ca_os.path.exists(_CA_STATE):
    try:
        with open(_CA_STATE, 'rb') as _ca_f:
            _ca_ns.update(_ca_pk.load(_ca_f))
        _ca_ns['__name__'] = '__main__'
    except Exception as _ca_e:
        print('[session] state restore skipped: %r' % (_ca_e,), file=_ca_sys.stderr)

def _ca_snapshot():
    ok = {}
    for k, v in list(_ca_ns.items()):
        if k.startswith('_'):
            continue
        # Skip modules and open file handles. dill CAN pickle a file handle,
        # but restoring one reopens the path in its original mode -- for a
        # write handle that TRUNCATES the user's file on the next run. Excluding
        # io objects keeps a leftover with-block file handle from wiping the
        # very file it wrote. (Sockets/threads/locks fail dumps below.)
        if isinstance(v, (_ca_types.ModuleType, _ca_io.IOBase)):
            continue
        try:
            _ca_pk.dumps(v)
        except Exception:
            continue
        ok[k] = v
    try:
        tmp = _CA_STATE + '.tmp'
        with open(tmp, 'wb') as f:
            _ca_pk.dump(ok, f)
        _ca_os.replace(tmp, _CA_STATE)
    except Exception as e:
        print('[session] state snapshot skipped: %r' % (e,), file=_ca_sys.stderr)

_ca_atexit.register(_ca_snapshot)

_CA_SRC = _ca_b64.b64decode('__USERCODE_B64__').decode('utf-8')
_ca_linecache.cache['<user_code>'] = (len(_CA_SRC), None, _CA_SRC.splitlines(True), '<user_code>')
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
