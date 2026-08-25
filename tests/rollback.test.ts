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
import { ensureDir, pathExists, acquireLock, expandHome } from '../src/utils/fs.js';
import { DEFAULT_LOCK_PATH } from '../src/constants.js';

describe('Rollback & Snapshot Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentsync-rollback-test-${Date.now()}`);

  beforeEach(async () => {
    await ensureDir(tempDir);
  });

  afterEach(async () => {
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
    // createBackupSnapshot() locks on the same real, shared lockfile every
    // agentsync writer uses (see DEFAULT_LOCK_PATH / withLock in
    // rules.ts, skill-linker.ts, this module). Hold that exact lock
    // externally - simulating a watcher mid-write - and prove
    // createBackupSnapshot() waits it out and actually persists the
    // snapshot to disk, rather than the pre-fix behavior of returning a
    // "snapshot" object that was never written because the lock was busy.
    const sharedLockPath = path.resolve(expandHome(DEFAULT_LOCK_PATH));
    const heldLock = await acquireLock(sharedLockPath);
    expect(heldLock.acquired).toBe(true);

    const testFile = path.join(tempDir, 'concurrent-config.json');
    await fsp.writeFile(testFile, JSON.stringify({ state: 'held-lock-v1' }), 'utf-8');

    // Free the shared lock partway through createBackupSnapshot()'s retry
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
    // in-memory object handed back after a skipped write.
    const backupsDir = getBackupsDirectory();
    const snapshotFile = path.join(backupsDir, `${snapshot!.id}.json`);
    expect(await pathExists(snapshotFile)).toBe(true);

    // Clean up the real snapshot file this test wrote to the shared
    // backups directory - don't leave test artifacts in the user's
    // ~/.agentsync/backups.
    await fsp.unlink(snapshotFile).catch(() => {});
  }, 6000);
});

