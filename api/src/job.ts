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

function isReservedSessionBasename(name: string): boolean {
  const base = name.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return base !== undefined && RESERVED_SESSION_BASENAMES.has(base);
}

/** True for the internal pickle artifacts only -- never a legitimate restored
 *  user file, unlike SESSION_STATE_TAR_BASENAME (see comment above). */
function isSessionStateInternalBasename(name: string): boolean {
  const base = name.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return base !== undefined && SESSION_STATE_INTERNAL_BASENAMES.has(base);
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
  private persistSession: { file_id: string; filename: string; restore_session_id?: string } | undefined;

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
        const finalPath = path.join(this.submissionDir, originalName);
        const finalParent = path.dirname(finalPath);
        await this.clearNonDirectoryAncestors(finalParent);
        await fsp.mkdir(finalParent, { recursive: true });
        await this.secureAncestors(finalParent);

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
    // stale carry-over + its baseline so user code sees the input as missing.
    await this.discardStaleRestoredInput(file.name);
    return null;
  }

  /**
   * On a failed input download, remove a restored persistent-session file (or
   * directory) left at the same path (and its output-walk baseline) so the run
   * doesn't observe stale bytes in place of the current, unavailable input.
   * No-op unless the path was a restored carry-over.
   */
  private async discardStaleRestoredInput(name: string): Promise<void> {
    const info = this.inputFileHashes.get(name);
    if (info?.restored && info.path) {
      try {
        await fsp.rm(info.path, { force: true });
      } catch (err) {
        this.log.warn({ file: name, err }, 'Failed to remove stale restored input after download failure');
      }
      this.inputFileHashes.delete(name);
      return;
    }
    // registerRestoredBaseline recurses into restored directories and keys each
    // leaf file by its relative path -- the directory itself never gets its own
    // `inputFileHashes` entry. Detect that case via a restored child under
    // `name/` so a restored directory at this path is also discarded.
    const prefix = `${name}/`;
    const hasRestoredChild = [...this.inputFileHashes.keys()].some((key) => key.startsWith(prefix));
    if (!hasRestoredChild) return;
    try {
      await fsp.rm(path.join(this.submissionDir, name), { recursive: true, force: true });
    } catch (err) {
      this.log.warn({ file: name, err }, 'Failed to remove stale restored input directory after download failure');
    }
    for (const key of [...this.inputFileHashes.keys()]) {
      if (key.startsWith(prefix)) this.inputFileHashes.delete(key);
    }
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
    if (idx < 0) return; // no matching prior-state object
    const [restoreFile] = this.files.splice(idx, 1);

    const tmpTar = path.join(os.tmpdir(), `sess-restore-${nanoid()}.tar`);
    try {
      const fetched = await this.downloadObjectToPath(restoreFile, tmpTar, config.session_state_max_bytes);
      if (!fetched) return; // 404 / miss -> treat as no prior state
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
      await this.chownTreeToJobUid(this.submissionDir);
      // tar --no-same-permissions only umasks archived modes; it never ADDS
      // access, so a prior run's `chmod 000` on any dir/file survives extraction
      // and, now owned by the job UID, is still untraversable/unreadable --
      // bricking restored state. `u+rwX` grants the owner read/write on files
      // and traverse on dirs (and preserves existing execute bits) across the
      // whole tree, and the root gets its exact canonical workspace mode.
      await this.normalizeRestoredModes(this.submissionDir);
      await applySandboxPathPermissions(this.submissionDir, this.sandboxIdentity(), SANDBOX_WORKSPACE_MODE);
      // Record restored files as input baselines so handleSessionFiles treats
      // unchanged carry-overs as inherited, not freshly generated outputs --
      // otherwise a session with many restored files would exhaust
      // max_output_files before a new plot/report and drop it from the response.
      await this.registerRestoredBaseline(this.submissionDir);
      this.log.info({ size }, 'Restored persisted session workspace');
    } catch (err) {
      // Documented contract is "start empty on restore failure". A corrupt or
      // truncated tar can leave a partial tree, so wipe it rather than run
      // against a mix of stale-and-missing files.
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
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await this.registerRestoredBaseline(full);
        continue;
      }
      if (!entry.isFile()) continue;
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
   * (oversize / no storage / error) is non-fatal and leaves the prior snapshot
   * as the session's last good state.
   */
  async persistSessionState(): Promise<boolean> {
    const ps = this.persistSession;
    if (!ps || !this.submissionDir || !this.fileEgressBaseUrl()) return false;

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
   * `-h` so symlink ownership, not the target's, is changed. Best-effort:
   * without the capability (e.g. non-root dev mode) restored files stay
   * runner-owned but world-readable, so restore-and-read still works.
   */
  private async chownTreeToJobUid(dir: string): Promise<void> {
    const id = this.sandboxIdentity();
    try {
      await execFileP('chown', ['-Rh', `${id.uid}:${id.gid}`, dir]);
    } catch (err) {
      this.log.warn({ err }, 'Failed to chown restored session tree to job UID');
    }
  }

  /**
   * Grant the owner (job UID) read/write on files and traverse on directories
   * across a restored tree, preserving existing execute bits. Repairs hostile
   * modes (e.g. a prior run's `chmod 000`) that extraction preserves and would
   * otherwise leave restored files unreadable/untraversable. Best-effort.
   */
  private async normalizeRestoredModes(dir: string): Promise<void> {
    try {
      await execFileP('chmod', ['-R', 'u+rwX', dir]);
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
      if (entry.isDirectory()) {
        await this.stripSymlinks(full);
      } else if (!entry.isFile()) {
        // Symlink, FIFO, socket, or block/char device -- none are safe or
        // sized by the estimator; drop them all.
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
   * `seenInodes` tracks `dev:ino` across the whole recursive walk: GNU tar
   * (without `--hard-dereference`, not passed here) archives only the first
   * path to a given inode with its content, and every subsequent hard link to
   * that inode as a header-only link record (size 0). Without this, a
   * workspace with multiple hard links to the same large file would be
   * charged that file's content once per link and could be rejected as
   * oversize even though the real tar comfortably fits under the cap.
   */
  private async dirSizeBytes(dir: string, seenInodes: Set<string> = new Set()): Promise<number> {
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
      if (entry.isDirectory()) {
        total += 512 + tarLongNameOverheadBytes(rel + '/'); // directory header
        total += await this.dirSizeBytes(full, seenInodes);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          const st = await fsp.stat(full);
          size = st.size;
          const inodeKey = `${st.dev}:${st.ino}`;
          if (seenInodes.has(inodeKey)) {
            total += 512 + tarLongNameOverheadBytes(rel); // repeat hard link: header only
            continue;
          }
          seenInodes.add(inodeKey);
        } catch { /* vanished mid-walk; ignore */ }
        total += 512 + Math.ceil(size / 512) * 512 + tarLongNameOverheadBytes(rel);
      }
    }
    return total;
  }

  /**
   * Remove the current run's read-only input files (tracked in
   * `inputFileHashes`) so they are never captured in a session snapshot, then
   * prune any parent directory (e.g. `skill/`) left empty by that removal.
   * Read-only inputs are the only thing that lived in those directories --
   * `registerRestoredBaseline` only baselines leaf files, never the directory
   * itself, so an empty dir surviving into the tar would come back on the
   * *next* restore as a fresh, unbaselined empty directory. That run's output
   * walk would then plant a `.dirkeep` for it (and re-trigger this same
   * emptying/pruning), regenerating a `.dirkeep` output every run and
   * crowding out real artifacts under `max_output_files`.
   */
  private async removeReadOnlyInputs(): Promise<void> {
    const emptiedDirs = new Set<string>();
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
        emptiedDirs.add(path.dirname(info.path));
      }
    }
    for (const dir of emptiedDirs) {
      await this.pruneEmptyAncestors(dir);
    }
  }

  /**
   * Remove `dir` and each ancestor up to (but not including) `submissionDir`
   * as long as each is empty, stopping at the first non-empty one. Best-effort.
   */
  private async pruneEmptyAncestors(dir: string): Promise<void> {
    let cursor = dir;
    while (cursor !== this.submissionDir && cursor.startsWith(this.submissionDir + path.sep)) {
      let entries: string[];
      try {
        entries = await fsp.readdir(cursor);
      } catch {
        return;
      }
      if (entries.length > 0) return;
      try {
        await fsp.rmdir(cursor);
      } catch {
        return;
      }
      cursor = path.dirname(cursor);
    }
  }

  /**
   * If `p` exists but is not a regular file (e.g. a directory a prior persisted
   * run left where the current source/input must go), remove it so the fresh
   * write can't fail with EISDIR or clobber through it. No-op when `p` is a
   * regular file or absent -- so this is safe to call before every input write.
   */
  private async clearNonRegularCollision(p: string): Promise<void> {
    try {
      const st = await fsp.lstat(p);
      if (!st.isFile()) {
        await fsp.rm(p, { recursive: true, force: true });
      }
    } catch { /* nothing there; the write will create it */ }
  }

  /**
   * Walk submissionDir -> `dir` and remove any ancestor that a restored session
   * left as a non-directory (e.g. a regular file where an input now needs a
   * parent dir), so the subsequent `mkdir(..., { recursive: true })` can't fail
   * with ENOTDIR. No-op on a fresh workspace.
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
        if (!st.isDirectory()) await fsp.rm(cursor, { recursive: true, force: true });
      } catch { /* doesn't exist yet; mkdir will create it */ }
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
    const parentDir = path.dirname(filePath);
    await this.clearNonDirectoryAncestors(parentDir);
    await fsp.mkdir(parentDir, { recursive: true });
    await this.secureAncestors(parentDir);
    await this.clearNonRegularCollision(filePath);
    await fsp.writeFile(filePath, content);
    await this.applySandboxFilePermissions(filePath);

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    this.inputFileHashes.set(file.name, { hash, path: filePath });
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
