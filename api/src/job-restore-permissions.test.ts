import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as semver from 'semver';
import { Job } from './job';
import { config } from './config';
import type { Runtime } from './runtime';

/**
 * Unit tests for the restore-permissions repair path: chownTreeToJobUid
 * (best-effort ownership transfer to the per-job UID) and
 * normalizeRestoredModes (the chmod pass that follows it).
 *
 * Snapshot members are commonly archived at 0600/0700 (owner-only). When
 * chown genuinely transfers ownership to the job UID, `u+rwX` alone is
 * correct -- that UID is now the owner. But when chown is tolerated rather
 * than applied (non-root/local dev mode, mirroring the identical
 * chownOrThrow/applySandboxPathPermissions compatibility path elsewhere in
 * this file), the tree stays runner-owned; `u+rwX` alone would only grant
 * the runner's own UID access and leave the sandboxed (different-UID)
 * process locked out of its own restored files. normalizeRestoredModes must
 * widen group/other in that case too.
 */

interface JobInternals {
  normalizeRestoredModes(dir: string, chownApplied: boolean): Promise<void>;
  chownTreeToJobUid(dir: string): Promise<boolean>;
  jobIdentity: { slot: number; uid: number; gid: number; perJobUid: boolean } | undefined;
}

function asInternals(job: Job): JobInternals {
  return job as unknown as JobInternals;
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
let originalHardenedMode: boolean;
let originalPerJobUids: boolean;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-restore-perms-'));
  originalHardenedMode = config.hardened_sandbox_mode;
  originalPerJobUids = config.per_job_uids;
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  (config as { hardened_sandbox_mode: boolean }).hardened_sandbox_mode = originalHardenedMode;
  (config as { per_job_uids: boolean }).per_job_uids = originalPerJobUids;
});

describe('normalizeRestoredModes', () => {
  it('grants only the owner when chown was actually applied', async () => {
    const filePath = path.join(tmpDir, 'secret.txt');
    await fsp.writeFile(filePath, 'data', { mode: 0o600 });
    const dirPath = path.join(tmpDir, 'private-dir');
    await fsp.mkdir(dirPath, { mode: 0o700 });

    const job = makeJob();
    await asInternals(job).normalizeRestoredModes(tmpDir, true);

    const fileMode = (await fsp.stat(filePath)).mode & 0o777;
    const dirMode = (await fsp.stat(dirPath)).mode & 0o777;
    expect(fileMode & 0o077).toBe(0); // no group/other bits
    expect(dirMode & 0o077).toBe(0);
  });

  it('widens group/other access when chown was tolerated, not applied', async () => {
    const filePath = path.join(tmpDir, 'secret.txt');
    await fsp.writeFile(filePath, 'data', { mode: 0o600 });
    const dirPath = path.join(tmpDir, 'private-dir');
    await fsp.mkdir(dirPath, { mode: 0o700 });

    const job = makeJob();
    await asInternals(job).normalizeRestoredModes(tmpDir, false);

    const fileMode = (await fsp.stat(filePath)).mode & 0o777;
    const dirMode = (await fsp.stat(dirPath)).mode & 0o777;
    // Regular file: read/write for group and other too (no execute, since
    // the owner never had it either).
    expect(fileMode & 0o066).toBe(0o066);
    // Directory: full read/write/traverse for group and other, so a
    // different-UID sandboxed process can still list/enter it.
    expect(dirMode & 0o077).toBe(0o077);
  });
});

describe('chownTreeToJobUid', () => {
  it('returns true when the chown genuinely succeeds', async () => {
    const job = makeJob();
    const applied = await asInternals(job).chownTreeToJobUid(tmpDir);
    expect(applied).toBe(true);
  });

  it('tolerates (returns false) a real chown failure in non-root, non-hardened, non-per-job-UID mode', async () => {
    (config as { hardened_sandbox_mode: boolean }).hardened_sandbox_mode = false;
    const originalGetuid = process.getuid;
    // Spoof "not root" for the tolerance check -- the real chown below still
    // runs with this process's actual (root, in this test environment)
    // privileges, so it must be made to fail for a privilege-independent
    // reason: a nonexistent target directory.
    (process as { getuid?: () => number }).getuid = () => 1000;
    try {
      const job = makeJob();
      const applied = await asInternals(job).chownTreeToJobUid(path.join(tmpDir, 'does-not-exist'));
      expect(applied).toBe(false);
    } finally {
      (process as { getuid?: () => number }).getuid = originalGetuid;
    }
  });

  it('rethrows a chown failure when per-job UIDs are required, even if otherwise tolerant', async () => {
    (config as { hardened_sandbox_mode: boolean }).hardened_sandbox_mode = false;
    const originalGetuid = process.getuid;
    (process as { getuid?: () => number }).getuid = () => 1000;
    try {
      const job = makeJob();
      // sandboxIdentity() only reports perJobUid via this.jobIdentity (set
      // by prime(), not exercised by makeJob()) -- set it directly, same as
      // submissionDir elsewhere, to simulate a per-job-UID-enabled job.
      asInternals(job).jobIdentity = { slot: 0, uid: 70000, gid: 70000, perJobUid: true };
      await expect(
        asInternals(job).chownTreeToJobUid(path.join(tmpDir, 'does-not-exist')),
      ).rejects.toThrow();
    } finally {
      (process as { getuid?: () => number }).getuid = originalGetuid;
    }
  });
});
