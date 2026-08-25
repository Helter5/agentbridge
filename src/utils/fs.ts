import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_LOCK_PATH } from '../constants.js';

/**
 * Resolves the single shared lockfile every agentsync writer (CLI
 * commands, watcher, rollback snapshots) contends on. Honors
 * AGENTSYNC_LOCK_PATH so tests can point it at an isolated tmpdir instead
 * of the real ~/.agentsync/.lock, without any FS-level mocking.
 *
 * Deliberately NOT memoized into a module-level constant: callers that
 * did that (frozen at first import) could never pick up a test's env
 * override, and would also freeze os.homedir() for the process lifetime.
 * Call this at the point of use instead.
 */
export function resolveSharedLockPath(): string {
  return path.resolve(expandHome(process.env.AGENTSYNC_LOCK_PATH || DEFAULT_LOCK_PATH));
}

/**
 * Expands leading ~ in path to user home directory
 */
export function expandHome(filePath: string): string {
  if (!filePath) return filePath;
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~\\') || filePath.startsWith('~/')) {
    const subParts = filePath.slice(2).split(/[/\\]+/).filter(Boolean);
    return path.join(os.homedir(), ...subParts);
  }
  return filePath;
}

/**
 * Contracts home directory path to ~ for readable output
 */
export function contractHome(filePath: string): string {
  if (!filePath) return filePath;
  const home = os.homedir();
  if (filePath === home) return '~';
  if (filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

/**
 * Checks if a path exists
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous path exists check
 */
export function pathExistsSync(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures a directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

/**
 * Checks whether a path is a symbolic link or Windows junction
 */
export async function isSymlinkOrJunction(p: string): Promise<boolean> {
  try {
    const lstat = await fsp.lstat(p);
    return lstat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolves the real target path of a symlink / junction
 */
export async function readLinkTarget(p: string): Promise<string | null> {
  try {
    const lstat = await fsp.lstat(p);
    if (!lstat.isSymbolicLink()) return null;
    return await fsp.readlink(p);
  } catch {
    return null;
  }
}

/**
 * Safely reads and parses a JSON file
 */
export async function safeReadJson<T = unknown>(filePath: string): Promise<T | null> {
  try {
    if (!(await pathExists(filePath))) return null;
    const content = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Safely writes formatted JSON to file with atomic write.
 * Restricts the file to owner-only read/write (0o600), since these files
 * can contain MCP server credentials. The `mode` passed to writeFile only
 * applies when the file is newly created, so an explicit chmod covers the
 * case where an existing, more permissive file is being overwritten.
 */
export async function safeWriteJson(
  filePath: string,
  data: unknown,
  indent = 2
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const content = JSON.stringify(data, null, indent) + '\n';
  await fsp.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  await chmodBestEffort(filePath, 0o600);
}

/**
 * Best-effort chmod: some platforms/filesystems (e.g. Windows FAT/exFAT
 * volumes) don't support POSIX permission bits, so failures are swallowed
 * rather than breaking the write that already succeeded.
 */
export async function chmodBestEffort(filePath: string, mode: number): Promise<void> {
  try {
    await fsp.chmod(filePath, mode);
  } catch {
    // Ignore - not all platforms/filesystems support chmod.
  }
}

/**
 * Recursively copies a directory
 */
export async function copyDirRecursive(
  src: string,
  dest: string,
  overwrite = false
): Promise<void> {
  await ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, overwrite);
    } else if (entry.isFile()) {
      if (!overwrite && (await pathExists(destPath))) {
        continue;
      }
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Backs up an existing path by renaming it with a timestamp
 */
export async function backupPath(targetPath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${targetPath}.backup-${timestamp}`;
  await fsp.rename(targetPath, backup);
  return backup;
}

/**
 * Removes a file, symlink, or directory cleanly
 */
export async function removeLinkOrDir(p: string): Promise<void> {
  try {
    const lstat = await fsp.lstat(p);
    if (lstat.isSymbolicLink()) {
      if (process.platform === 'win32' && lstat.isDirectory()) {
        await fsp.rmdir(p);
      } else {
        await fsp.unlink(p);
      }
    } else if (lstat.isDirectory()) {
      await fsp.rm(p, { recursive: true, force: true });
    } else {
      await fsp.unlink(p);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

export interface LinkResult {
  success: boolean;
  action: 'created' | 'already_linked' | 'fallback_copied';
  error?: string;
}

/**
 * Creates cross-platform symlink or junction
 * - On Windows: uses 'junction' for directories (no admin required)
 * - On macOS/Linux: uses POSIX symlink
 */
export async function createCrossPlatformLink(
  targetPath: string,
  linkPath: string,
  type: 'dir' | 'file' = 'dir'
): Promise<LinkResult> {
  try {
    const absTarget = path.resolve(targetPath);
    const absLink = path.resolve(linkPath);

    if (!(await pathExists(absTarget))) {
      return {
        success: false,
        action: 'created',
        error: `Target path does not exist: ${absTarget}`,
      };
    }

    await ensureDir(path.dirname(absLink));

    // Check if link already exists
    if (await pathExists(absLink) || (await isSymlinkOrJunction(absLink))) {
      const isLink = await isSymlinkOrJunction(absLink);
      if (isLink) {
        const currentTarget = await readLinkTarget(absLink);
        if (
          currentTarget &&
          (path.resolve(currentTarget) === absTarget ||
            currentTarget === absTarget)
        ) {
          return { success: true, action: 'already_linked' };
        }
      }
      // Remove existing item if we need to replace it
      await removeLinkOrDir(absLink);
    }

    const isWindows = process.platform === 'win32';

    if (type === 'dir') {
      const symlinkType = isWindows ? 'junction' : 'dir';
      await fsp.symlink(absTarget, absLink, symlinkType);
      return { success: true, action: 'created' };
    } else {
      // File link
      try {
        await fsp.symlink(absTarget, absLink, isWindows ? 'file' : undefined);
        return { success: true, action: 'created' };
      } catch (symlinkErr) {
        // On Windows without Developer Mode, file symlink may fail with EPERM.
        // Fall back to hardlink or file copy
        try {
          await fsp.link(absTarget, absLink);
          return { success: true, action: 'created' };
        } catch {
          await fsp.copyFile(absTarget, absLink);
          return { success: true, action: 'fallback_copied' };
        }
      }
    }
  } catch (error: any) {
    return {
      success: false,
      action: 'created',
      error: error.message || String(error),
    };
  }
}

/**
 * Checks if a process with the given PID is currently active.
 * process.kill(pid, 0) sends no actual signal - it's a Node/libuv
 * cross-platform existence probe (works on Windows too, not just POSIX).
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      // No such process - genuinely dead.
      return false;
    }
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      // Process exists but we lack permission to signal it - still alive.
      return true;
    }
    // Unknown/unexpected error: don't assume the process is dead, since
    // acquireLock() uses this result to decide whether to steal another
    // process's lockfile. Log it and err on the side of "alive" so we
    // don't clear a lock that's still legitimately held.
    console.error(`isProcessAlive: unexpected error checking pid ${pid}:`, err);
    return true;
  }
}

/**
 * Acquires a non-blocking lockfile to prevent race conditions during parallel syncs
 */
export async function acquireLock(
  lockFilePath: string,
  maxAgeMs = 10000
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  const absLock = path.resolve(expandHome(lockFilePath));
  await ensureDir(path.dirname(absLock));

  // Check if existing lock is stale (dead PID or expired timestamp)
  if (await pathExists(absLock)) {
    try {
      const content = await fsp.readFile(absLock, 'utf-8');
      const lockData = JSON.parse(content);
      const isAlive = lockData?.pid ? isProcessAlive(lockData.pid) : false;
      const stats = await fsp.stat(absLock);
      const age = Date.now() - stats.mtimeMs;

      if (!isAlive || age > maxAgeMs) {
        // Process crashed or lock expired -> clear stale lock
        await fsp.unlink(absLock);
      } else {
        return {
          acquired: false,
          release: async () => {},
        };
      }
    } catch {
      // In case of corrupt lockfile, attempt to clean it up
      try {
        await fsp.unlink(absLock);
      } catch {
        // Ignore
      }
    }
  }

  try {
    const handle = await fsp.open(absLock, 'wx', 0o600);
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      'utf-8'
    );
    await handle.close();
    await chmodBestEffort(absLock, 0o600);

    return {
      acquired: true,
      release: async () => {
        try {
          await fsp.unlink(absLock);
        } catch {
          // Ignore
        }
      },
    };
  } catch {
    return {
      acquired: false,
      release: async () => {},
    };
  }
}

export interface WithLockOptions {
  onBusy?: () => void;
  /**
   * How long to keep retrying to acquire the lock before giving up, in ms.
   * Default 0 = a single attempt, no retry (matches the original
   * behavior - appropriate for a long-running watcher, which will simply
   * pick the change up again on its next debounce). One-shot CLI writers
   * should pass a few seconds here so a brief overlap with another
   * agentsync process resolves itself instead of silently no-op'ing.
   */
  maxWaitMs?: number;
  /** Delay between retry attempts, in ms. Default 100. */
  pollIntervalMs?: number;
}

/**
 * Runs an async operation with a lockfile. Returns null (fn is never
 * called) if the lock could not be acquired within maxWaitMs - callers
 * MUST check for null rather than assuming fn ran, since that's the only
 * signal that the write was skipped due to lock contention.
 */
export async function withLock<T>(
  lockFilePath: string,
  fn: () => Promise<T>,
  options: WithLockOptions = {}
): Promise<T | null> {
  const { onBusy, maxWaitMs = 0, pollIntervalMs = 100 } = options;
  const deadline = Date.now() + maxWaitMs;

  let lock = await acquireLock(lockFilePath);
  while (!lock.acquired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    lock = await acquireLock(lockFilePath);
  }

  if (!lock.acquired) {
    if (onBusy) onBusy();
    return null;
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

