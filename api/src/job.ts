import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nanoid } from 'nanoid';
import * as crypto from 'crypto';
import * as semver from 'semver';
import * as fsp from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import type { Logger } from 'pino';
import type { NsJailResult } from './nsjail';
import type { Runtime } from './runtime';
import { logger as rootLogger } from './logger';
import { getRuntimes } from './runtime';
import { execute } from './nsjail';
import { config } from './config';
import { internalServiceHeaders } from './internal-service-auth';
import { EGRESS_GRANT_HEADER } from './egress';
import { injectTraceHeaders } from './telemetry';
import {
  applyReadOnlyInputPermissions,
  applySandboxPathPermissions,
  applySandboxPathPermissionsNoFollow,
  cleanupSandboxWorkspace,
  createSandboxWorkspace,
  currentUid,
  fallbackSandboxIdentity,
  retainWorkspaceCleanupUntilRemoved,
  sandboxJobUidPool,
  SANDBOX_WORKSPACE_MODE,
  type SandboxJobIdentity,
  type SandboxWorkspaceLease,
} from './workspace-isolation';
import {
  DIRKEEP,
  SANDBOX_DIR_MODE,
  SANDBOX_FILE_MODE,
  ValidationError,
  isDirkeep,
  isValidPathShape,
  validateFilePath,
  isValidFilePath,
} from './validation';

export {
  DIRKEEP,
  SANDBOX_DIR_MODE,
  SANDBOX_FILE_MODE,
  ValidationError,
  isDirkeep,
  checkPathShape,
  isValidPathShape,
  validateFilePath,
  isValidFilePath,
} from './validation';

const AUTO_LOAD_DIRKEEP_TIMEOUT_MS = 10000;

const execFileP = promisify(execFile);

/* Basenames the persistence layer manages under /mnt/data. MUST stay in sync
 * with SESSION_STATE_FILENAME / SESSION_STATE_TAR_FILENAME in
 * service/src/session-persist.ts (separate npm package -- cannot import). */
const SESSION_STATE_PKL_BASENAME = '.session_state.pkl';
const SESSION_STATE_TAR_BASENAME = 'session-workspace.tar';
/* Internal artifacts that never legitimately exist as user content -- the
 * pickle only ever lives at this exact path and is always excluded before
 * archiving/output. Deliberately excludes SESSION_STATE_TAR_BASENAME: unlike
 * the pickle, that name CAN collide with a real user-created file (the
 * persisted tar object itself is downloaded to a path outside submissionDir
 * and extracted -- its own filename never becomes a member inside the
 * archive it produces, so a file with this name in a restored workspace can
 * only be one the user's own code wrote). */
const SESSION_STATE_INTERNAL_BASENAMES = new Set([
  SESSION_STATE_PKL_BASENAME,
  `${SESSION_STATE_PKL_BASENAME}.tmp`,
]);
const RESERVED_SESSION_BASENAMES = new Set([
  ...SESSION_STATE_INTERNAL_BASENAMES,
  SESSION_STATE_TAR_BASENAME,
]);
/* Top-level runtime cache dirs pruned from a session snapshot (pip/matplotlib
 * scatter these under HOME=/mnt/data; they are not useful state). */
const SNAPSHOT_PRUNE_DIRS = ['.cache', '.config', '.npm', `${SESSION_STATE_PKL_BASENAME}.tmp`];

/* Checks every path segment, not just the basename: a name like
 * `.session_state.pkl/chunk` would otherwise pass as an ordinary input,
 * staging a directory at the reserved path that the Python wrapper then
 * can't replace with (or read as) the actual pickle file. */
function pathSegments(name: string): string[] {
  return name.replace(/\\/g, '/').split('/').filter(Boolean);
}

function isReservedSessionBasename(name: string): boolean {
  return pathSegments(name).some(segment => RESERVED_SESSION_BASENAMES.has(segment));
}

/** True for the internal pickle artifacts only -- never a legitimate restored
 *  user file, unlike SESSION_STATE_TAR_BASENAME (see comment above). */
function isSessionStateInternalBasename(name: string): boolean {
  return pathSegments(name).some(segment => SESSION_STATE_INTERNAL_BASENAMES.has(segment));
}

/**
 * Bridges a `fetch` response body to a Node-stream Readable. The types at the
 * module boundary (Node's `stream/web` vs. lib.dom) don't overlap cleanly,
 * hence the isolated cast; at runtime they're structurally compatible.
 */
function toNodeReadable(body: import('stream/web').ReadableStream | ReadableStream): Readable {
  return Readable.fromWeb(body as import('stream/web').ReadableStream);
}

/**
 * Aggregates extra pkgdirs for the bash runtime so bash scripts can shell out
 * to every other installed language. Walks all registered runtimes sorted by
 * (language, descending version) and picks the first pkgdir per language,
 * skipping the bash runtime's own pkgdir and any duplicates. Mutates
 * `envVars.PATH` in place to prepend each runtime's PATH entries without
 * re-introducing duplicates, so packaged runtimes win over base-image tools.
 *
 * Exported for unit testing — the mutation on `envVars` is observable.
 */
export function aggregateBashExtras(
  bashPkgdir: string,
  envVars: Record<string, string>,
  runtimes: readonly Runtime[] = getRuntimes(),
  linkTarget?: { nodeModulesPath?: string },
): string[] | undefined {
  const seenDirs = new Set<string>([bashPkgdir]);
  const seenLangs = new Set<string>();
  const seenPathEntries = new Set<string>(
    (envVars.PATH ?? '').split(':').filter(Boolean),
  );
  const seenNodePathEntries = new Set<string>(
    (envVars.NODE_PATH ?? '').split(':').filter(Boolean),
  );
  const pathSources: string[] = [];
  const nodePathSources: string[] = [];

  const sorted = [...runtimes].sort((a, b) =>
    a.language.localeCompare(b.language) || semver.rcompare(a.version, b.version),
  );

  let extraPkgdirs: string[] | undefined;
  for (const rt of sorted) {
    if (seenDirs.has(rt.pkgdir)) continue;
    if (seenLangs.has(rt.language)) continue;
    seenDirs.add(rt.pkgdir);
    seenLangs.add(rt.language);
    extraPkgdirs ??= [];
    extraPkgdirs.push(rt.pkgdir);
    collectDelimitedEnvEntries(rt.env_vars.PATH, pathSources, seenPathEntries);
    if (rt.env_vars.NODE_PATH) {
      if (rt.language === 'node' || rt.runtime === 'node') {
        nodePathSources.unshift(rt.env_vars.NODE_PATH);
      } else {
        nodePathSources.push(rt.env_vars.NODE_PATH);
      }
    }
  }
  prependDelimitedEnvEntries('PATH', pathSources, envVars);
  for (const source of nodePathSources) {
    if (linkTarget) rememberPreferredNodeModules(source, linkTarget);
    mergeDelimitedEnvEntries('NODE_PATH', source, envVars, seenNodePathEntries);
  }
  return extraPkgdirs;
}

function rememberPreferredNodeModules(
  source: string,
  linkTarget: { nodeModulesPath?: string },
): void {
  if (linkTarget.nodeModulesPath) return;
  const nodeModulesPath = source
    .split(':')
    .filter(Boolean)
    .find(entry => path.isAbsolute(entry) && path.basename(entry) === 'node_modules');
  if (nodeModulesPath) linkTarget.nodeModulesPath = nodeModulesPath;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

export function ensureNodeModulesSymlink(
  submissionDir: string,
  nodeModulesPath?: string,
): void {
  if (!nodeModulesPath) return;
  const linkPath = path.join(submissionDir, 'node_modules');
  try {
    fs.lstatSync(linkPath);
    return;
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err;
  }

  try {
    fs.symlinkSync(nodeModulesPath, linkPath, 'dir');
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err;
  }
}

/**
 * Extracts the on-disk filename from a Content-Disposition response header,
 * falling back to the request-supplied `file.name` (or `file.id` if no name
 * was provided). Pure; exported for unit testing.
 *
 * Matches RFC 5987 / 8187 `filename*=UTF-8''<percent-encoded>` first because
 * the file server emits that form for UTF-8-safe transport of arbitrary
 * names — including paths with `/` separators that the legacy `filename=`
 * form would mangle. Falls back to the legacy quoted (`filename="..."`) or
 * unquoted (`filename=...`) forms, each stopping at the closing quote or
 * the first whitespace/semicolon so trailing params like
 * `attachment; filename="foo.txt"; size=123` correctly yield `foo.txt`.
 */
export function resolveOriginalName(response: Response, file: TFile): string {
  const fallback = file.name || (file.id ?? '');
  const header = response.headers.get('content-disposition');
  if (!header) return fallback;

  const star = header.match(/filename\*=(?:UTF-8'[^']*')?([^;]+)/i);
  if (star) {
    const raw = star[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      /* Malformed percent-encoding (e.g. `%ZZ`) — fall through to the legacy
       * forms. The same header may emit both `filename*=` and a legacy
       * `filename=` per RFC 5987 §4.3, so a corrupt extended form should
       * not poison a valid fallback. */
    }
  }

  const match = header.match(/filename="([^"]+)"/i)
    ?? header.match(/filename=([^\s;]+)/i);
  return match ? match[1] : fallback;
}

/**
 * Type-guard factory for the file server's normalized-detail response. Only
 * accepts objects whose `storage_session_id` matches `sid` exactly, closing
 * the MinIO prefix-list leak where listing `abc` also returns keys under
 * `abcdef/`. Exported for unit testing.
 */
export function isNormalizedObjectForSession(
  sid: string,
): (o: unknown) => o is { id: string; name: string; storage_session_id: string } {
  return (o): o is { id: string; name: string; storage_session_id: string } => {
    if (!o || typeof o !== 'object') return false;
    const rec = o as Record<string, unknown>;
    if (typeof rec.id !== 'string') return false;
    if (typeof rec.name !== 'string') return false;
    if (typeof rec.storage_session_id !== 'string') return false;
    return rec.storage_session_id === sid;
  };
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight at once. Workers
 * pick the next index off a shared counter, so finished workers steal work
 * from busier ones rather than waiting for a fixed-size batch to drain.
 * Preserves input order in the result. Pure; exported for unit testing.
 *
 * Cap defensively at `items.length` and at 1 — a 0 or negative cap would
 * spawn no workers and the function would never resolve. A cap above the
 * input length wastes nothing but a few stale `>= length` comparisons.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: cap }, worker));
  return results;
}

/**
 * Extension → MIME map covering the file types that come out of code
 * execution on this sandbox: images, documents, plain text / config, code,
 * archives, audio/video, and a handful of byte-soup formats. Used for the
 * upload `Content-Type` header so the file-server stores the real media
 * type as object metadata and downloads round-trip with the right header
 * for inline rendering / handler dispatch on the LibreChat side.
 *
 * Hand-rolled rather than pulled from `mime-types` to keep the codeapi
 * dependency surface minimal — the receiving side is the file-server,
 * which only stores whatever string we send, so coverage of the long tail
 * isn't load-bearing. Anything not on this list falls back to
 * `application/octet-stream`.
 */
const MIME_TYPE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  // Images
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.tiff', 'image/tiff'],
  ['.tif', 'image/tiff'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.avif', 'image/avif'],
  // Documents
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.odp', 'application/vnd.oasis.opendocument.presentation'],
  // Text / structured text
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.rst', 'text/x-rst'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.xml', 'application/xml'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.toml', 'application/toml'],
  ['.ini', 'text/plain'],
  ['.conf', 'text/plain'],
  /* `.env` matches *.env files (e.g. `app.env`, `prod.env`) only.
   * `mimeTypeFor` treats the literal `.env` dotfile as having no extension
   * (`dot === 0` early-return) so it falls through to octet-stream — that's
   * intentional, since dotfile `.env` is conventionally a secrets file we
   * shouldn't auto-serve as text. */
  ['.env', 'text/plain'],
  // Code (text-typed; some prefer `text/x-<lang>` but `text/plain` is
  // safer for the file-server's download Content-Type since most browsers
  // treat unknown text/x-* as octet-stream anyway)
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.ts', 'text/x-typescript'],
  ['.tsx', 'text/x-typescript'],
  ['.jsx', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.rb', 'text/x-ruby'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.java', 'text/x-java'],
  ['.kt', 'text/x-kotlin'],
  ['.kts', 'text/x-kotlin'],
  ['.scala', 'text/x-scala'],
  ['.c', 'text/x-c'],
  ['.h', 'text/x-c'],
  ['.cpp', 'text/x-c++'],
  ['.cs', 'text/x-csharp'],
  ['.php', 'application/x-php'],
  ['.pl', 'text/x-perl'],
  ['.r', 'text/x-r'],
  ['.lua', 'text/x-lua'],
  ['.swift', 'text/x-swift'],
  ['.sh', 'application/x-sh'],
  ['.ps1', 'application/x-powershell'],
  ['.sql', 'application/sql'],
  // Archives
  ['.zip', 'application/zip'],
  ['.tar', 'application/x-tar'],
  ['.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.bz2', 'application/x-bzip2'],
  ['.xz', 'application/x-xz'],
  ['.7z', 'application/x-7z-compressed'],
  ['.rar', 'application/vnd.rar'],
  // Audio / video
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.mp4', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.avi', 'video/x-msvideo'],
  ['.webm', 'video/webm'],
  // Fonts
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  // Data formats
  ['.parquet', 'application/vnd.apache.parquet'],
  ['.bson', 'application/bson'],
  ['.wasm', 'application/wasm'],
]);

