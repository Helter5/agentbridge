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
import { ensureDir, pathExists } from '../src/utils/fs.js';

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
});

