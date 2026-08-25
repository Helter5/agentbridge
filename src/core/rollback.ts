import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  expandHome,
  ensureDir,
  pathExists,
  safeReadJson,
  safeWriteJson,
  chmodBestEffort,
  withLock,
} from '../utils/fs.js';
import { DEFAULT_LOCK_PATH } from '../constants.js';

const lockFilePath = path.resolve(expandHome(DEFAULT_LOCK_PATH));

export interface BackupSnapshot {
  id: string;
  timestamp: string;
  description: string;
  files: Record<string, string>; // path -> content
}

export function getBackupsDirectory(): string {
  return path.resolve(expandHome('~/.agentsync/backups'));
}

/**
 * Creates a timestamped backup snapshot of files before modifying them
 */
export async function createBackupSnapshot(
  description: string,
  filePaths: string[]
): Promise<BackupSnapshot | null> {
  const backupsDir = getBackupsDirectory();
  await ensureDir(backupsDir);

  const files: Record<string, string> = {};
  for (const filePath of filePaths) {
    const absPath = path.resolve(expandHome(filePath));
    if (await pathExists(absPath)) {
      try {
        const content = await fsp.readFile(absPath, 'utf-8');
        files[absPath] = content;
      } catch {
        // Skip unreadable
      }
    }
  }

  if (Object.keys(files).length === 0) {
    return null;
  }

  const id = `snapshot-${Date.now()}`;
  const snapshot: BackupSnapshot = {
    id,
    timestamp: new Date().toISOString(),
    description,
    files,
  };

  const snapshotFile = path.join(backupsDir, `${id}.json`);
  await withLock(lockFilePath, async () => {
    await safeWriteJson(snapshotFile, snapshot);
  });
  return snapshot;
}

/**
 * Lists all available backup snapshots
 */
export async function listBackupSnapshots(): Promise<BackupSnapshot[]> {
  const backupsDir = getBackupsDirectory();
  if (!(await pathExists(backupsDir))) return [];

  const entries = await fsp.readdir(backupsDir);
  const snapshots: BackupSnapshot[] = [];

  for (const file of entries.filter((e) => e.endsWith('.json'))) {
    const filePath = path.join(backupsDir, file);
    const data = await safeReadJson<BackupSnapshot>(filePath);
    if (data && data.id && data.files) {
      snapshots.push(data);
    }
  }

  return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export interface RollbackResult {
  success: boolean;
  restoredFiles: string[];
  failedFiles: Array<{ path: string; error: string }>;
  error?: string;
}

/**
 * Restores files from a specific snapshot
 */
export async function restoreBackupSnapshot(snapshotId: string): Promise<RollbackResult> {
  const backupsDir = getBackupsDirectory();
  const snapshotFile = path.join(backupsDir, `${snapshotId}.json`);

  if (!(await pathExists(snapshotFile))) {
    return {
      success: false,
      restoredFiles: [],
      failedFiles: [],
      error: `Snapshot not found: ${snapshotId}`,
    };
  }

  const snapshot = await safeReadJson<BackupSnapshot>(snapshotFile);
  if (!snapshot || !snapshot.files) {
    return {
      success: false,
      restoredFiles: [],
      failedFiles: [],
      error: `Invalid snapshot file: ${snapshotFile}`,
    };
  }

  const restoredFiles: string[] = [];
  const failedFiles: Array<{ path: string; error: string }> = [];

  for (const [filePath, content] of Object.entries(snapshot.files)) {
    try {
      await ensureDir(path.dirname(filePath));
      await fsp.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
      await chmodBestEffort(filePath, 0o600);
      restoredFiles.push(filePath);
    } catch (err: any) {
      failedFiles.push({
        path: filePath,
        error: err.message || String(err),
      });
    }
  }

  const isCompleteSuccess = failedFiles.length === 0;

  return {
    success: isCompleteSuccess,
    restoredFiles,
    failedFiles,
    error: isCompleteSuccess
      ? undefined
      : `Failed to restore ${failedFiles.length} file(s): ${failedFiles.map((f) => `${f.path} (${f.error})`).join('; ')}`,
  };
}

/**
 * Prunes old backup snapshots keeping only the most recent ones
 */
export async function pruneBackupSnapshots(maxSnapshots = 20): Promise<number> {
  const backupsDir = getBackupsDirectory();

  // List + delete run under the same lockfile that guards snapshot creation,
  // so a concurrent createBackupSnapshot() / watch cycle can't race the
  // read-then-unlink sequence below.
  const result = await withLock(lockFilePath, async () => {
    const snapshots = await listBackupSnapshots();

    if (snapshots.length <= maxSnapshots) {
      return 0;
    }

    const toDelete = snapshots.slice(maxSnapshots);
    let deletedCount = 0;

    for (const snap of toDelete) {
      const snapFile = path.join(backupsDir, `${snap.id}.json`);
      try {
        await fsp.unlink(snapFile);
        deletedCount++;
      } catch {
        // Ignore
      }
    }

    return deletedCount;
  });

  return result ?? 0;
}

/**
 * Executes a multi-file operation atomically across all agent configs.
 * If any step fails, automatically rolls back all files to their pre-operation state.
 */
export async function executeTransactionalOperation<T>(
  description: string,
  targetFilePaths: string[],
  operation: () => Promise<T>
): Promise<T> {
  const snapshot = await createBackupSnapshot(description, targetFilePaths);

  try {
    const result = await operation();
    await pruneBackupSnapshots(20);
    return result;
  } catch (operationError: any) {
    // Transaction failed -> trigger automated multi-agent rollback!
    const operationMessage = operationError.message || String(operationError);

    if (snapshot) {
      const rollbackResult = await restoreBackupSnapshot(snapshot.id);
      if (rollbackResult.failedFiles.length > 0) {
        throw new Error(
          `Transactional sync failed: ${operationMessage}. Rollback ALSO failed to restore ${rollbackResult.failedFiles.length} file(s): ${rollbackResult.failedFiles
            .map((f) => `${f.path} (${f.error})`)
            .join('; ')}. Agent configs may be left in a partially-modified state - restore manually from snapshot ${snapshot.id}.`
        );
      }
    }

    throw new Error(
      `Transactional sync failed: ${operationMessage}. Automatically rolled back all agent configs to pre-operation state.`
    );
  }
}