/**
 * Returns the registered MIME type for `filename` based on its extension,
 * falling back to `application/octet-stream`. Extension lookup uses the
 * basename so directory-name dots (e.g. `proj.v1/notes`) don't false-trigger.
 * Pure; exported for unit testing.
 */
export function mimeTypeFor(filename: string): string {
  const lastSep = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const basename = lastSep >= 0 ? filename.slice(lastSep + 1) : filename;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  const ext = basename.slice(dot).toLowerCase();
  return MIME_TYPE_BY_EXTENSION.get(ext) ?? 'application/octet-stream';
}

/**
 * True when `name` is a hidden-directory basename (starts with `.`). Excludes
 * `.` and `..` traversal markers, which `walkDir`'s readdir never emits but
 * are guarded here for defense in depth. Pure; exported for unit testing.
 */
export function isHiddenDirectory(name: string): boolean {
  if (name.length <= 1) return false;
  if (name === '..') return false;
  return name.startsWith('.');
}

/**
 * True when any explicit input file lives at or under `relativePath`. Used to
 * keep the hidden-directory filter from silently dropping a directory that
 * the user explicitly primed something into (e.g. an inherited `.config/foo`
 * input file). Pure; exported for unit testing.
 *
 * Accepts both `/` and the platform separator in the prefix check because
 * walkDir's `path.relative()` returns platform-separated paths while user
 * input file names typically arrive POSIX-normalized. Either combination
 * lights up the same input.
 */
export function inputsLiveUnder(
  inputByName: Map<string, TFile>,
  relativePath: string,
): boolean {
  const posixPrefix = relativePath.replace(/\\/g, '/') + '/';
  const nativePrefix = relativePath + path.sep;
  for (const key of inputByName.keys()) {
    if (key === relativePath) return true;
    const posixKey = key.replace(/\\/g, '/');
    if (posixKey.startsWith(posixPrefix)) return true;
    if (path.sep !== '/' && key.startsWith(nativePrefix)) return true;
  }
  return false;
}

/**
 * True when importing `markerName` would require its parent directory to
 * exist at a path where the current request already places a regular file.
 * Exported for unit testing.
 */
export function markerConflictsWithExplicitFile(
  markerName: string,
  explicitFilePaths: string[],
): boolean {
  const markerDir = path.dirname(markerName);
  if (markerDir === '' || markerDir === '.') return false;
  for (const p of explicitFilePaths) {
    if (p === markerDir) return true;
    if (markerDir.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * Extra tar bytes for a member whose stored path forces a long-name record, or
 * 0 when the path fits the header's name field. GNU tar (default `--format=gnu`,
 * as shipped) stores the full path in a 100-byte name field with NO ustar
 * prefix splitting, so any member name over 100 bytes -- INCLUDING the trailing
 * '/' GNU tar appends to directory members -- gets a preceding
 * `GNUTYPE_LONGNAME` ('L') record: a 512-byte header plus the path
 * (NUL-terminated) padded to a 512-byte boundary, right before the member's own
 * header. The `+16` margin also covers the marginally larger extended header a
 * POSIX/pax-format tar would emit for the same path (its `path=` record), so the
 * estimate never undercounts under either format.
 *
 * The size estimator MUST add this: a swarm of long-named files (e.g. many empty
 * files with ~120-byte basenames) or deeply nested paths would otherwise pass
 * the pre-archive cap while `tar -cf` still materializes a much larger archive
 * on runner disk before the post-archive size check rejects it.
 *
 * `storedName` must be the exact archive member name -- `./<rel>` for files and
 * symlinks, `./<rel>/` (trailing slash) for directories. Pure; exported for
 * unit testing.
 */
export function tarLongNameOverheadBytes(storedName: string): number {
  const len = Buffer.byteLength(storedName, 'utf8');
  if (len <= 100) return 0;
  return 512 + Math.ceil((len + 16) / 512) * 512;
}

function mergeDelimitedEnvEntries(
  key: string,
  source: string | undefined,
  envVars: Record<string, string>,
  seenEntries: Set<string>,
): void {
  if (!source) return;
  for (const entry of source.split(':')) {
    if (!entry) continue;
    if (seenEntries.has(entry)) continue;
    seenEntries.add(entry);
    envVars[key] = envVars[key] ? envVars[key] + ':' + entry : entry;
  }
}

function collectDelimitedEnvEntries(
  source: string | undefined,
  target: string[],
  seenEntries: Set<string>,
): void {
  if (!source) return;
  for (const entry of source.split(':')) {
    if (!entry) continue;
    if (seenEntries.has(entry)) continue;
    seenEntries.add(entry);
    target.push(entry);
  }
}

function prependDelimitedEnvEntries(
  key: string,
  entries: string[],
  envVars: Record<string, string>,
): void {
  if (entries.length === 0) return;
  const joinedEntries = entries.join(':');
  envVars[key] = envVars[key] ? joinedEntries + ':' + envVars[key] : joinedEntries;
}

/** Environment variables that must never be influenced by caller-supplied
 * `extra_env_vars`. Keys are compared upper-case. Prefixes cover loader-
 * sensitive variables (LD_*, DYLD_*) whose exhaustive enumeration isn't
 * practical. Hoisted to module scope so we don't rebuild the Set on every
 * `safeCall()` invocation. */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  'OPENBLAS_NUM_THREADS',
  'MKL_NUM_THREADS',
  'OMP_NUM_THREADS',
  'SANDBOX_LANGUAGE',
  'HOME',
  'PATH',
  'TOOL_CALL_SOCKET',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PYTHONEXECUTABLE',
  'PYTHONIOENCODING',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'IFS',
  'SHELLOPTS',
  'BASHOPTS',
  'GLIBC_TUNABLES',
  /** PTC replay history file path. The programmatic router sets this
   * internally to point at the submission-dir `_ptc_history.json`; a
   * direct `/v2/execute` caller could otherwise redirect the preamble
   * to an empty / attacker-controlled file and force the sandbox to
   * re-emit already-resolved tool calls. Defense-in-depth — the
   * programmatic router never populates `env_vars` from user input,
   * but the v2 endpoint surface is broader. */
  'PTC_HISTORY_PATH',
]);
export const RESERVED_ENV_PREFIXES: readonly string[] = ['LD_', 'DYLD_', 'PTC_'];

/** Filter a caller-supplied env-var map by the same rules `safeCall()`
 * applies before spreading into nsjail. Exposed for unit tests so the
 * blocklist can be exercised without spinning up a real Job. */
