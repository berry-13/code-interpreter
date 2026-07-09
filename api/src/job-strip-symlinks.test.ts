import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as semver from 'semver';
import { Job } from './job';
import type { Runtime } from './runtime';

/**
 * Unit tests for `Job.stripSymlinks` and the `classifyDirent` fallback it now
 * shares. A filesystem that returns DT_UNKNOWN from readdir (some NFS/FUSE/
 * overlay mounts) makes both `Dirent.isDirectory()` and `Dirent.isFile()`
 * report false; without the lstat fallback, stripSymlinks used to treat that
 * as "not a file" and delete the entry outright -- corrupting an ordinary
 * restored file, or skipping recursion into an ordinary restored directory
 * (leaving nested symlinks/special files un-stripped and out of the tar-size
 * estimate).
 */

interface JobInternals {
  stripSymlinks(dir: string): Promise<void>;
  classifyDirent(entry: fs.Dirent, fullPath: string, relativePath: string): Promise<'dir' | 'file' | 'skip'>;
  submissionDir: string;
}

function asInternals(job: Job): JobInternals {
  return job as unknown as JobInternals;
}

/** A Dirent-like object that reports DT_UNKNOWN: not a directory, not a
 *  file, not a symlink -- forcing classifyDirent's lstat fallback. */
function makeUnknownDirent(name: string): fs.Dirent {
  return {
    name,
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as fs.Dirent;
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
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-strip-symlinks-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('Job.classifyDirent DT_UNKNOWN fallback', () => {
  it('resolves a DT_UNKNOWN entry to "file" via lstat when it is really a regular file', async () => {
    const filePath = path.join(tmpDir, 'real-file.txt');
    await fsp.writeFile(filePath, 'hello');
    const job = makeJob();
    asInternals(job).submissionDir = tmpDir;

    const kind = await asInternals(job).classifyDirent(makeUnknownDirent('real-file.txt'), filePath, 'real-file.txt');

    expect(kind).toBe('file');
  });

  it('resolves a DT_UNKNOWN entry to "dir" via lstat when it is really a directory', async () => {
    const dirPath = path.join(tmpDir, 'real-dir');
    await fsp.mkdir(dirPath);
    const job = makeJob();
    asInternals(job).submissionDir = tmpDir;

    const kind = await asInternals(job).classifyDirent(makeUnknownDirent('real-dir'), dirPath, 'real-dir');

    expect(kind).toBe('dir');
  });
});

describe('Job.stripSymlinks', () => {
  it('removes symlinks but keeps regular files and recurses into real directories', async () => {
    await fsp.writeFile(path.join(tmpDir, 'keep.txt'), 'data');
    await fsp.mkdir(path.join(tmpDir, 'nested'));
    await fsp.writeFile(path.join(tmpDir, 'nested', 'keep-nested.txt'), 'data');
    await fsp.symlink('/etc/passwd', path.join(tmpDir, 'nested', 'evil-link'));

    const job = makeJob();
    asInternals(job).submissionDir = tmpDir;
    await asInternals(job).stripSymlinks(tmpDir);

    // Throws (failing the test) if either file was wrongly removed.
    await fsp.access(path.join(tmpDir, 'keep.txt'));
    await fsp.access(path.join(tmpDir, 'nested', 'keep-nested.txt'));
    await expect(fsp.access(path.join(tmpDir, 'nested', 'evil-link'))).rejects.toThrow();
  });

  it('does not corrupt a real file or skip a real directory reported as DT_UNKNOWN', async () => {
    // `fs.Dirent.isDirectory`/`isFile` live on the shared prototype, so
    // patching them for the duration of this test forces every dirent
    // stripSymlinks' own internal readdir() returns to report DT_UNKNOWN
    // (isDirectory() === isFile() === false) -- reproducing what some NFS/
    // FUSE/overlay mounts actually return, without needing such a mount.
    await fsp.writeFile(path.join(tmpDir, 'unknown-file.txt'), 'must survive');
    await fsp.mkdir(path.join(tmpDir, 'unknown-dir'));
    await fsp.writeFile(path.join(tmpDir, 'unknown-dir', 'inside.txt'), 'must also survive');
    await fsp.symlink('/etc/passwd', path.join(tmpDir, 'unknown-link'));

    const origIsDirectory = fs.Dirent.prototype.isDirectory;
    const origIsFile = fs.Dirent.prototype.isFile;
    fs.Dirent.prototype.isDirectory = function () { return false; };
    fs.Dirent.prototype.isFile = function () { return false; };
    try {
      const job = makeJob();
      asInternals(job).submissionDir = tmpDir;
      await asInternals(job).stripSymlinks(tmpDir);
    } finally {
      fs.Dirent.prototype.isDirectory = origIsDirectory;
      fs.Dirent.prototype.isFile = origIsFile;
    }

    // The real file and real directory (misreported as DT_UNKNOWN) must
    // survive via classifyDirent's lstat fallback; the real symlink (also
    // misreported) must still be removed, since lstat correctly identifies
    // it regardless of what the dirent's own type bits said.
    await fsp.access(path.join(tmpDir, 'unknown-file.txt'));
    await fsp.access(path.join(tmpDir, 'unknown-dir', 'inside.txt'));
    await expect(fsp.access(path.join(tmpDir, 'unknown-link'))).rejects.toThrow();
  });
});
