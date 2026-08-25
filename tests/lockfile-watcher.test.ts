import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { acquireLock, withLock, ensureDir, isProcessAlive } from '../src/utils/fs.js';

describe('Lockfile and Concurrency Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentsync-lock-test-${Date.now()}`);

  beforeEach(async () => {
    await ensureDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('accurately verifies process liveness cross-platform', () => {
    // Current running process must be alive
    expect(isProcessAlive(process.pid)).toBe(true);

    // Completely nonexistent PID must be dead
    expect(isProcessAlive(99999999)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it('acquires lock and blocks concurrent parallel operations', async () => {
    const lockFile = path.join(tempDir, '.lock');

    const lock1 = await acquireLock(lockFile);
    expect(lock1.acquired).toBe(true);

    // Second lock attempt must fail while lock1 is held
    const lock2 = await acquireLock(lockFile);
    expect(lock2.acquired).toBe(false);

    // Release lock1
    await lock1.release();

    // Now lock3 can be acquired
    const lock3 = await acquireLock(lockFile);
    expect(lock3.acquired).toBe(true);
    await lock3.release();
  });

  it('automatically reclaims stale lockfiles from dead processes', async () => {
    const lockFile = path.join(tempDir, '.stale-lock');

    // Simulate crashed process leaving lockfile behind with non-existent PID
    await fsp.writeFile(
      lockFile,
      JSON.stringify({ pid: 99999999, timestamp: new Date(Date.now() - 60000).toISOString() }),
      'utf-8'
    );

    // Should detect dead PID and acquire lock smoothly
    const lock = await acquireLock(lockFile);
    expect(lock.acquired).toBe(true);
    await lock.release();
  });
});