export function filterExtraEnvVars(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    const upperKey = key.toUpperCase();
    if (RESERVED_ENV_KEYS.has(upperKey)) continue;
    if (RESERVED_ENV_PREFIXES.some(p => upperKey.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.c', '.cs', '.cpp', '.go', '.java', '.js', '.kt', '.kts', '.lua',
  '.php', '.pl', '.ps1', '.py', '.r', '.rb', '.rs', '.scala', '.sh',
  '.sql', '.swift', '.ts', '.jsx', '.tsx', '.groovy',
  '.css', '.htm', '.html', '.less', '.sass', '.scss', '.svg', '.svelte', '.vue',
  '.adoc', '.asciidoc', '.md', '.rst', '.tex', '.txt', '.wiki',
  '.csv', '.json', '.bson', '.json5', '.jsonl', '.parquet', '.tsv',
  '.xml', '.yaml', '.yml',
  '.ics', '.ical', '.ifb', '.icalendar',
  '.conf', '.env', '.gitignore', '.ini', '.properties', '.toml',
  '.doc', '.docx', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx',
  '.odt', '.ods', '.odp', '.rtf',
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png',
  '.tif', '.tiff', '.webp',
  '.eot', '.ttf', '.woff', '.woff2',
  '.7z', '.bz2', '.gz', '.gzip', '.rar', '.tar', '.zip',
  '.tf', '.tfvars', '.tfstate', '.hcl',
  '.dockerfile', '.Dockerfile', '.dockerignore',
  '.helmignore', '.helmfile', '.jenkinsfile', '.vagrantfile',
  '.eslintrc', '.prettierrc', '.editorconfig', '.nomad',
  '.bat', '.cmd', '.deb', '.log', '.rpm', '.vbs',
]);

function isSupportedOutputFilename(name: string): boolean {
  const basename = path.basename(name);
  const ext = path.extname(basename).toLowerCase();
  const dottedBasename = `.${basename}`;
  return (
    (ext !== '' && SUPPORTED_EXTENSIONS.has(ext)) ||
    SUPPORTED_EXTENSIONS.has(basename) ||
    SUPPORTED_EXTENSIONS.has(basename.toLowerCase()) ||
    (ext === '' && (
      SUPPORTED_EXTENSIONS.has(dottedBasename) ||
      SUPPORTED_EXTENSIONS.has(dottedBasename.toLowerCase())
    ))
  );
}

export interface TFile {
  id?: string;
  /** Per-file storage session id (where the file's bytes live in object
   *  storage). Distinct from the top-level execution session of a `/exec`
   *  call — those are different concepts and were historically conflated. */
  storage_session_id?: string;
  name: string;
  content?: string;
  encoding?: 'base64' | 'hex' | 'utf8';
  /**
   * Per-file entity scope from the caller's authorization model. Carried
   * through the worker so it can be echoed back on `inherited: true`
   * output refs — the caller relies on the round-trip to preserve the
   * scope across multi-turn sessions.
   */
  entity_id?: string;
}

interface FileRef {
  id: string;
  name: string;
  /** Per-file storage session id (where the bytes live). */
  storage_session_id: string;
  modified_from?: { id: string; storage_session_id: string };
  /**
   * `true` when this ref is an unchanged passthrough of an input the caller
   * already owns (downloaded inputs, inherited `.dirkeep` markers). Surfaced
   * so callers can skip post-processing — re-downloading a skill- or
   * entity-scoped input with the end-user's session key 403s, and is pure
   * waste regardless: the file is already persisted at its origin.
   */
  inherited?: true;
  /**
   * Echoed verbatim from the matching input `TFile` when present. Lets
   * callers preserve per-file entity scope across multi-turn sessions
   * without defensive carry-forward logic on their side.
   */
  entity_id?: string;
}

interface GeneratedFile {
  id: string;
  name: string;
  path: string;
}

interface InputFileInfo {
  originalId?: string;
  originalSessionId?: string;
  hash: string;
  path: string;
  /**
   * Mirrors the file-server `X-Read-Only` flag captured at download time.
   * When set, the walker MUST emit this input as inherited (preserving the
   * caller's original id/session_id) regardless of whether sandboxed code
   * modified the bytes on disk — the file is infrastructure (e.g. a skill
   * file) and modifications are not surfaced as artifacts to the client.
   */
  readOnly?: boolean;
  /**
   * Set for files materialized by a persistent-session restore (not part of
   * this request's inputs). Unchanged restored files are skipped by the output
   * walker -- they are internal session state carried in the snapshot tar, not
   * user-facing artifacts -- so they never consume a max_output_files slot and
   * crowd out a genuinely new output. A restored file the run MODIFIES is
   * treated as a normal generated output.
   */
  restored?: boolean;
  /**
   * Set for files staged from inline payload content (the wrapped entry
   * source -- main.py / main.ts / script.sh -- and anything else the service
   * sends by value rather than by id). These are run infrastructure, never
   * user state: persistSessionState prunes them from the session snapshot so
   * one run's wrapper source can't masquerade as a carried-over user file.
   */
  staged?: boolean;
}

interface ExecuteResult {
  compile?: NsJailResult;
  run?: NsJailResult;
  language: string;
  version: string;
  /** Top-level execution session id (one sandbox `/exec` invocation). */
  session_id: string;
  files: FileRef[];
  /** True when a fresh workspace snapshot was written for a persistent session. */
  session_state_persisted?: boolean;
  /** True when a prior snapshot was expected but could not be restored this
   *  run (missing/corrupt object). The service must NOT refresh the session
   *  pointer's TTL in that case -- see the router's refresh branch. */
  session_state_restore_failed?: boolean;
}

const jobQueue: Array<() => void> = [];

async function acquireJobIdentity(log: Logger): Promise<SandboxJobIdentity> {
  for (;;) {
    const identity = sandboxJobUidPool.acquire();
    if (identity) return identity;
    log.info('Awaiting job slot');
    await new Promise<void>(resolve => { jobQueue.push(resolve); });
  }
}

function releaseJobIdentity(identity: SandboxJobIdentity): void {
  sandboxJobUidPool.release(identity);
  const next = jobQueue.shift();
  if (next) next();
}

export class Job {
  uuid: string;
  runtime: Runtime;
  files: TFile[];
  args: string[];
  stdin: string;
  timeouts: { run: number; compile: number };
  cpu_times: { run: number; compile: number };
  memory_limits: { run: number; compile: number };
  extra_env_vars?: Record<string, string>;
  egressGrantToken?: string;
  toolCallSocketEnabled: boolean;
  isSynthetic: boolean;
  outputSessionId: string;

  private log: Logger;
  private submissionDir = '';
  private workspaceLease: SandboxWorkspaceLease | undefined;
  private jobIdentity: SandboxJobIdentity | undefined;
  private generatedFiles: GeneratedFile[] = [];
  private sessionFiles: FileRef[] = [];
  private inheritedRefs: FileRef[] = [];
  private inputFileHashes = new Map<string, InputFileInfo>();
  private entryPointName: string | undefined;
  private chmoddedDirs = new Set<string>();
  /** Serializes parent-dir preparation across parallel fileOps -- see
   *  prepareParentDir. */
  private dirPrepChain: Promise<void> = Promise.resolve();
  private persistSession: { file_id: string; filename: string; restore_session_id?: string } | undefined;
  /** A prior snapshot existed but could not be restored this run; gates
   *  persistSessionState() so the resulting cold workspace never supersedes
   *  (and deletes) the session's last good snapshot. */
  private sessionRestoreFailed = false;
  /** Identity (inode + mtime) of the restored `.session_state.pkl` right
   *  after extraction, if one was present. persistSessionState compares
   *  against it to detect a Python run whose atexit snapshot never fired. */
  private restoredPickleStat: { ino: number; mtimeMs: number } | undefined;
  /** Set when this run's workspace was degraded by infrastructure failure
   *  (e.g. a restored carry-over was discarded because its replacement input
   *  failed to download). Unlike sessionRestoreFailed the restore itself
   *  succeeded, but persisting would promote the degraded tree and delete
   *  files the last good snapshot still holds. */
  private sessionPersistBlocked = false;

  constructor(opts: {
    /** Top-level execution session id. Becomes `Job.uuid` and is the id
     *  used to address an in-flight execution. Distinct from per-file
     *  `storage_session_id`. */
    session_id?: string | null;
    runtime: Runtime;
    files: TFile[];
    args: string[];
    stdin: string;
    timeouts: { run: number; compile: number };
    cpu_times: { run: number; compile: number };
    memory_limits: { run: number; compile: number };
    extra_env_vars?: Record<string, string>;
    output_session_id?: string;
    egress_grant?: string;
    tool_call_socket_enabled?: boolean;
    is_synthetic?: boolean;
    persist_session?: { file_id: string; filename: string; restore_session_id?: string };
  }) {
    this.uuid = opts.session_id ?? nanoid();
    this.outputSessionId = opts.output_session_id ?? this.uuid;
    this.log = rootLogger.child({ job: this.uuid });
    this.runtime = opts.runtime;
    this.files = opts.files.map((file, i) => ({
      id: file.id,
      /* When the input doesn't carry a per-file storage id (e.g. inline
       * source supplied as `content`), fall back to the execution id —
       * historically these collapsed onto the same `session_id` field
       * which is exactly the conflation this rename eliminates. */
      storage_session_id: file.storage_session_id ?? this.outputSessionId,
      name: file.name || `file${i}.code`,
      content: file.content,
      encoding: (['base64', 'hex', 'utf8'] as const).includes(file.encoding as 'base64' | 'hex' | 'utf8')
        ? file.encoding
        : 'utf8',
      /* Carry `entity_id` forward so `tryEchoUnchangedInput` and
       * `echoInheritedKeep` can preserve it on inherited refs. The
       * explicit field selection above drops everything not named —
       * without this line the entity_id arrives on the request body
       * but is invisible by the time the walker echoes inputs back. */
      entity_id: file.entity_id,
    }));
    this.args = opts.args;
    this.stdin = opts.stdin.endsWith('\n') ? opts.stdin : opts.stdin + '\n';
    this.timeouts = opts.timeouts;
    this.cpu_times = opts.cpu_times;
    this.memory_limits = opts.memory_limits;
    this.extra_env_vars = opts.extra_env_vars;
    this.egressGrantToken = opts.egress_grant;
    this.toolCallSocketEnabled = opts.tool_call_socket_enabled === true;
    this.isSynthetic = opts.is_synthetic === true;
    this.persistSession = opts.persist_session;
  }

  async computeFileHash(filePath: string, noFollow = false): Promise<string> {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, noFollow
      ? { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }
      : undefined);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  /**
   * True when no further walkDir traversal can contribute to the final
   * response. Only short-circuits when `generatedFiles` is at the cap:
   * generated entries take priority in `handleSessionFiles`, so once they
   * fill every slot the inherited back-fill contributes zero.
   *
   * We intentionally do NOT stop when `inheritedRefs` alone hits the cap —
   * doing so would let directory iteration order silently drop real generated
   * outputs that haven't been walked yet (inherited refs would claim slots
   * that generated files would otherwise displace). Each `inheritedRefs.push`
   * site already guards against its own unbounded growth.
   */
  private isOutputCapFull(): boolean {
    return this.generatedFiles.length >= config.max_output_files;
  }

  private sandboxIdentity(): SandboxJobIdentity {
    return this.jobIdentity ?? fallbackSandboxIdentity();
  }

  private async applySandboxFilePermissions(filePath: string, noFollow = false): Promise<void> {
    if (noFollow) {
      await applySandboxPathPermissionsNoFollow(filePath, this.sandboxIdentity(), SANDBOX_FILE_MODE, 'file');
      return;
    }
    await applySandboxPathPermissions(filePath, this.sandboxIdentity(), SANDBOX_FILE_MODE);
  }

  /**
   * Chown/chmod every directory between submissionDir (exclusive) and `leaf`
   * (inclusive) so the per-job outside UID can create siblings/children while
   * escaped sibling UIDs cannot traverse the workspace tree.
   */
  private async secureAncestors(leaf: string): Promise<void> {
    const rel = path.relative(this.submissionDir, leaf);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep)) return;
    const parts = rel.split(path.sep).filter(Boolean);
    let cursor = this.submissionDir;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      /* Parallel downloads under shared parent dirs call into this method
       * concurrently. Skip paths we've already chmodded to avoid N*M redundant
       * syscalls (N files × M shared ancestors). */
      if (this.chmoddedDirs.has(cursor)) continue;
      await applySandboxPathPermissions(cursor, this.sandboxIdentity(), SANDBOX_DIR_MODE);
      this.chmoddedDirs.add(cursor);
    }
  }

  async prime(): Promise<void> {
    this.jobIdentity = await acquireJobIdentity(this.log);
    this.workspaceLease = await createSandboxWorkspace(this.jobIdentity);
    this.submissionDir = this.workspaceLease.dir;

    if (!this.isSynthetic) {
      this.log.info(
        {
          submissionDir: this.submissionDir,
          workspaceId: this.workspaceLease.workspaceId,
          uid: this.jobIdentity.uid,
          gid: this.jobIdentity.gid,
        },
        'Priming job',
      );
    }

    /* Restore a prior persistent-session workspace before any current-run
     * files are written, so fresh code/inputs overwrite stale copies from the
     * snapshot. Pulls its synthetic input file out of `this.files` so the
     * normal download/dirkeep flow below never sees it. Best-effort: a miss or
     * failure just means the session starts empty. */
    if (this.persistSession) {
      await this.restoreSessionWorkspace();
    }

    if (this.fileEgressBaseUrl() && this.files.some(f => f.id && f.storage_session_id)) {
      await this.autoLoadDirkeep();
    }

    // Reject a request whose own inputs conflict as file-vs-directory (`data`
    // alongside `data/a.csv`): a path cannot be both, so staging one would
    // have to destroy the other, and with parallel fileOps WHICH one survives
    // would be timing-dependent -- the job would proceed with a requested
    // input silently missing. Checked after autoLoadDirkeep so synthetic
    // inherited markers are policed by the same rule. (Content-Disposition
    // renames can still mint a conflict mid-staging; clearNonDirectoryAncestors
    // and clearNonRegularCollision reject those instead of silently deleting.)
    const stagedNames = new Set(
      this.files.filter(f => f.id || f.content !== undefined).map(f => f.name),
    );
    for (const name of stagedNames) {
      const segments = name.split('/').filter(Boolean);
      for (let i = 1; i < segments.length; i++) {
        const ancestor = segments.slice(0, i).join('/');
        if (stagedNames.has(ancestor)) {
          throw new ValidationError(`input '${name}' conflicts with input '${ancestor}' (file vs directory at the same path)`);
        }
      }
    }

    const fileOps: Promise<void>[] = [];
    for (const file of this.files) {
      if (file.id) {
        fileOps.push(this.downloadAndWriteFile(file).then(() => {}));
      } else if (file.content !== undefined) {
        fileOps.push(this.writeFile(file));
      }
    }
    await Promise.all(fileOps);
  }

  private fileEgressBaseUrl(): string {
    return config.egress_gateway_url || config.file_server_url;
  }

  private fileEgressHeaders(headers: Record<string, string> = {}): Record<string, string> {
    if (!config.egress_gateway_url) {
      return injectTraceHeaders(internalServiceHeaders(headers));
    }
    if (!this.egressGrantToken) {
      throw new Error('EGRESS_GATEWAY_URL is configured but the sandbox request has no egress grant');
    }
    return injectTraceHeaders({
      ...headers,
      [EGRESS_GRANT_HEADER]: this.egressGrantToken,
    });
  }

  private async autoLoadDirkeep(): Promise<void> {
    const sessionIds = new Set(
      this.files.filter(f => f.id && f.storage_session_id).map(f => f.storage_session_id!),
    );
    const existingNames = new Set(this.files.map(f => f.name));
    const explicitFilePaths = this.files
      .filter(f => !isDirkeep(f.name))
      .map(f => f.name);

    const fetches = Array.from(sessionIds).map(sid => this.fetchSessionMarkers(sid));
    const results = await Promise.all(fetches);

    let added = 0;
    let hitCap = false;
    for (const objects of results) {
      for (const obj of objects) {
        if (added >= config.max_output_files) { hitCap = true; break; }
        if (this.tryRegisterInheritedMarker(obj, existingNames, explicitFilePaths)) added++;
      }
      if (hitCap) break;
    }
    if (hitCap) {
      this.log.warn(
        { added, cap: config.max_output_files },
        'autoLoadDirkeep: hit marker cap; some inherited empty directories will not be restored',
      );
    }
  }

  /**
   * Fetches normalized objects for one inherited session and returns the
   * `.dirkeep` markers belonging to exactly that session. Guards against:
   *   - non-OK responses (empty list, no throw)
   *   - non-array JSON bodies
   *   - missing/malformed id/name/storage_session_id fields
   *   - MinIO prefix-list leakage (`abc` prefix also matches `abcdef/...`)
   *     by requiring `storage_session_id === sid`.
   */
  private async fetchSessionMarkers(
    sid: string,
  ): Promise<Array<{ id: string; name: string; storage_session_id: string }>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTO_LOAD_DIRKEEP_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${this.fileEgressBaseUrl()}/sessions/${encodeURIComponent(sid)}/objects?detail=normalized`,
        {
          headers: this.fileEgressHeaders(),
          signal: controller.signal,
        },
      );
      if (!res.ok) return [];
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return [];
      return data.filter(isNormalizedObjectForSession(sid));
    } catch (err) {
      this.log.warn({ sessionId: sid, err }, 'Failed to auto-load .dirkeep markers');
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Decides whether a normalized marker object is accepted into `this.files`
   * for the current prime() run. Returns `true` when the marker was pushed,
   * `false` when it was filtered out. Filters (in order): wrong basename,
   * duplicate name, invalid/traversing path, conflict with explicit file.
   */
  private tryRegisterInheritedMarker(
    obj: { id: string; name: string; storage_session_id: string },
    existingNames: Set<string>,
    explicitFilePaths: string[],
  ): boolean {
    if (!isDirkeep(obj.name)) return false;
    if (existingNames.has(obj.name)) return false;
    if (!isValidFilePath(obj.name, this.submissionDir)) {
      this.log.warn(
        { sessionId: obj.storage_session_id, name: obj.name },
        'autoLoadDirkeep: rejected marker with invalid or traversing path',
      );
      return false;
    }
    if (markerConflictsWithExplicitFile(obj.name, explicitFilePaths)) {
      this.log.debug(
        { sessionId: obj.storage_session_id, name: obj.name },
        'autoLoadDirkeep: skipping marker that conflicts with explicit request file',
      );
      return false;
    }
    this.files.push({ id: obj.id, storage_session_id: obj.storage_session_id, name: obj.name });
    existingNames.add(obj.name);
    return true;
  }

  async downloadAndWriteFile(file: TFile, maxRetries = 5, retryDelay = 500): Promise<string | null> {
    if (!file.id || !file.storage_session_id) return null;

    validateFilePath(file.name, this.submissionDir);

    const tempPath = path.join(this.submissionDir, `.tmp-${nanoid()}`);

    let lastError: Error | null = null;
    // The on-disk name can come from Content-Disposition and differ from
    // `file.name`. Remember the last one a (possibly failed) attempt
    // resolved, so the stale-restored-file cleanup below can also discard a
    // carry-over sitting at THAT path -- discarding only `file.name` would
    // leave a restored file at the resolved name and silently serve stale
    // bytes when every attempt fails after headers.
    let lastResolvedName: string | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(this.buildDownloadUrl(file), {
          headers: this.fileEgressHeaders(),
        });

        if (response.status === 404 && attempt < maxRetries) {
          const delay = retryDelay * Math.pow(2, attempt - 1);
          this.log.info({ fileId: file.id, attempt, maxRetries, delay }, 'File not found, retrying');
          await sleep(delay);
          continue;
        }

        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

        const originalName = resolveOriginalName(response, file);
        validateFilePath(originalName, this.submissionDir);
        // The router reserves these names by RequestFile.name, but the on-disk
        // name comes from Content-Disposition here -- so a file sent under a
        // harmless name could still land on a reserved basename and shadow
        // restored state. Reject it (the injected state file is already spliced
        // out before this runs, so this only ever sees user inputs).
        if (this.persistSession && isReservedSessionBasename(originalName)) {
          throw new ValidationError(`input resolves to reserved session filename '${originalName}'`);
        }
        lastResolvedName = originalName;
        const finalPath = path.join(this.submissionDir, originalName);
        await this.prepareParentDir(path.dirname(finalPath));

        const hash = await this.streamToDisk(response, tempPath, finalPath);
        const readOnly = response.headers.get('x-read-only')?.toLowerCase() === 'true';
        this.inputFileHashes.set(originalName, {
          originalId: file.id,
          originalSessionId: file.storage_session_id!,
          hash,
          path: finalPath,
          readOnly: readOnly || undefined,
        });
        /* Defense-in-depth: keep read-only inputs root-owned + 0444 so the
         * sandbox UID can read them but cannot chmod them back to writable. */
        if (readOnly) {
          try {
            await applyReadOnlyInputPermissions(finalPath);
          } catch (err) {
            this.log.warn({ file: originalName, err }, 'Failed to chmod read-only input');
          }
        }

        /* Keep the in-memory TFile in sync with the on-disk name so that
         * inputByName lookups in handleSessionFiles match walkDir's
         * path.relative() output. Otherwise a Content-Disposition override
         * would leave file.name pointing at the client-submitted name while
         * the file lives under originalName on disk. */
        if (originalName !== file.name) file.name = originalName;

        this.log.info({ file: originalName, hash: hash.substring(0, 8) }, 'Downloaded file');
        return originalName;
      } catch (error: unknown) {
        /* ValidationError is deterministic — a bad Content-Disposition
         * filename will fail identically on every retry. Abort fast
         * (cleanup + rethrow) instead of burning ~7.5s on exponential
         * backoff and surfacing the error as a generic download failure. */
        if (error instanceof ValidationError) {
          try { await fsp.unlink(tempPath); } catch { /* may not exist */ }
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          const delay = retryDelay * Math.pow(2, attempt - 1);
          this.log.warn({ fileId: file.id, attempt, maxRetries, delay, err: lastError }, 'Download failed, retrying');
          await sleep(delay);
        }
      }
    }

    this.log.error({ fileId: file.id, maxRetries, err: lastError }, 'Failed to download file');
    try { await fsp.unlink(tempPath); } catch { /* may not exist */ }
    // A persistent-session restore stages carry-over files BEFORE current inputs
    // download. If this input was meant to replace a restored file at the same
    // path but the download failed (expired/transient 404), leaving the restored
    // copy in place would silently run the sandbox against stale bytes. Drop the
    // stale carry-over + its baseline so user code sees the input as missing --
    // at the requested name AND at the Content-Disposition-resolved name a
    // failed attempt got far enough to see.
    let discardedRestored = await this.discardStaleRestoredInput(file.name);
    if (lastResolvedName && lastResolvedName !== file.name) {
      discardedRestored = (await this.discardStaleRestoredInput(lastResolvedName)) || discardedRestored;
    }
    if (discardedRestored) {
      // The last good snapshot still holds the file we just discarded.
      // Persisting this run would archive the deletion and CAS the pointer
      // forward, permanently losing that file to a transient fetch failure --
      // block persistence so the next run restores it and retries the input.
      this.sessionPersistBlocked = true;
      this.log.warn({ file: file.name }, 'Discarded restored carry-over after failed download; blocking session persist');
    }
    return null;
  }

  /**
   * On a failed input download, remove a restored persistent-session file (or
   * directory) left at the same path (and its output-walk baseline) so the run
   * doesn't observe stale bytes in place of the current, unavailable input.
   * No-op unless the path was a restored carry-over. Returns whether anything
   * restored was actually discarded -- the caller must then block persistence
   * for this run (see sessionPersistBlocked).
   */
  private async discardStaleRestoredInput(name: string): Promise<boolean> {
    const info = this.inputFileHashes.get(name);
    if (info?.restored && info.path) {
      try {
        await fsp.rm(info.path, { force: true });
      } catch (err) {
        this.log.warn({ file: name, err }, 'Failed to remove stale restored input after download failure');
      }
      this.inputFileHashes.delete(name);
      return true;
    }
    // `name` itself has no restored entry, but a restored FILE at one of its
    // ancestor path segments would block it just the same (e.g. a prior run
    // left `data` as a file and this request supplies `data/file.csv`).
    // registerRestoredBaseline only gives leaf files their own entry -- a
    // directory never gets one -- so any ancestor segment present in the map
    // is necessarily a restored non-directory.
    const segments = name.split('/').filter(Boolean);
    for (let i = segments.length - 1; i > 0; i--) {
      const ancestor = segments.slice(0, i).join('/');
      const ancestorInfo = this.inputFileHashes.get(ancestor);
      if (ancestorInfo?.restored && ancestorInfo.path) {
        try {
          await fsp.rm(ancestorInfo.path, { force: true });
        } catch (err) {
          this.log.warn({ file: ancestor, err }, 'Failed to remove stale restored ancestor after download failure');
        }
        this.inputFileHashes.delete(ancestor);
        return true;
      }
    }
    // registerRestoredBaseline recurses into restored directories and keys each
    // leaf file by its relative path -- the directory itself never gets its own
    // `inputFileHashes` entry. Detect that case via a RESTORED child under
    // `name/` (a child alone proves nothing: a Content-Disposition rename can
    // land a CURRENT-run input below this name, and treating that as "restored
    // directory" would delete the sibling this request just staged). Remove
    // only the restored children themselves -- never the whole tree, which may
    // hold current-run inputs -- then reap the directory only if that left it
    // empty.
    const prefix = `${name}/`;
    let discarded = false;
    for (const [key, info] of [...this.inputFileHashes.entries()]) {
      if (!key.startsWith(prefix) || !info.restored || !info.path) continue;
      try {
        await fsp.rm(info.path, { force: true });
      } catch (err) {
        this.log.warn({ file: key, err }, 'Failed to remove stale restored child after download failure');
      }
      this.inputFileHashes.delete(key);
      discarded = true;
    }
    if (!discarded) return false;
    // Non-recursive by design: succeeds only when nothing current remains.
    await fsp.rmdir(path.join(this.submissionDir, name)).catch(() => { /* still holds current inputs or subdirs */ });
    return true;
  }

  /**
   * URL for fetching a single object from the file server. Encodes path
   * segments — client-supplied storage_session_id / file.id could otherwise
   * inject `../` or raw `/` and hit unintended endpoints (SSRF-adjacent).
   */
  private buildDownloadUrl(file: TFile): string {
    return `${this.fileEgressBaseUrl()}/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`;
  }

  /**
   * Restore a prior persistent-session workspace tar into `submissionDir`.
   *
   * The service injects the previous run's snapshot as a synthetic input file
   * (name === `persist_session.filename`, carrying an id + the previous output
   * session as `storage_session_id`, so it is authorized by the grant's
   * `read_sessions`/`input_files`). We fetch it to a scratch tar, size-check it,
   * extract into `submissionDir`, and chown the tree to the job UID. Every
   * failure mode is non-fatal — a persistent session that can't restore simply
   * starts empty, exactly like its first run.
   */
  private async restoreSessionWorkspace(): Promise<void> {
    const ps = this.persistSession;
    // Only attempt a restore when the service marked one (a prior snapshot
    // exists). The injected state file is matched by name: the egress layer
    // masks file id/session into opaque handles before the sandbox sees them,
    // so name is the only stable field. This is safe because the service
    // rejects user input files named like the state tar, so the only file with
    // this name is the one it injected.
    if (!ps || !ps.restore_session_id) return; // first run: nothing to restore
    const idx = this.files.findIndex(f => f.id && f.storage_session_id && f.name === ps.filename);
    if (idx < 0) {
      // The service marked a restore but no injected state file made it here
      // -- something upstream dropped it. Same stance as every other restore
      // failure below: run empty, but don't let this cold run's persist
      // supersede (and delete) a snapshot that may still be perfectly live.
      this.sessionRestoreFailed = true;
      this.log.warn('Restore expected but no injected prior-state file found; skipping persist');
      return;
    }
    const [restoreFile] = this.files.splice(idx, 1);

    const tmpTar = path.join(os.tmpdir(), `sess-restore-${nanoid()}.tar`);
    try {
      const fetched = await this.downloadObjectToPath(restoreFile, tmpTar, config.session_state_max_bytes);
      if (!fetched) {
        // 404/miss. The run starts empty per contract, but this is still a
        // FAILED restore: the pointer may well still name a live snapshot (a
        // transient file-server miss looks identical to true deletion from
        // here). Persisting this cold run would CAS-advance the pointer over
        // the last good snapshot and delete it, so gate persistence exactly
        // like the catch below and let the next run retry.
        this.sessionRestoreFailed = true;
        this.log.warn('Prior session snapshot missing (404/miss); starting empty and skipping persist');
        return;
      }
      const { size } = await fsp.stat(tmpTar);
      // GNU tar strips leading `/` and `..` members by default, so extraction
      // stays confined to `-C submissionDir`. `--no-same-owner` keeps the
      // extracted files owned by the runner until we chown them to the job UID.
      await execFileP('tar', ['--no-same-owner', '--no-same-permissions', '-xf', tmpTar, '-C', this.submissionDir]);
      // Strip any symlinks the archive recreated BEFORE prime() stages fresh
      // source/input files. A prior run could leave e.g. `main.py -> /host/path`;
      // without this the runner's writeFile() would follow it and write
      // attacker-controlled content outside the workspace. Restored state has no
      // legitimate need for symlinks, so we drop them unconditionally.
      await this.stripSymlinks(this.submissionDir);
      const chownApplied = await this.chownTreeToJobUid(this.submissionDir);
      // tar --no-same-permissions only umasks archived modes; it never ADDS
      // access, so a prior run's `chmod 000` on any dir/file survives extraction
      // and, now owned by the job UID, is still untraversable/unreadable --
      // bricking restored state. `u+rwX` grants the owner read/write on files
      // and traverse on dirs (and preserves existing execute bits) across the
      // whole tree, and the root gets its exact canonical workspace mode.
      await this.normalizeRestoredModes(this.submissionDir, chownApplied);
      await applySandboxPathPermissions(this.submissionDir, this.sandboxIdentity(), SANDBOX_WORKSPACE_MODE);
      // Record restored files as input baselines so handleSessionFiles treats
      // unchanged carry-overs as inherited, not freshly generated outputs --
      // otherwise a session with many restored files would exhaust
      // max_output_files before a new plot/report and drop it from the response.
      await this.registerRestoredBaseline(this.submissionDir);
      // Fingerprint the restored namespace pickle (if any) so persist time
      // can tell whether THIS run's wrapper actually rewrote it -- see the
      // atexit-bypass gate in persistSessionState. The chown/chmod passes
      // above touch neither inode nor mtime, so the identity is stable.
      const pklStat = await fsp
        .lstat(path.join(this.submissionDir, SESSION_STATE_PKL_BASENAME))
        .catch(() => null);
      if (pklStat?.isFile()) {
        this.restoredPickleStat = { ino: pklStat.ino, mtimeMs: pklStat.mtimeMs };
      }
      this.log.info({ size }, 'Restored persisted session workspace');
    } catch (err) {
      // Documented contract is "start empty on restore failure". A corrupt or
      // truncated tar can leave a partial tree, so wipe it rather than run
      // against a mix of stale-and-missing files. Mark the failure too: this
      // run now executes against a cold workspace, and letting it persist
      // would CAS the session pointer forward and delete the last good
      // snapshot -- one transient fetch/extract blip would permanently reset
      // the session. Skipping persistence leaves the pointer untouched so
      // the next run retries the restore.
      this.sessionRestoreFailed = true;
      this.log.warn({ err }, 'Session restore failed; starting empty');
      await this.emptyDirContents(this.submissionDir);
    } finally {
      await fsp.rm(tmpTar, { force: true }).catch(() => { /* best effort */ });
    }
  }

  /** Remove everything inside `dir` (but keep `dir` itself). */
  private async emptyDirContents(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }

  /**
   * Hash restored files into `inputFileHashes` so the output walker sees them as
   * pre-existing inputs. Skips reserved session artifacts (never user outputs)
   * and `.dirkeep` markers. Best-effort per file.
   */
  private async registerRestoredBaseline(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // classifyDirent falls back to lstat on DT_UNKNOWN (some NFS/FUSE/
      // overlay mounts). Without it, both isDirectory() and isFile() report
      // false for such an entry, so nothing would be baselined and every
      // unchanged carry-over (and .dirkeep marker) would later be walked as
      // a fresh output, exhausting max_output_files ahead of real artifacts.
      const kind = await this.classifyDirent(entry, full, path.relative(this.submissionDir, full));
      if (kind === 'dir') {
        await this.registerRestoredBaseline(full);
        continue;
      }
      if (kind !== 'file') continue;
      // Only the internal pickle artifacts are skipped here -- they never
      // legitimately exist as restored user content. `.dirkeep` markers ARE
      // baselined (unlike other skips): a restored empty dir is represented
      // only by its marker, so without a baseline the output walk would
      // regenerate it as a fresh file and let carried-over empty dirs crowd
      // out real artifacts. A restored file that happens to be named like the
      // internal tar (SESSION_STATE_TAR_BASENAME) is baselined too, for the
      // same reason -- that name can only reach here via the user's own code
      // (see the constant's comment), so treating it as reserved would starve
      // it of a baseline and make the output walk re-flag it as "new" (and
      // consume a max_output_files slot) on every subsequent run forever.
      if (isSessionStateInternalBasename(entry.name)) continue;
      const rel = path.relative(this.submissionDir, full);
      try {
        const hash = await this.computeFileHash(full);
        this.inputFileHashes.set(rel, { hash, path: full, restored: true });
      } catch { /* unreadable mid-walk; skip */ }
    }
  }

  /**
   * Snapshot `submissionDir` (files + the dill namespace pickle the Python
   * wrapper wrote) to a tar and upload it to `output_session_id/<file_id>`,
   * which is the single session the egress grant authorizes for writes. The
   * service later promotes this into the `sessionstate:<sessionKey>` Redis
   * pointer. Returns whether a fresh snapshot was actually written; a skip
   * (failed restore / oversize / no storage / error) is non-fatal and leaves
   * the prior snapshot as the session's last good state.
   */
  /** True when a prior snapshot was expected but could not be restored this
   *  run. Reported to the service so it does not refresh the (possibly dead)
   *  pointer's TTL -- see the router's refresh branch. */
  sessionRestoreDidFail(): boolean {
    return this.sessionRestoreFailed;
  }

  async persistSessionState(): Promise<boolean> {
    const ps = this.persistSession;
    if (!ps || !this.submissionDir || !this.fileEgressBaseUrl()) return false;
    // See restoreSessionWorkspace's catch: a failed restore means this run
    // saw a cold workspace, and snapshotting it would supersede -- and via
    // the service's CAS-advance, delete -- the last good snapshot. Likewise
    // when infrastructure failure degraded the restored tree mid-staging
    // (sessionPersistBlocked) -- the snapshot must keep the last good copy.
    if (this.sessionRestoreFailed || this.sessionPersistBlocked) return false;
    // Python's persistence wrapper rewrites the namespace pickle from atexit
    // (os.replace -> new inode + mtime) or, on a failed dump, deletes it. If
    // a restored pickle is still the IDENTICAL file at persist time, this
    // run's atexit never fired despite a signal-free exit -- os._exit(0) or
    // os.exec* bypass atexit without setting run.signal (signal deaths are
    // already gated in v2.ts). Persisting would tar THIS run's files with
    // the PRIOR run's variables -- the same torn state the signal gate
    // avoids -- so skip and leave the pointer on the last good snapshot.
    // Python-only: other languages never rewrite the pickle by design
    // (file-only persistence), so an untouched pickle is expected there and
    // must keep persisting -- it is how Python variables survive an
    // intervening run of another language in the same session.
    if (this.restoredPickleStat && this.runtime.language === 'python') {
      const st = await fsp
        .lstat(path.join(this.submissionDir, SESSION_STATE_PKL_BASENAME))
        .catch(() => null);
      if (st?.isFile() && st.ino === this.restoredPickleStat.ino && st.mtimeMs === this.restoredPickleStat.mtimeMs) {
        this.log.warn('Restored namespace pickle untouched; atexit snapshot never ran (os._exit/exec*) -- skipping persist');
        return false;
      }
    }

    const tmpTar = path.join(os.tmpdir(), `sess-save-${nanoid()}.tar`);
    try {
      // Drop symlinks and special files (FIFOs, sockets, device nodes) FIRST,
      // before any other pruning touches paths by name. Sandbox code (already
      // finished running, but its on-disk output is untrusted) could have
      // swapped a read-only input's directory -- e.g. `skill/` -- for a
      // symlink pointing outside the workspace; if the read-only/prune-dir
      // removal below ran first, resolving a path like `skill/foo.py` would
      // follow that symlink through its intermediate `skill` component and
      // delete/traverse outside `submissionDir`. Stripping all symlinks first
      // (nothing else runs concurrently at this point -- the job has already
      // finished) neutralizes that regardless of what removeReadOnlyInputs or
      // SNAPSHOT_PRUNE_DIRS touches next. This also keeps the size estimate
      // below exact: a symlink with a long target or long path makes GNU tar
      // emit extra longlink/PAX blocks the estimator can't account for, and
      // FIFOs/sockets/devices aren't counted by it at all despite each still
      // costing tar a full 512-byte header -- either way a user could pass the
      // pre-archive cap yet force a larger tarball onto runner disk. All of
      // these are also stripped on restore, so they never carry forward
      // regardless -- excluding them here loses nothing.
      await this.stripSymlinks(this.submissionDir);
      // Physically prune everything else the snapshot must not carry BEFORE
      // measuring and archiving, so the pre-archive size check reflects
      // exactly what the tar will contain (no --exclude divergence):
      //  - read-only inputs (skill/infra): persisting them would re-materialize
      //    an authorized-once resource on later runs, and restore chowns the
      //    tree to the job UID, stripping their read-only protection;
      //  - runtime cache dirs (pip/matplotlib scatter these under
      //    HOME=/mnt/data) and the atomic-write tempfile -- not useful state.
      // The `.session_state.pkl` snapshot is kept so variables carry forward.
      await this.removeReadOnlyInputs();
      // Payload-staged content files (the wrapped entry source -- main.py /
      // main.ts / script.sh) are likewise run infrastructure. Persisting them
      // would carry this run's wrapper source forward as if it were user
      // data; and since restore runs BEFORE source staging, a user file that
      // shares the entry name is overwritten by the next run's source anyway
      // -- it can never round-trip. Pruning makes that reservation explicit
      // and consistent: entry filenames simply never persist. Recursive: the
      // run could have replaced the path with a directory.
      for (const info of this.inputFileHashes.values()) {
        if (info.staged && info.path) {
          await fsp.rm(info.path, { recursive: true, force: true }).catch(() => { /* best effort */ });
        }
      }
      for (const name of SNAPSHOT_PRUNE_DIRS) {
        await fsp.rm(path.join(this.submissionDir, name), { recursive: true, force: true }).catch(() => { /* best effort */ });
      }
      // Bound the aggregate size so a huge workspace can't make the runner
      // materialize a multi-GB tar in /tmp and fill host disk.
      const approxBytes = await this.dirSizeBytes(this.submissionDir);
      if (approxBytes > config.session_state_max_bytes) {
        this.log.warn({ approxBytes, cap: config.session_state_max_bytes }, 'Session workspace exceeds cap; skipping persist before archiving');
        return false;
      }
      await execFileP('tar', ['-cf', tmpTar, '-C', this.submissionDir, '.']);
      const { size } = await fsp.stat(tmpTar);
      if (size > config.session_state_max_bytes) {
        this.log.warn({ size, cap: config.session_state_max_bytes }, 'Session snapshot exceeds cap; skipping persist');
        return false;
      }
      const ok = await this.uploadObjectFromPath(tmpTar, ps.file_id, ps.filename, 'application/x-tar');
      if (ok) this.log.info({ size }, 'Persisted session workspace');
      return ok;
    } catch (err) {
      this.log.warn({ err }, 'Session persist failed; continuing');
      return false;
    } finally {
      await fsp.rm(tmpTar, { force: true }).catch(() => { /* best effort */ });
    }
  }

  /**
   * Stream a file-server object to a local path, capped at `maxBytes`. Returns
   * false on 404. A snapshot larger than the cap (e.g. after lowering the cap,
   * or an older oversized snapshot) is rejected up front via Content-Length and,
   * as a fallback when that header is absent/wrong, aborted mid-stream once the
   * limit is crossed -- so a giant object can't fill runner disk before the
   * post-download size check would have skipped it.
   */
  private async downloadObjectToPath(file: TFile, destPath: string, maxBytes: number): Promise<boolean> {
    const res = await fetch(this.buildDownloadUrl(file), { headers: this.fileEgressHeaders() });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Session object download HTTP ${res.status}`);
    if (!res.body) throw new Error('Session object download returned empty body');
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => { /* release socket */ });
      throw new Error(`Session object exceeds cap (${declared} > ${maxBytes})`);
    }
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > maxBytes) {
          cb(new Error(`Session object exceeds cap (> ${maxBytes})`));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(toNodeReadable(res.body), limiter, fs.createWriteStream(destPath, { mode: SANDBOX_FILE_MODE }));
    } catch (err) {
      await fsp.rm(destPath, { force: true }).catch(() => { /* best effort */ });
      throw err;
    }
    return true;
  }

  /** PUT a local file to `output_session_id/<fileId>` via the egress path. */
  private async uploadObjectFromPath(
    srcPath: string,
    fileId: string,
    filename: string,
    contentType: string,
  ): Promise<boolean> {
    const { size } = await fsp.stat(srcPath);
    const url = `${this.fileEgressBaseUrl()}/sessions/${encodeURIComponent(this.outputSessionId)}/objects/${encodeURIComponent(fileId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response: Response | undefined;
    const stream = fs.createReadStream(srcPath);
    stream.on('error', (err) => this.log.warn({ err }, 'Session upload stream error'));
    try {
      const headers = this.fileEgressHeaders({
        'X-Original-Filename': encodeURIComponent(filename),
        'Content-Type': contentType,
        'Content-Length': String(size),
      });
      response = await fetch(url, {
        method: 'PUT',
        headers,
        body: Readable.toWeb(stream) as unknown as BodyInit,
        // @ts-expect-error — duplex is spec but missing from bundled lib.dom types.
        duplex: 'half',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Session upload HTTP ${response.status}`);
      return true;
    } catch (err) {
      this.log.warn({ err }, 'Session upload failed');
      return false;
    } finally {
      clearTimeout(timeout);
      stream.destroy();
      if (response?.body && !response.bodyUsed) {
        await response.body.cancel().catch(() => { /* socket released either way */ });
      }
    }
  }

  /**
   * Recursively chown an extracted tree to the per-job UID so the sandboxed
   * process (running as that UID) can read and modify restored files. Uses
   * `-h` so symlink ownership, not the target's, is changed. Mirrors
   * chownOrThrow's tolerance: a failure is swallowed (returns false so the
   * caller can widen modes instead) only when per-job UIDs aren't required
   * and the runner isn't expected to have the capability (root + hardened
   * mode); otherwise it's rethrown, matching applySandboxPathPermissions.
   */
  private async chownTreeToJobUid(dir: string): Promise<boolean> {
    const id = this.sandboxIdentity();
    try {
      await execFileP('chown', ['-Rh', `${id.uid}:${id.gid}`, dir]);
      return true;
    } catch (err) {
      if (!id.perJobUid && currentUid() !== 0 && !config.hardened_sandbox_mode) {
        this.log.warn({ err }, 'Failed to chown restored session tree to job UID');
        return false;
      }
      throw err;
    }
  }

  /**
   * Grant the owner (job UID) read/write on files and traverse on directories
   * across a restored tree, preserving existing execute bits. Repairs hostile
   * modes (e.g. a prior run's `chmod 000`) that extraction preserves and would
   * otherwise leave restored files unreadable/untraversable. Best-effort.
   *
   * When `chownApplied` is false (chownTreeToJobUid's ownership transfer was
   * tolerated, not actually applied -- non-root/local dev mode), the tree is
   * still owned by the runner, not the job UID the sandboxed process runs as.
   * Snapshot members are commonly archived at 0600/0700 (owner-only), so
   * `u+rwX` alone would grant access to the runner's UID and leave the
   * sandboxed process locked out. Also widen group/other in that case,
   * mirroring compatibilityModeForSkippedChown's same owner-bits-copied-down
   * strategy used elsewhere for the identical no-chown compatibility path.
   */
  private async normalizeRestoredModes(dir: string, chownApplied: boolean): Promise<void> {
    const spec = chownApplied ? 'u+rwX' : 'u+rwX,go+rwX';
    try {
      await execFileP('chmod', ['-R', spec, dir]);
    } catch (err) {
      this.log.warn({ err }, 'Failed to normalize restored session tree modes');
    }
  }

  /**
   * Recursively remove symlinks and special files (FIFOs, sockets, device
   * nodes) from a tree. `readdir(withFileTypes)` reports the entry's own type
   * (lstat semantics), so these are detected without following symlinks, and
   * directories are recursed into. Used both when restoring (a prior run must
   * not reintroduce a symlink that writeFile would follow outside the
   * workspace, or a FIFO/device that a later run could hang opening) and when
   * persisting (any of these makes tar emit header/longlink content the size
   * estimator below doesn't model -- a symlink with a long target adds extra
   * longlink/PAX blocks, and a FIFO/socket/device still costs a full 512-byte
   * header despite carrying no file content -- so they must not survive into
   * the archive; none of them round-trip through a restore anyway).
   */
  private async stripSymlinks(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // classifyDirent falls back to lstat on DT_UNKNOWN (some NFS/FUSE/
      // overlay mounts). Without it, both isDirectory() and isFile() report
      // false for such an entry, and treating that as "neither" would delete
      // an ordinary file or skip recursing into an ordinary directory here.
      const kind = await this.classifyDirent(entry, full, path.relative(this.submissionDir, full));
      if (kind === 'dir') {
        await this.stripSymlinks(full);
      } else if (kind !== 'file') {
        // Symlink, FIFO, socket, block/char device, or unclassifiable even
        // after lstat -- none are safe or sized by the estimator; drop them.
        await fsp.rm(full, { force: true }).catch(() => { /* best effort */ });
      }
    }
  }

  /**
   * Estimate the on-disk tar size of `dir`, not following symlinks. Counts tar
   * block overhead -- a 512-byte header per entry plus file content padded to
   * 512-byte blocks -- so a swarm of empty files/directories (near-zero content
   * but hundreds of MB of headers) can't slip past the pre-archive size cap.
   * Also charges each member the long-name record GNU tar prepends when its
   * stored path (`./<rel>`) overflows the ustar name/prefix fields, so long-
   * named or deeply nested files can't undercount the estimate either.
   *
   * `seenInodes` maps `dev:ino` to the first archived path for that inode
   * across the whole recursive walk: GNU tar (without `--hard-dereference`,
   * not passed here) archives only the first path to a given inode with its
   * content, and every subsequent hard link to that inode as a header-only
   * link record (size 0) whose `linkname` is that first path. Without
   * tracking it, a workspace with multiple hard links to the same large file
   * would be charged that file's content once per link and could be rejected
   * as oversize even though the real tar comfortably fits under the cap.
   * The first path is also charged again on every repeat link: when it's
   * over 100 bytes, GNU tar must emit a second long-name record for the
   * `linkname` field (distinct from -- and in addition to -- any long-name
   * record the repeat entry's own, possibly short, stored name needs).
   * Verified against a real GNU tar 1.34 archive: a repeat hard link to a
   * long first-archived path emits a GNUTYPE_LONGLINK ('K') record for the
   * linkname on top of its own header, on top of an 'L' record if its own
   * name is also long.
   */
  private async dirSizeBytes(dir: string, seenInodes: Map<string, string> = new Map()): Promise<number> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let total = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Stored member name matches `tar -cf ... -C submissionDir .` output:
      // './' + the POSIX-separated path relative to the workspace root, with a
      // trailing '/' on directory members (GNU tar counts it toward the name).
      const rel = './' + path.relative(this.submissionDir, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        total += 512 + tarLongNameOverheadBytes(rel); // header only
        continue;
      }
      // classifyDirent falls back to lstat on DT_UNKNOWN (some NFS/FUSE/
      // overlay mounts), same as stripSymlinks above -- without it, both
      // isDirectory() and isFile() report false for such an entry, and an
      // ordinary file/directory would silently contribute 0 to the estimate,
      // letting an oversized workspace reach the real `tar -cf` invocation
      // before the post-archive size check catches it.
      const kind = await this.classifyDirent(entry, full, path.relative(this.submissionDir, full));
      if (kind === 'dir') {
        total += 512 + tarLongNameOverheadBytes(rel + '/'); // directory header
        total += await this.dirSizeBytes(full, seenInodes);
      } else if (kind === 'file') {
        let size = 0;
        try {
          const st = await fsp.stat(full);
          size = st.size;
          const inodeKey = `${st.dev}:${st.ino}`;
          const firstRel = seenInodes.get(inodeKey);
          if (firstRel !== undefined) {
            // Header + long-name record for this entry's own stored name (if
            // long) + long-link record for the linkname, which GNU tar sets
            // to the first-archived path (if THAT is long).
            total += 512 + tarLongNameOverheadBytes(rel) + tarLongNameOverheadBytes(firstRel);
            continue;
          }
          seenInodes.set(inodeKey, rel);
        } catch { /* vanished mid-walk; ignore */ }
        total += 512 + Math.ceil(size / 512) * 512 + tarLongNameOverheadBytes(rel);
      }
    }
    return total;
  }

  /**
   * Remove the current run's read-only input files (tracked in
   * `inputFileHashes`) so they are never captured in a session snapshot, then
   * remove each directory tree that hosted one (e.g. `skill/`) OUTRIGHT --
   * not merely when the removal left it empty. Read-only inputs are
   * non-persistent infrastructure and their directories belong to that
   * infrastructure: anything else found inside is something sandbox code
   * planted next to them (e.g. `skill/evil.py`), and letting it ride the
   * snapshot would restore it alongside the NEXT run's freshly staged
   * read-only files, poisoning that run's skill/import resolution. Sweeping
   * the whole tree also means no empty dir survives into the tar to come
   * back as an unbaselined directory and burn a `.dirkeep` output slot every
   * run. Trade-off, by design: nothing under a read-only input's directory
   * persists, not even user-written files. Read-only inputs sitting directly
   * in the workspace root get only the per-file removal -- the root is the
   * user's own persistent workspace and is never swept.
   */
  private async removeReadOnlyInputs(): Promise<void> {
    const infraDirs = new Set<string>();
    for (const info of this.inputFileHashes.values()) {
      if (info.readOnly && info.path) {
        // Recursive: sandbox code could have replaced the read-only path with
        // a directory (e.g. `rm foo.py; mkdir foo.py`). A non-recursive rm
        // throws EISDIR on that -- `force` only swallows ENOENT, so it would
        // otherwise leave that (now user-controlled) directory to persist into
        // the snapshot under a path meant to be stripped as read-only
        // infrastructure. stripSymlinks already ran before this, so there's no
        // symlink left in `info.path` for a recursive removal to follow.
        await fsp.rm(info.path, { recursive: true, force: true }).catch(() => { /* best effort */ });
        // Topmost path component under the workspace root (`skill/a/b.py`
        // -> `skill/`): the whole staged tree is infrastructure, so sweep
        // from its top, catching siblings at every level.
        const rel = path.relative(this.submissionDir, info.path);
        const topSegment = rel.split(path.sep)[0];
        if (topSegment && rel.includes(path.sep)) {
          infraDirs.add(path.join(this.submissionDir, topSegment));
        }
      }
    }
    for (const dir of infraDirs) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }

  /**
   * If `p` exists but is not a regular file (e.g. a directory a prior persisted
   * run left where the current source/input must go), remove it so the fresh
   * write can't fail with EISDIR or clobber through it. No-op when `p` is a
   * regular file or absent -- so this is safe to call before every input write.
   */
  private async clearNonRegularCollision(p: string): Promise<void> {
    let st: fs.Stats;
    try {
      st = await fsp.lstat(p);
    } catch { return; /* nothing there; the write will create it */ }
    if (st.isFile()) return;
    // Never delete a directory that holds CURRENT-run inputs to make room
    // for this file (a Content-Disposition rename can mint a file-vs-dir
    // conflict the up-front prime() check couldn't see). Restored carry-over
    // content is fair game -- replacing stale session state is this method's
    // purpose -- but destroying a sibling input this request also staged
    // would make the job silently run without it; reject instead.
    const rel = path.relative(this.submissionDir, p);
    const prefix = `${rel}/`;
    for (const [key, info] of this.inputFileHashes) {
      if (key.startsWith(prefix) && !info.restored) {
        throw new ValidationError(`input '${rel}' conflicts with already-staged input '${key}' (file vs directory at the same path)`);
      }
    }
    await fsp.rm(p, { recursive: true, force: true });
  }

  /**
   * Clear restored-session ancestor collisions, create `parent`, and secure
   * its chain -- SERIALIZED across the parallel fileOps in prime(). Without
   * the lock, two inputs nested under the same restored regular file (say a
   * prior run left `data` as a file and this request stages `data/a.csv` and
   * `data/b.csv`) can interleave: both lstat the stale `data` file, one
   * replaces it with a directory and writes its input, and the other's stale
   * "non-directory" verdict then recursively removes that fresh directory --
   * erasing the sibling's already-written file (and, since secureAncestors
   * caches secured paths, the recreated tree could skip its ownership fix).
   * The guarded section is fast pure-metadata work; the actual download
   * streaming stays fully parallel.
   */
  private prepareParentDir(parent: string): Promise<void> {
    const run = this.dirPrepChain.then(async () => {
      await this.clearNonDirectoryAncestors(parent);
      await fsp.mkdir(parent, { recursive: true });
      await this.secureAncestors(parent);
    });
    // Keep the chain alive whether or not this link rejects; the caller
    // still observes the rejection through `run`.
    this.dirPrepChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Walk submissionDir -> `dir` and remove any ancestor that a restored session
   * left as a non-directory (e.g. a regular file where an input now needs a
   * parent dir), so the subsequent `mkdir(..., { recursive: true })` can't fail
   * with ENOTDIR. No-op on a fresh workspace. Callers on the parallel input
   * path must go through prepareParentDir, which serializes this check-then-
   * remove against concurrent mkdir of the same ancestors.
   */
  private async clearNonDirectoryAncestors(dir: string): Promise<void> {
    const rel = path.relative(this.submissionDir, dir);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep)) return;
    const parts = rel.split(path.sep).filter(Boolean);
    let cursor = this.submissionDir;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      try {
        const st = await fsp.lstat(cursor);
        if (!st.isDirectory()) {
          // Only restored carry-overs (or untracked debris) may be cleared to
          // make room for a nested path. A CURRENT-run input file here means
          // this request staged conflicting paths that slipped past the
          // up-front check (Content-Disposition rename); deleting it would
          // silently drop a requested input, so reject this file instead.
          const rel = path.relative(this.submissionDir, cursor);
          const tracked = this.inputFileHashes.get(rel);
          if (tracked && !tracked.restored) {
            throw new ValidationError(`input path under '${rel}' conflicts with already-staged input '${rel}' (file vs directory at the same path)`);
          }
          await fsp.rm(cursor, { recursive: true, force: true });
        }
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        /* doesn't exist yet; mkdir will create it */
      }
    }
  }

  /**
   * Streams the response body to `tempPath`, computes its SHA-256 inline,
   * then atomically renames to `finalPath` with sandbox-visible perms.
   * Returns the hex digest.
   */
  private async streamToDisk(
    response: Response,
    tempPath: string,
    finalPath: string,
  ): Promise<string> {
    const body = response.body;
    if (!body) throw new Error('Response body is null');

    const hashStream = crypto.createHash('sha256');
    const hashTransform = new Transform({
      transform(chunk, _enc, cb) { hashStream.update(chunk); cb(null, chunk); },
    });
    const fileStream = fs.createWriteStream(tempPath, { mode: SANDBOX_FILE_MODE });
    const reader = toNodeReadable(body);
    await pipeline(reader, hashTransform, fileStream);
    // A prior persisted run may have left a directory/other node where this
    // input must land; rename() over it would fail (EISDIR/ENOTEMPTY).
    await this.clearNonRegularCollision(finalPath);
    await fsp.rename(tempPath, finalPath);
    await this.applySandboxFilePermissions(finalPath);
    return hashStream.digest('hex');
  }

  async writeFile(file: TFile): Promise<void> {
    validateFilePath(file.name, this.submissionDir);
    if (this.persistSession && isReservedSessionBasename(file.name)) {
      throw new ValidationError(`input uses reserved session filename '${file.name}'`);
    }
    const filePath = path.join(this.submissionDir, file.name);

    const content = Buffer.from(file.content ?? '', (file.encoding as BufferEncoding) ?? 'utf8');
    await this.prepareParentDir(path.dirname(filePath));
    await this.clearNonRegularCollision(filePath);
    await fsp.writeFile(filePath, content);
    await this.applySandboxFilePermissions(filePath);

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    this.inputFileHashes.set(file.name, { hash, path: filePath, staged: true });
  }

  async safeCall(
    script: string,
    args: string[],
    timeout: number,
    _cpuTime: number,
    memoryLimit: number,
    stdin?: string,
  ): Promise<NsJailResult> {
    const command = ['/bin/bash', path.join(this.runtime.pkgdir, script), ...args];

    const filteredExtra = filterExtraEnvVars(this.extra_env_vars);

    const envVars: Record<string, string> = {
      ...filteredExtra,
      OPENBLAS_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      OMP_NUM_THREADS: '1',
      ...this.runtime.env_vars,
      SANDBOX_LANGUAGE: this.runtime.language,
      HOME: '/mnt/data',
    };

    let extraPkgdirs: string[] | undefined;
    if (this.runtime.language === 'bash') {
      const linkTarget: { nodeModulesPath?: string } = {};
      extraPkgdirs = aggregateBashExtras(this.runtime.pkgdir, envVars, undefined, linkTarget);
      ensureNodeModulesSymlink(this.submissionDir, linkTarget.nodeModulesPath);
    }

    return execute({
      command,
      envVars,
      submissionDir: this.submissionDir,
      pkgdir: this.runtime.pkgdir,
      timeout,
      memoryLimit,
      outputMaxSize: this.runtime.output_max_size,
      stdin,
      extraPkgdirs,
      identity: this.sandboxIdentity(),
      enableToolCallSocket: this.toolCallSocketEnabled && script === 'run',
      suppressSuccessLogs: this.isSynthetic,
    });
  }

  async execute(): Promise<ExecuteResult> {
    if (!this.isSynthetic) {
      this.log.info({ runtime: this.runtime.language, version: this.runtime.version.raw }, 'Executing');
    }

    const codeFiles = this.files.filter(
      f => !isDirkeep(f.name) && (!f.encoding || f.encoding === 'utf8'),
    );
    if (this.runtime.language !== 'file' && codeFiles.length === 0) {
      throw new ValidationError('files must include at least one runnable source file');
    }
    this.entryPointName = codeFiles[0]?.name;
    let compile: NsJailResult | undefined;
    let compileErrored = false;

    if (this.runtime.compiled) {
      if (!this.isSynthetic) {
        this.log.info('Compiling');
      }
      compile = await this.safeCall(
        'compile',
        codeFiles.map(f => f.name),
        this.timeouts.compile,
        this.cpu_times.compile,
        this.memory_limits.compile,
      );
      compileErrored = compile.code !== 0;
    }

    let run: NsJailResult | undefined;
    if (!compileErrored && codeFiles.length > 0) {
      if (!this.isSynthetic) {
        this.log.info('Running');
      }
      run = await this.safeCall(
        'run',
        [codeFiles[0].name, ...this.args],
        this.timeouts.run,
        this.cpu_times.run,
        this.memory_limits.run,
        this.stdin,
      );
    }

    await this.handleSessionFiles();

    return {
      compile,
      run,
      language: this.runtime.language,
      version: this.runtime.version.raw,
      session_id: this.outputSessionId,
      files: this.sessionFiles,
    };
  }

  private async handleSessionFiles(): Promise<void> {
    this.generatedFiles = [];
    this.sessionFiles = [];
    this.inheritedRefs = [];

    const inputByName = new Map<string, TFile>();
    for (const f of this.files) inputByName.set(f.name, f);

    try {
      await this.walkDir(this.submissionDir, 0, inputByName);
    } catch (error) {
      this.log.error({ err: error }, 'Error scanning submission directory');
    }

    /* Generated files get priority in sessionFiles; fill remaining slots up
     * to max_output_files with inherited refs (unchanged downloaded inputs
     * and unchanged inherited .dirkeep markers). This bounds the response
     * at exactly max_output_files while preventing unchanged echoes from
     * crowding out real generated outputs. */
    const remaining = Math.max(0, config.max_output_files - this.sessionFiles.length);
    if (remaining > 0 && this.inheritedRefs.length > 0) {
      this.sessionFiles.push(...this.inheritedRefs.slice(0, remaining));
    }
  }

  /**
   * Classifies a dirent into dir/file/skip, falling back to lstat when the
   * filesystem returns DT_UNKNOWN (seen on some NFS/FUSE/overlay mounts).
   * Symlinks are always skipped.
   */
  private async classifyDirent(
    entry: fs.Dirent,
    fullPath: string,
    relativePath: string,
  ): Promise<'dir' | 'file' | 'skip'> {
    if (entry.isSymbolicLink()) return 'skip';
    let isDir = entry.isDirectory();
    let isRegularFile = entry.isFile();
    if (!isDir && !isRegularFile) {
      try {
        const st = await fsp.lstat(fullPath);
        if (st.isSymbolicLink()) return 'skip';
        isDir = st.isDirectory();
        isRegularFile = st.isFile();
      } catch (err) {
        this.log.debug({ path: relativePath, err }, 'walkDir: failed to lstat entry');
        return 'skip';
      }
    }
    if (isDir) return 'dir';
    if (isRegularFile) return 'file';
    return 'skip';
  }

  /**
   * Resolves the .dirkeep marker for a directory that walkDir determined to
   * be empty. Handles three cases: user-submitted inline .dirkeep (treat as
   * regular inline input), inherited session marker (echo or refresh based on
   * hash), and brand-new marker creation.
   */
  private async handleEmptyDirectory(
    relativePath: string,
    fullPath: string,
    inputByName: Map<string, TFile>,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    const keepPath = path.join(relativePath, DIRKEEP);
    if (!isValidPathShape(keepPath)) return { collected: false, truncated: false };
    const keepFullPath = path.join(fullPath, DIRKEEP);
    const inheritedKeep = inputByName.get(keepPath);

    if (inheritedKeep && !inheritedKeep.id) {
      return this.handleInlineUserDirkeep(keepPath, keepFullPath);
    }
    if (inheritedKeep?.id && inheritedKeep.storage_session_id) {
      return this.handleInheritedDirkeep(keepPath, keepFullPath, inheritedKeep);
    }
    // Restored empty-dir marker from a persistent session: it persists in the
    // snapshot tar, so don't regenerate it as a fresh output (which would
    // consume a max_output_files slot and crowd out genuinely new artifacts).
    if (this.inputFileHashes.get(keepPath)?.restored) {
      return { collected: false, truncated: false };
    }
    return this.createDirkeepMarker(keepPath, keepFullPath);
  }

  /**
   * User-submitted inline file literally named `.dirkeep`: no id, real
   * content on disk. Always re-emit with a fresh id so the client has a
   * continuation reference (inline inputs have no persistent id). If the
   * file vanished mid-run, fall back to a synthesized marker so the empty
   * directory is still represented.
   */
  private async handleInlineUserDirkeep(
    keepPath: string,
    keepFullPath: string,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    if (await this.inlineKeepVanished(keepPath, keepFullPath)) {
      return this.createDirkeepMarker(keepPath, keepFullPath);
    }
    if (this.generatedFiles.length >= config.max_output_files) {
      return { collected: false, truncated: true };
    }
    const id = nanoid();
    this.sessionFiles.push({ id, name: keepPath, storage_session_id: this.outputSessionId });
    this.generatedFiles.push({ id, name: keepPath, path: keepFullPath });
    return { collected: true, truncated: false };
  }

  /**
   * Detects the edge case where a user-submitted inline .dirkeep was written
   * during prime() but has since disappeared (sandboxed code deleted it).
   * Uses `fsp.access` as a cheap existence probe — the old code streamed
   * the file through SHA-256 and discarded the digest, which read the
   * entire file just to distinguish ENOENT from success.
   */
  private async inlineKeepVanished(
    keepPath: string,
    keepFullPath: string,
  ): Promise<boolean> {
    if (!this.inputFileHashes.has(keepPath)) return false;
    try {
      await fsp.access(keepFullPath);
      return false;
    } catch (err) {
      this.log.debug({ keepPath, err }, 'walkDir: user .dirkeep no longer accessible');
      return true;
    }
  }

  /**
   * Inherited .dirkeep from a prior session: if unchanged, echo via
   * inheritedRefs (no upload); if modified (rare — user wrote to it), emit
   * as a regenerated ref tagged with modified_from.
   */
  private async handleInheritedDirkeep(
    keepPath: string,
    keepFullPath: string,
    inheritedKeep: TFile,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    const keepInfo = this.inputFileHashes.get(keepPath);
    const keepModified = await this.didInheritedKeepChange(keepPath, keepFullPath, keepInfo);

    /* Read-only inputs: see `tryEchoUnchangedInput` for the contract.
     * Modifications to a `read_only` `.dirkeep` are dropped on the floor —
     * we always echo the inherited ref so the caller sees the original
     * marker, never a refreshed/modified one. */
    if (!keepModified || keepInfo?.readOnly === true) return this.echoInheritedKeep(keepPath, inheritedKeep);

    if (this.generatedFiles.length >= config.max_output_files) {
      return { collected: false, truncated: true };
    }
    const refreshedId = nanoid();
    const refreshedRef: FileRef = { id: refreshedId, name: keepPath, storage_session_id: this.outputSessionId };
    if (keepInfo?.originalId && keepInfo.originalSessionId) {
      refreshedRef.modified_from = {
        id: keepInfo.originalId,
        storage_session_id: keepInfo.originalSessionId,
      };
    }
    this.sessionFiles.push(refreshedRef);
    this.generatedFiles.push({ id: refreshedId, name: keepPath, path: keepFullPath });
    return { collected: true, truncated: false };
  }

  /**
   * True when we can prove via hash baseline that the inherited `.dirkeep`
   * file on disk differs from the bytes we downloaded. Returns `false` on
   * hash failure or when we have no baseline — treating the file as
   * unchanged keeps its id stable across continuations.
   */
  private async didInheritedKeepChange(
    keepPath: string,
    keepFullPath: string,
    keepInfo: InputFileInfo | undefined,
  ): Promise<boolean> {
    if (!keepInfo) return false;
    try {
      const currentHash = await this.computeFileHash(keepFullPath, true);
      return currentHash !== keepInfo.hash;
    } catch (err) {
      this.log.debug({ keepPath, err }, 'walkDir: failed to hash inherited .dirkeep');
      return false;
    }
  }

  private echoInheritedKeep(
    keepPath: string,
    inheritedKeep: TFile,
  ): { collected: boolean; truncated: boolean } {
    if (this.inheritedRefs.length >= config.max_output_files) {
      return { collected: false, truncated: true };
    }
    this.inheritedRefs.push({
      id: inheritedKeep.id!,
      name: keepPath,
      storage_session_id: inheritedKeep.storage_session_id!,
      inherited: true,
      ...(inheritedKeep.entity_id !== undefined
        ? { entity_id: inheritedKeep.entity_id }
        : {}),
    });
    return { collected: true, truncated: false };
  }

  /**
   * Writes a fresh empty .dirkeep marker for a genuinely empty directory.
   * Uses `flag: 'wx'` (O_CREAT|O_EXCL) so the write fails if `keepFullPath`
   * already exists in any form — crucial because a sandboxed program could
   * plant a symlink named `.dirkeep` pointing outside the sandbox; the
   * default `writeFile` follows symlinks and would clobber the target.
   */
  private async createDirkeepMarker(
    keepPath: string,
    keepFullPath: string,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    if (this.generatedFiles.length >= config.max_output_files) {
      return { collected: false, truncated: true };
    }
    try {
      await fsp.writeFile(keepFullPath, '', { flag: 'wx' });
      await this.applySandboxFilePermissions(keepFullPath, true);
    } catch (err) {
      this.log.debug({ keepPath, err }, 'walkDir: failed to write .dirkeep marker');
      return { collected: false, truncated: false };
    }
    const id = nanoid();
    this.sessionFiles.push({ id, name: keepPath, storage_session_id: this.outputSessionId });
    this.generatedFiles.push({ id, name: keepPath, path: keepFullPath });
    return { collected: true, truncated: false };
  }

  /**
   * Decides whether an unchanged input file can be echoed without a fresh
   * upload. Returns the outcome for three cases or null to fall through to
   * generated-output emission:
   *   - unchanged downloaded input → push inherited ref (or mark truncated
   *     if the inherited-ref cap is reached)
   *   - unchanged inline entry-point source → skip without emit
   *   - anything else → null (caller should treat as generated)
   *
   * Extracted to keep handleRegularFile flat; also safer to echo only when
   * a hash baseline exists, since without one the bytes on disk must have
   * been produced by the current run and reusing the stale id would lie
   * to the caller about content.
   *
   * Read-only inputs are special-cased: when the input was uploaded with
   * `read_only=true` (skill files etc.), we ALWAYS echo as inherited even
   * if `wasModified === true`. The contract from upload time is "do not
   * surface modifications back to the client" — sandboxed-code edits are
   * dropped on the floor (filesystem-level chmod 444 is the primary
   * defense; this is the runtime backstop).
   */
  private tryEchoUnchangedInput(ctx: {
    wasModified: boolean;
    inputFileInfo: InputFileInfo | undefined;
    existingFile: TFile | undefined;
    relativePath: string;
  }): { collected: boolean; truncated: boolean } | null {
    const { wasModified, inputFileInfo, existingFile, relativePath } = ctx;
    const isReadOnly = inputFileInfo?.readOnly === true;
    if (wasModified && !isReadOnly) return null;
    if (!inputFileInfo) return null;
    if (!existingFile) return null;

    if (existingFile.id && existingFile.storage_session_id) {
      if (this.inheritedRefs.length >= config.max_output_files) {
        return { collected: false, truncated: true };
      }
      this.inheritedRefs.push({
        id: existingFile.id,
        name: relativePath,
        storage_session_id: existingFile.storage_session_id,
        inherited: true,
        ...(existingFile.entity_id !== undefined
          ? { entity_id: existingFile.entity_id }
          : {}),
      });
      return { collected: true, truncated: false };
    }

    if (relativePath === this.entryPointName) {
      return { collected: true, truncated: false };
    }

    return null;
  }

  /**
   * Processes a regular (non-directory) dirent: size/extension filtering,
   * hash-based modification detection, and one of three outcomes — echo via
   * inheritedRefs for unchanged downloaded inputs, skip for unchanged
   * entry-point source, or emit as a generated output with a fresh id.
   * `stopLoop` signals the caller to break out of the readdir loop entirely
   * (generatedFiles cap hit).
   */
  private async handleRegularFile(
    entry: fs.Dirent,
    relativePath: string,
    fullPath: string,
    inputByName: Map<string, TFile>,
  ): Promise<{ collected: boolean; truncated: boolean; stopLoop: boolean }> {
    /* Go runtime emits `trim.txt` at the submission root as a build artifact
     * we never want to echo back. Scope to the exact root path so legitimate
     * user outputs like `reports/trim.txt` still get uploaded. */
    if (this.runtime.language === 'go' && relativePath === 'trim.txt') {
      return { collected: false, truncated: false, stopLoop: false };
    }
    /* Allow .dirkeep files through the extension filter so user-submitted
     * markers in non-empty directories are preserved; the empty-directory
     * branch handles the auto-generated case. */
    if (entry.name !== DIRKEEP) {
      if (!isSupportedOutputFilename(entry.name)) {
        return { collected: false, truncated: false, stopLoop: false };
      }
    }

    let size: number;
    try {
      /* Use lstat to stay consistent with classifyDirent's symlink filter —
       * following a symlink here would resurrect the exact escape vector
       * that the classification step already rejected. */
      size = (await fsp.lstat(fullPath)).size;
    } catch (err) {
      this.log.debug({ path: relativePath, err }, 'walkDir: unable to stat file');
      return { collected: false, truncated: false, stopLoop: false };
    }
    if (size > this.runtime.max_file_size) {
      return { collected: false, truncated: false, stopLoop: false };
    }

    const inputFileInfo = this.inputFileHashes.get(relativePath);
    const existingFile = inputByName.get(relativePath);
    let wasModified = false;

    if (inputFileInfo) {
      try {
        const currentHash = await this.computeFileHash(fullPath, true);
        wasModified = currentHash !== inputFileInfo.hash;
        if (wasModified) this.log.info({ file: relativePath }, 'Input file was modified');
      } catch (err) {
        this.log.debug({ path: relativePath, err }, 'walkDir: failed to hash file');
      }
    }

    /* Unchanged persistent-session carry-over: internal state that rides in the
     * snapshot tar, not a user output. Skip it so it neither uploads nor
     * consumes a max_output_files slot. A modified one falls through and is
     * emitted as a normal generated output below. */
    if (inputFileInfo?.restored && !existingFile && !wasModified) {
      return { collected: false, truncated: false, stopLoop: false };
    }

    const echoed = this.tryEchoUnchangedInput({
      wasModified,
      inputFileInfo,
      existingFile,
      relativePath,
    });
    if (echoed) return { ...echoed, stopLoop: false };

    if (this.generatedFiles.length >= config.max_output_files) {
      return { collected: false, truncated: true, stopLoop: true };
    }

    await this.applySandboxFilePermissions(fullPath, true);
    const newId = nanoid();
    const fileData: FileRef = { id: newId, name: relativePath, storage_session_id: this.outputSessionId };
    if (wasModified && inputFileInfo?.originalId && inputFileInfo.originalSessionId) {
      fileData.modified_from = {
        id: inputFileInfo.originalId,
        storage_session_id: inputFileInfo.originalSessionId,
      };
    }
    this.sessionFiles.push(fileData);
    this.generatedFiles.push({ id: newId, name: relativePath, path: fullPath });
    return { collected: true, truncated: false, stopLoop: false };
  }

  /**
   * Recurses into a subdirectory and decides whether to synthesize a
   * `.dirkeep` marker when the subdir turns out to be empty. Flattens what
   * was previously a stack of nested ifs inside walkDir.
   */
  private async walkSubdirectory(
    relativePath: string,
    fullPath: string,
    parentDepth: number,
    inputByName: Map<string, TFile>,
  ): Promise<{ collected: boolean; truncated: boolean }> {
    await applySandboxPathPermissionsNoFollow(fullPath, this.sandboxIdentity(), SANDBOX_DIR_MODE, 'directory');
    const childStatus = await this.walkDir(fullPath, parentDepth + 1, inputByName);
    if (childStatus === 'collected') return { collected: true, truncated: false };
    if (childStatus === 'skipped') return { collected: false, truncated: true };
    if (this.isOutputCapFull()) return { collected: false, truncated: true };
    return this.handleEmptyDirectory(relativePath, fullPath, inputByName);
  }

  /**
   * Recursively scans the submission directory for output files. Returns a
   * status distinguishing truly empty directories from scans truncated by
   * depth/output caps, so .dirkeep markers are only written for genuinely
   * empty directories.
   */
  private async walkDir(
    dir: string,
    depth: number,
    inputByName: Map<string, TFile>,
  ): Promise<'collected' | 'empty' | 'skipped'> {
    if (depth >= config.max_nesting_depth) return 'skipped';
    if (this.isOutputCapFull()) return 'skipped';

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.log.debug({ dir, err }, 'walkDir: unable to read directory');
      return 'skipped';
    }

    /** The PTC replay preamble injects a single tool-history fixture file at
     * `<submissionDir>/_ptc_history.json` so user code can read deterministic
     * cached results without going back to the service. It is runtime plumbing
     * and must never echo back as a session output. The previous prefix-form
     * (`_ptc_*`) silently ate any user file starting with `_ptc_`, which is a
     * regression for non-replay workloads — match the exact basename instead.
     * Tempfiles like `_ptc_pending.*` and `_ptc_counter.*` written by the bash
     * preamble live in `/tmp` and never reach the submission dir, so they
     * don't need walkDir-side filtering.
     *
     * NOTE: This MUST stay in sync with `PTC_HISTORY_FILENAME` in
     * `services/codeapi/service/src/ptc-constants.ts`. The two workspaces are
     * separate npm packages so we can't import directly; the filename literal
     * is asserted-equal in `service/scripts/test-ptc-sentinel.ts` to catch
     * accidental drift in CI. */
    const PTC_HISTORY_FILENAME = '_ptc_history.json';
    /* Persistent-session artifacts written under /mnt/data: the dill namespace
     * snapshot and its atomic-write tempfile. They are private runtime plumbing
     * that rides inside the workspace tar and must never echo back as a session
     * output. MUST stay in sync with SESSION_STATE_FILENAME in
     * `service/src/session-persist.ts` (separate npm package — can't import). */
    const SESSION_STATE_RESERVED = new Set(['.session_state.pkl', '.session_state.pkl.tmp']);
    const isReservedOutputName = (name: string): boolean =>
      name === PTC_HISTORY_FILENAME || SESSION_STATE_RESERVED.has(name);

    const nonDirkeepCount = entries.reduce(
      (n, e) => (e.name === DIRKEEP || isReservedOutputName(e.name) ? n : n + 1),
      0,
    );

    let hasCollectedChild = false;
    let truncated = false;
    /* Hidden directories that we filtered out are still counted in
     * `nonDirkeepCount` (which is computed before classification). Track
     * them so the empty-vs-skipped decision below matches what walkDir
     * actually contributed: a `foo/` whose only entry is a filtered
     * `.cache/` is effectively empty from the user's perspective and
     * needs the `.dirkeep` marker to survive the next prime(), not the
     * `'skipped'` fall-through that suppresses marker creation. */
    let skippedHiddenDirs = 0;

    for (const entry of entries) {
      if (this.isOutputCapFull()) { truncated = true; break; }
      if (isReservedOutputName(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.submissionDir, fullPath);
      if (!isValidPathShape(relativePath)) continue;

      const kind = await this.classifyDirent(entry, fullPath, relativePath);
      if (kind === 'skip') continue;

      if (kind === 'dir') {
        /* Skip hidden directories (basename starts with `.`) unless the user
         * explicitly primed something under them. Matplotlib, pip, and other
         * runtimes scatter `~/.cache/...` and `~/.config/...` caches inside
         * /mnt/data because the sandbox HOME points there — those are
         * runtime plumbing, not user artifacts, and surfacing them back as
         * "Generated files" pollutes the chip list and the next prime().
         * `.dirkeep` is a file, not a directory, so it's unaffected. */
        if (isHiddenDirectory(entry.name) && !inputsLiveUnder(inputByName, relativePath)) {
          this.log.debug({ path: relativePath }, 'walkDir: skipping hidden directory');
          skippedHiddenDirs++;
          continue;
        }
        const res = await this.walkSubdirectory(relativePath, fullPath, depth, inputByName);
        if (res.collected) hasCollectedChild = true;
        if (res.truncated) truncated = true;
        continue;
      }

      const res = await this.handleRegularFile(entry, relativePath, fullPath, inputByName);
      if (res.collected) hasCollectedChild = true;
      if (res.truncated) truncated = true;
      if (res.stopLoop) break;
    }

    if (hasCollectedChild) return 'collected';
    if (truncated) return 'skipped';
    /* Subtract filtered hidden dirs so a directory whose only contents
     * were runtime-cache pollution is treated as empty (gets a .dirkeep
     * marker) instead of silently disappearing on the next continuation. */
    return nonDirkeepCount - skippedHiddenDirs <= 0 ? 'empty' : 'skipped';
  }

  /**
   * IDs of files this job produced locally and is responsible for shipping
   * to the file server. Used by the v2 handler to distinguish "generated and
   * needs upload" from inherited refs (which already live on the server) so
   * upload failures only prune the at-risk subset.
   */
  getGeneratedFileIds(): string[] {
    return this.generatedFiles.map(f => f.id);
  }

  /**
   * Upload `generatedFiles` to the file server. Returns the set of file IDs
   * that were successfully transferred so callers can strip phantom IDs from
   * the execute() response — a file ID we minted locally but failed to ship
   * is not addressable on the next prime() and would surface as a `404`
   * storm of retries followed by a missing file.
   *
   * Each file is sent as a streaming `PUT /sessions/:session_id/objects/:id`
   * with `fs.createReadStream` piped via `Readable.toWeb`. This is the
   * lightest path the file-server exposes — the bytes are never held in JS
   * memory on the sandbox side, busboy never enters the picture, and minio
   * receives the stream directly. The previous implementation bundled all
   * files into a multipart POST and required reading every byte into a
   * `Blob`, ballooning resident memory under the `max_output_files *
   * max_file_size` cap (default 50 × 10MB = 500MB peak per job).
   *
   * Per-file PUTs run concurrently up to `config.upload_concurrency`; the
   * file-server keys by `(session_id, fileId)` so within-job requests don't
   * contend, but capping the fan-out keeps the open-fd + HTTP-connection
   * footprint sane when several concurrent jobs each try to ship 50 files.
   */
  async uploadGeneratedFiles(): Promise<Set<string>> {
    const uploaded = new Set<string>();
    if (this.generatedFiles.length === 0) return uploaded;

    const results = await mapWithConcurrency(
      this.generatedFiles,
      config.upload_concurrency,
      file => this.uploadOneFile(file),
    );
    for (const id of results) {
      if (id) uploaded.add(id);
    }

    if (uploaded.size < this.generatedFiles.length) {
      this.log.warn(
        { uploaded: uploaded.size, total: this.generatedFiles.length },
        'Some files failed to upload',
      );
    }
    return uploaded;
  }

  /**
   * Streams a single generated file to the file-server and returns its ID
   * on success or `null` on failure. Isolated to keep `uploadGeneratedFiles`
   * focused on aggregation. A separate `AbortController` per request
   * prevents one slow file from holding the rest up past the timeout.
   *
   * Uses `lstat` (not `stat`) to mirror the symlink-rejecting check
   * `walkDir`/`handleRegularFile` apply when the file is first
   * discovered: a malicious or buggy sandbox process could replace a
   * regular file with a symlink between scan and upload (TOCTOU), and
   * `stat` + `createReadStream` would silently follow it. The lstat
   * check here is a second line of defense.
   *
   * Always consumes (or cancels) the response body before returning.
   * Undici's connection pool keeps a socket reserved until the body is
   * fully read; with concurrent uploads, leaking unread bodies starves
   * the pool and stalls subsequent requests.
   */
  private async uploadOneFile(file: GeneratedFile): Promise<string | null> {
    if (!file?.path) return null;

    let size: number;
    try {
      const lstat = await fsp.lstat(file.path);
      if (lstat.isSymbolicLink()) {
        this.log.error({ file: file.name }, 'Refusing to upload a symlink');
        return null;
      }
      if (!lstat.isFile()) {
        this.log.error(
          { file: file.name },
          'Refusing to upload a non-regular file',
        );
        return null;
      }
      size = lstat.size;
    } catch (error) {
      this.log.error({ file: file.name, err: error }, 'Error stat-ing file before upload');
      return null;
    }

    const url = `${this.fileEgressBaseUrl()}/sessions/${encodeURIComponent(this.outputSessionId)}/objects/${encodeURIComponent(file.id)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let headers: Record<string, string>;
    try {
      headers = this.fileEgressHeaders({
        /* file-server URL-decodes this header to recover the canonical
         * filename, so paths with `/` survive transport without colliding
         * with the `___` separators or RFC 5987 quoting rules used
         * elsewhere in the protocol. */
        'X-Original-Filename': encodeURIComponent(file.name),
        /* file-server stores this Content-Type as object metadata and
         * serves it back on download, so it has to reflect the real
         * media type — not a one-size-fits-all `octet-stream`. The
         * previous multipart path inferred this from the per-part
         * extension via FormData; we replicate that here. */
        'Content-Type': mimeTypeFor(file.name),
        'Content-Length': String(size),
      });
    } catch (error) {
      clearTimeout(timeout);
      this.log.error({ file: file.name, err: error }, 'Error preparing upload');
      return null;
    }

    const stream = fs.createReadStream(file.path, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
    stream.on('error', (error) => {
      this.log.warn({ file: file.name, err: error }, 'Upload file stream error');
    });

    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers,
        /* `Readable.toWeb` adapts the Node stream into a WHATWG
         * `ReadableStream` for fetch's body. The `duplex: 'half'` flag is
         * required by undici/Bun whenever the body is a stream. */
        body: Readable.toWeb(stream) as unknown as BodyInit,
        // @ts-expect-error — duplex is part of the fetch spec but missing
        // from lib.dom.d.ts in the version bundled with @types/bun.
        duplex: 'half',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Upload HTTP error: ${response.status}`);
      }
      this.log.debug({ file: file.name, id: file.id, size }, 'Uploaded file');
      return file.id;
    } catch (error) {
      this.log.error({ file: file.name, err: error }, 'Error uploading file');
      return null;
    } finally {
      clearTimeout(timeout);
      stream.destroy();
      /* Drain or cancel the response body. Undici keeps the socket
       * reserved until the body is consumed; under concurrent uploads,
       * leaving bodies unread exhausts the connection pool and stalls
       * the next batch. `cancel()` is the cheapest path — the file-
       * server's reply is just a small JSON ack we don't need. */
      if (response?.body && !response.bodyUsed) {
        await response.body.cancel().catch(() => {
          /* Cancel can race with the connection closing on its own —
           * either way the socket is released, so swallow the error. */
        });
      }
    }
  }

  async cleanup(): Promise<void> {
    if (!this.isSynthetic) {
      this.log.info('Cleaning up');
    }
    let workspaceRemoved = true;
    const workspaceLease = this.workspaceLease;
    const jobIdentity = this.jobIdentity;

    if (workspaceLease) {
      try {
        workspaceRemoved = await cleanupSandboxWorkspace(workspaceLease);
      } catch (error) {
        workspaceRemoved = false;
        this.log.error({ submissionDir: this.submissionDir, err: error }, 'Failed to clean up');
      } finally {
        this.workspaceLease = undefined;
        this.submissionDir = '';
      }
    }

    if (jobIdentity) {
      if (!workspaceLease || workspaceRemoved) {
        releaseJobIdentity(jobIdentity);
      } else {
        retainWorkspaceCleanupUntilRemoved(workspaceLease, () => {
          releaseJobIdentity(jobIdentity);
          this.log.info(
            { uid: jobIdentity.uid, gid: jobIdentity.gid, slot: jobIdentity.slot },
            'Released retained sandbox job UID slot after workspace cleanup',
          );
        });
        this.log.error(
          { uid: jobIdentity.uid, gid: jobIdentity.gid, slot: jobIdentity.slot },
          'Retaining sandbox job UID slot after failed workspace cleanup',
        );
      }
      this.jobIdentity = undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
