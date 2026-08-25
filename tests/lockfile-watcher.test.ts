import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('classifies process.kill errors correctly: ESRCH dead, EPERM/unknown alive', () => {
    const originalKill = process.kill;

    try {
      // ESRCH ("no such process") -> genuinely dead.
      process.kill = ((_pid: number, _signal?: string | number) => {
        const err: any = new Error('No such process');
        err.code = 'ESRCH';
        throw err;
      }) as typeof process.kill;
      expect(isProcessAlive(12345)).toBe(false);

      // EPERM (process exists, no permission to signal it) -> alive.
      process.kill = ((_pid: number, _signal?: string | number) => {
        const err: any = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      }) as typeof process.kill;
      expect(isProcessAlive(12345)).toBe(true);

      // An unexpected/unknown error code -> conservatively treated as
      // alive, so a stale-lock check never steals a lock it can't prove
      // is actually abandoned.
      process.kill = ((_pid: number, _signal?: string | number) => {
        const err: any = new Error('Something unexpected');
        err.code = 'EWEIRD';
        throw err;
      }) as typeof process.kill;
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(isProcessAlive(12345)).toBe(true);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    } finally {
      process.kill = originalKill;
    }
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

  // The tests above call acquireLock()/release() sequentially with `await`,
  // which never actually exercises two operations racing for the lock at
  // the same instant - it just proves the state machine's logic in
  // isolation. The tests below start both sides via Promise.all() so they
  // are genuinely in flight concurrently, which is the only way to prove
  // withLock() actually serializes racing writers (finding #3) rather than
  // happening to pass because nothing raced.
  it('never lets two concurrent withLock() callbacks execute their critical section at the same time', async () => {
    const lockFile = path.join(tempDir, '.concurrent.lock');
    let insideCount = 0;
    let maxConcurrentInside = 0;
    const order: string[] = [];

    const contender = (label: string) =>
      withLock(lockFile, async () => {
        insideCount++;
        maxConcurrentInside = Math.max(maxConcurrentInside, insideCount);
        order.push(`${label}-enter`);
        // Hold the lock across a real await, so if withLock() were broken
        // and let both callbacks run at once, this is where they'd overlap.
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push(`${label}-exit`);
        insideCount--;
        return label;
      });

    // Both start in the same tick - a genuine race, not a sequential await.
    const [resultA, resultB] = await Promise.all([contender('A'), contender('B')]);

    // The critical section must never have had two callbacks inside it
    // at once, no matter which one "won".
    expect(maxConcurrentInside).toBe(1);

    // withLock() has no retry/wait loop (see acquireLock): the contender
    // that loses the race gets `null` back and its callback never runs at
    // all - it does not queue and run later. Exactly one of the two must
    // have won.
    const results = [resultA, resultB];
    const winners = results.filter((r) => r !== null);
    expect(winners.length).toBe(1);

    // Whichever one ran, it must have fully entered and exited before
    // anything else touched the critical section (no interleaved enter/enter
    // or enter/exit-of-the-other).
    expect(order.length).toBe(2);
    expect(order[0].split('-')[0]).toBe(order[1].split('-')[0]);
  });

  it('never interleaves or drops bytes when two writers race on the same file under a shared lock', async () => {
    const lockFile = path.join(tempDir, '.write-race.lock');
    const targetFile = path.join(tempDir, 'shared-config.json');
    const payloadA = JSON.stringify({ writer: 'A', data: 'x'.repeat(500) });
    const payloadB = JSON.stringify({ writer: 'B', data: 'y'.repeat(500) });

    const writer = (label: string, payload: string) =>
      withLock(lockFile, async () => {
        // Simulate a real read-modify-write agent-config write: read
        // current state, do async work, then write - the exact shape
        // that raced before finding #3 (CLI vs watcher on the same file).
        await fsp.readFile(targetFile, 'utf-8').catch(() => '');
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fsp.writeFile(targetFile, payload, 'utf-8');
        return label;
      });

    const [resultA, resultB] = await Promise.all([
      writer('A', payloadA),
      writer('B', payloadB),
    ]);

    // Exactly one writer's withLock() call actually ran (see previous
    // test) - the file must contain that writer's payload complete and
    // byte-for-byte, never a truncated or interleaved mix of both.
    const winnerLabel = resultA ?? resultB;
    expect(winnerLabel).not.toBeNull();
    const finalContent = await fsp.readFile(targetFile, 'utf-8');
    const expectedPayload = winnerLabel === 'A' ? payloadA : payloadB;
    expect(finalContent).toBe(expectedPayload);
  });

  it('withLock() retries for maxWaitMs then gives up (returns null) instead of hanging forever', async () => {
    const lockFile = path.join(tempDir, '.retry-exhaust.lock');
    const held = await acquireLock(lockFile);
    expect(held.acquired).toBe(true);

    try {
      const start = Date.now();
      const result = await withLock(lockFile, async () => 'should-not-run', {
        maxWaitMs: 150,
        pollIntervalMs: 30,
      });
      const elapsed = Date.now() - start;

      // Never ran the callback while the lock was held...
      expect(result).toBeNull();
      // ...and it actually retried for roughly maxWaitMs (not an instant
      // single failed attempt, and not an unbounded wait either).
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await held.release();
    }
  });

  it('withLock() retries until the lock frees up, then runs the callback', async () => {
    const lockFile = path.join(tempDir, '.retry-succeed.lock');
    const held = await acquireLock(lockFile);
    expect(held.acquired).toBe(true);

    // Release the lock partway through the retry window, simulating a
    // watcher-held lock that finishes its own brief write.
    setTimeout(() => {
      held.release();
    }, 200);

    const result = await withLock(lockFile, async () => 'ran', {
      maxWaitMs: 2000,
      pollIntervalMs: 50,
    });

    expect(result).toBe('ran');
  });
});
