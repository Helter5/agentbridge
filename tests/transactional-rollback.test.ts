import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  createBackupSnapshot,
  restoreBackupSnapshot,
  executeTransactionalOperation,
  pruneBackupSnapshots,
  listBackupSnapshots,
} from '../src/core/rollback.js';
import { syncMcpConfigs } from '../src/core/mcp-sync.js';
import { ensureDir, safeWriteJson } from '../src/utils/fs.js';
import type { DetectedAgent } from '../src/types/client.js';

describe('Transactional Multi-Agent Rollback Suite', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-trans-test-${Date.now()}`);
  let originalBackupsDirEnv: string | undefined;

  beforeEach(async () => {
    await ensureDir(tempDir);
    // executeTransactionalOperation() creates a real snapshot via
    // createBackupSnapshot() before every attempt - isolate it so this
    // test doesn't leave a stray file in ~/.agentbridge/backups.
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

  it('guarantees byte-for-byte exact restoration across multiple files on failure', async () => {
    const file1 = path.join(tempDir, 'agent1.json');
    const file2 = path.join(tempDir, 'agent2.json');
    const file3 = path.join(tempDir, 'agent3.json');

    const originalContent1 = JSON.stringify({ agent: 'antigravity', secret: 'abc123original' }, null, 2);
    const originalContent2 = JSON.stringify({ agent: 'claude', theme: 'dark-original' }, null, 2);
    const originalContent3 = JSON.stringify({ agent: 'codex', version: '1.0.0-original' }, null, 2);

    await fsp.writeFile(file1, originalContent1, 'utf-8');
    await fsp.writeFile(file2, originalContent2, 'utf-8');
    await fsp.writeFile(file3, originalContent3, 'utf-8');

    // Attempt a transaction that mutates file1 & file2, but throws an error on file3
    await expect(
      executeTransactionalOperation('Failing Multi-Agent Sync', [file1, file2, file3], async () => {
        await fsp.writeFile(file1, '{"corrupted": true}', 'utf-8');
        await fsp.writeFile(file2, '{"corrupted": true}', 'utf-8');
        throw new Error('Simulated network/disk crash during 3rd agent update');
      })
    ).rejects.toThrow(/Transactional sync failed/);

    // Verify byte-for-byte exact restoration
    const restored1 = await fsp.readFile(file1, 'utf-8');
    const restored2 = await fsp.readFile(file2, 'utf-8');
    const restored3 = await fsp.readFile(file3, 'utf-8');

    expect(restored1).toBe(originalContent1);
    expect(restored2).toBe(originalContent2);
    expect(restored3).toBe(originalContent3);
  });
});

