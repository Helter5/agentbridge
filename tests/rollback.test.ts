import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  createBackupSnapshot,
  listBackupSnapshots,
  restoreBackupSnapshot,
  getBackupsDirectory,
} from '../src/core/rollback.js';
import { ensureDir, pathExists, acquireLock } from '../src/utils/fs.js';

describe('Rollback & Snapshot Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-rollback-test-${Date.now()}`);
  let originalBackupsDirEnv: string | undefined;

  beforeEach(async () => {
    await ensureDir(tempDir);
    // Isolate every test in this file from the real ~/.agentbridge/backups -
    // createBackupSnapshot()/getBackupsDirectory() previously had no way to
    // redirect this, so every test run here left real snapshot files behind
    // in the developer's actual home directory.
    originalBackupsDirEnv = process.env.AGENTBRIDGE_BACKUPS_DIR;
    process.env.AGENTBRIDGE_BACKUPS_DIR = path.join(tempDir, 'backups');
  });

  afterEach(async () => {
    if (originalBackupsDirEnv === undefined) {
      delete process.env.AGENTBRIDGE_BACKUPS_DIR;
    } else {
      process.env.AGENTBRIDGE_BACKUPS_DIR = originalBackupsDirEnv;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('creates and lists snapshots of target files', async () => {
    const testFile = path.join(tempDir, 'config.json');
    await fsp.writeFile(testFile, JSON.stringify({ state: 'v1' }), 'utf-8');

    const snapshot = await createBackupSnapshot('Pre-sync backup', [testFile]);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.description).toBe('Pre-sync backup');
    expect(snapshot?.files[path.resolve(testFile)]).toContain('v1');

    // Mutate file to v2
    await fsp.writeFile(testFile, JSON.stringify({ state: 'v2' }), 'utf-8');

    // Restore snapshot
    const restoreRes = await restoreBackupSnapshot(snapshot!.id);
    expect(restoreRes.success).toBe(true);

    // Verify v1 restored
    const restoredContent = await fsp.readFile(testFile, 'utf-8');
    expect(restoredContent).toContain('v1');
  });

  it('createBackupSnapshot() retries past a concurrently-held shared lock instead of silently skipping the write', async () => {
    // createBackupSnapshot() locks on the same shared lockfile every
    // agentbridge writer uses (resolveSharedLockPath() in utils/fs.ts).
    // AGENTBRIDGE_LOCK_PATH points that at an isolated tmpdir file for this
    // test instead of the real ~/.agentbridge/.lock, so this test can't
    // collide with an agentbridge command a developer happens to be running
    // in another terminal while the suite executes. Hold that lock
    // externally - simulating a watcher mid-write - and prove
    // createBackupSnapshot() waits it out and actually persists the
    // snapshot to disk, rather than the pre-fix behavior of returning a
    // "snapshot" object that was never written because the lock was busy.
    const isolatedLockPath = path.join(tempDir, 'test.lock');
    const originalLockPathEnv = process.env.AGENTBRIDGE_LOCK_PATH;
    process.env.AGENTBRIDGE_LOCK_PATH = isolatedLockPath;

    try {
      const heldLock = await acquireLock(isolatedLockPath);
      expect(heldLock.acquired).toBe(true);

      const testFile = path.join(tempDir, 'concurrent-config.json');
      await fsp.writeFile(testFile, JSON.stringify({ state: 'held-lock-v1' }), 'utf-8');

      // Free the lock partway through createBackupSnapshot()'s retry
      // window (3000ms), simulating the watcher finishing its own brief write.
      const releaseTimer = setTimeout(() => {
        heldLock.release();
      }, 300);

      let snapshot;
      try {
        snapshot = await createBackupSnapshot('Concurrent-lock test backup', [testFile]);
      } finally {
        clearTimeout(releaseTimer);
        await heldLock.release().catch(() => {});
      }

      expect(snapshot).not.toBeNull();
      // The whole point: the snapshot must actually be on disk, not just an
      // in-memory object handed back after a skipped write. Written to the
      // isolated AGENTBRIDGE_BACKUPS_DIR set in beforeEach, cleaned up
      // automatically with the rest of tempDir in afterEach.
      const backupsDir = getBackupsDirectory();
      const snapshotFile = path.join(backupsDir, `${snapshot!.id}.json`);
      expect(await pathExists(snapshotFile)).toBe(true);
    } finally {
      if (originalLockPathEnv === undefined) {
        delete process.env.AGENTBRIDGE_LOCK_PATH;
      } else {
        process.env.AGENTBRIDGE_LOCK_PATH = originalLockPathEnv;
      }
    }
  }, 6000);

  it('getBackupsDirectory() honors AGENTBRIDGE_BACKUPS_DIR, falling back to the real default when unset', async () => {
    // beforeEach already set an override for this file's other tests -
    // unset it here specifically to check the real-default fallback path.
    delete process.env.AGENTBRIDGE_BACKUPS_DIR;
    const defaultResolved = getBackupsDirectory();
    expect(defaultResolved.endsWith(path.join('.agentbridge', 'backups'))).toBe(true);

    const override = path.join(tempDir, 'custom-backups-location');
    process.env.AGENTBRIDGE_BACKUPS_DIR = override;
    expect(getBackupsDirectory()).toBe(path.resolve(override));
  });
});

