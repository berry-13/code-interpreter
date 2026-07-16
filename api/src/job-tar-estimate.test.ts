import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as semver from 'semver';
import { Job, tarLongNameOverheadBytes } from './job';
import type { Runtime } from './runtime';

/**
 * Unit tests for `Job.dirSizeBytes`'s repeat-hard-link accounting. The
 * estimator's own accompanying comment documents the mechanism this covers:
 * GNU tar (invoked without `--hard-dereference`) archives only the first
 * path to a given inode with content, and every later hard link to that
 * inode as a header-only record whose `linkname` is that first path. When
 * the first path is over 100 bytes, GNU tar must emit a second long-name
 * record for `linkname` -- verified directly against a real GNU tar 1.34
 * archive (see the repro in the fixing commit) -- independent of whatever
 * long-name overhead the repeat entry's own (possibly short) stored name
 * needs.
 */

interface DirSizeInternals {
  dirSizeBytes(dir: string, seenInodes?: Map<string, string>): Promise<number>;
}

function asDirSizeInternals(job: Job): DirSizeInternals {
  return job as unknown as DirSizeInternals;
}

function makeRuntime(): Runtime {
  return {
    language: 'python',
    version: new semver.SemVer('3.11.0'),
    aliases: [],
    pkgdir: '/tmp',
    compiled: false,
    env_vars: {},
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
    max_process_count: 100,
    max_open_files: 100,
    max_file_size: 10_000_000,
    output_max_size: 1_000_000,
  };
}

function makeJob(): Job {
  return new Job({
    session_id: 'test-session',
    runtime: makeRuntime(),
    files: [],
    args: [],
    stdin: '',
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
  });
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-tar-estimate-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('Job.dirSizeBytes hard-link accounting', () => {
  it('charges a long-link record for a long first-archived path, even when the repeat entry\'s own name is short', async () => {
    // A real filesystem's readdir order (which both `tar` and this
    // estimator walk in) decides which hard-linked path GNU tar treats as
    // the "first" one whose content it archives -- unpredictable by name
    // alone. Rather than depend on that ordering, seed `seenInodes` the same
    // way the estimator's own recursive calls would: with a real file's
    // inode mapped to a synthetic long first-archived path, so the walk
    // deterministically takes the "repeat hard link" branch for it.
    const shortPath = path.join(tmpDir, 'short.bin');
    await fsp.writeFile(shortPath, 'hello');
    const st = await fsp.stat(shortPath);
    const inodeKey = `${st.dev}:${st.ino}`;
    const longFirstRel = './' + 'a'.repeat(150);
    expect(tarLongNameOverheadBytes(longFirstRel)).toBe(1024);
    expect(tarLongNameOverheadBytes('./short.bin')).toBe(0);

    const job = makeJob();
    const seenInodes = new Map([[inodeKey, longFirstRel]]);
    const total = await asDirSizeInternals(job).dirSizeBytes(tmpDir, seenInodes);

    // header (512) + linkname long-link overhead (1024) + nothing for the
    // entry's own short name -- no content bytes (repeat links are
    // header-only in the real tar).
    expect(total).toBe(512 + 1024);
  });

  it('charges nothing extra for a repeat hard link whose first-archived path is short', async () => {
    const shortPath = path.join(tmpDir, 'short.bin');
    await fsp.writeFile(shortPath, 'hello');
    const st = await fsp.stat(shortPath);
    const inodeKey = `${st.dev}:${st.ino}`;

    const job = makeJob();
    const seenInodes = new Map([[inodeKey, './other-short.bin']]);
    const total = await asDirSizeInternals(job).dirSizeBytes(tmpDir, seenInodes);

    expect(total).toBe(512);
  });
});

describe('Job.dirSizeBytes DT_UNKNOWN fallback', () => {
  it('still counts an ordinary file and recurses into an ordinary directory reported as DT_UNKNOWN', async () => {
    // `fs.Dirent.isDirectory`/`isFile` live on the shared prototype (see
    // stripSymlinks' equivalent test); patching them for this test forces
    // every dirent dirSizeBytes' own readdir() returns to report DT_UNKNOWN,
    // reproducing what some NFS/FUSE/overlay mounts actually return.
    // Without the classifyDirent lstat fallback, both would silently
    // contribute 0 to the estimate instead of their real tar overhead.
    await fsp.writeFile(path.join(tmpDir, 'unknown-file.txt'), 'hello');
    await fsp.mkdir(path.join(tmpDir, 'unknown-dir'));
    await fsp.writeFile(path.join(tmpDir, 'unknown-dir', 'inside.bin'), 'x'.repeat(10));

    const origIsDirectory = fs.Dirent.prototype.isDirectory;
    const origIsFile = fs.Dirent.prototype.isFile;
    fs.Dirent.prototype.isDirectory = function () { return false; };
    fs.Dirent.prototype.isFile = function () { return false; };
    let total: number;
    try {
      const job = makeJob();
      total = await asDirSizeInternals(job).dirSizeBytes(tmpDir);
    } finally {
      fs.Dirent.prototype.isDirectory = origIsDirectory;
      fs.Dirent.prototype.isFile = origIsFile;
    }

    // unknown-file.txt: header + 1 content block (512, "hello" fits in one
    // block). unknown-dir/: header only, plus its own recursion for
    // inside.bin: header + 1 content block.
    const expected = (512 + 512) + (512 + (512 + 512));
    expect(total).toBe(expected);
  });
});
