import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  findRuleSourceFile,
  initAgentsRuleFile,
  syncProjectRules,
  inspectProjectRules,
} from '../src/core/rules.js';
import { listBackupSnapshots, restoreBackupSnapshot } from '../src/core/rollback.js';
import { ensureDir, pathExists } from '../src/utils/fs.js';

describe('Rule Consolidator Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-rules-test-${Date.now()}`);
  let originalBackupsDirEnv: string | undefined;

  beforeEach(async () => {
    await ensureDir(tempDir);
    // Isolate from the real ~/.agentbridge/backups - syncProjectRules() now
    // snapshots overwritten target files through rollback.ts's tracked
    // system (see rollback.test.ts for the same reasoning).
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

  it('finds existing AGENTS.md in project directory', async () => {
    const agentsMd = path.join(tempDir, 'AGENTS.md');
    await fsp.writeFile(agentsMd, '# Agents Guide', 'utf-8');

    const found = await findRuleSourceFile(tempDir);
    expect(found).toBe(agentsMd);
  });

  it('initializes AGENTS.md when none exists', async () => {
    const createdPath = await initAgentsRuleFile(tempDir, 'TestProject');
    expect(await pathExists(createdPath)).toBe(true);

    const content = await fsp.readFile(createdPath, 'utf-8');
    expect(content).toContain('TestProject');
    expect(content).toContain('AI Agent Instructions');
  });

  it('synchronizes AGENTS.md to CLAUDE.md, GEMINI.md, and .cursorrules', async () => {
    const agentsMd = path.join(tempDir, 'AGENTS.md');
    await fsp.writeFile(agentsMd, '# Core Rules\n1. Always test code.', 'utf-8');

    const result = await syncProjectRules(tempDir, { mode: 'copy' });
    expect(result.sourcePath).toBe(agentsMd);

    const claudeMd = path.join(tempDir, 'CLAUDE.md');
    const geminiMd = path.join(tempDir, 'GEMINI.md');
    const cursorRules = path.join(tempDir, '.cursorrules');

    expect(await pathExists(claudeMd)).toBe(true);
    expect(await pathExists(geminiMd)).toBe(true);
    expect(await pathExists(cursorRules)).toBe(true);

    const claudeContent = await fsp.readFile(claudeMd, 'utf-8');
    expect(claudeContent).toContain('# Core Rules');
    expect(claudeContent).toContain('Auto-synchronized by AgentBridge');

    const inspection = await inspectProjectRules(tempDir);
    const claudeTarget = inspection.targets.find((t) => t.fileName === 'CLAUDE.md');
    expect(claudeTarget?.status).toBe('synced');
  });

  it('syncProjectRules({ mode: "symlink" }) reports "hardlinked" (not "symlinked") when the platform falls back to a hardlink', async () => {
    // Companion to the createCrossPlatformLink() test in fs.test.ts, at the
    // rules.ts call-site level: --mode symlink must never claim
    // 'Symlinked to source' for a link that is actually a hardlink, since
    // README promises symlink mode keeps files in sync automatically and a
    // hardlink can silently go stale (see fs.test.ts for the exact
    // reproduction).
    const agentsMd = path.join(tempDir, 'AGENTS.md');
    await fsp.writeFile(agentsMd, '# Core Rules\n1. Always test code.', 'utf-8');

    const symlinkSpy = vi.spyOn(fsp, 'symlink').mockRejectedValue(
      Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' })
    );

    try {
      const result = await syncProjectRules(tempDir, { mode: 'symlink' });
      const claudeResult = result.targets.find((t) => t.fileName === 'CLAUDE.md');
      expect(claudeResult?.action).toBe('hardlinked');

      const claudeMd = path.join(tempDir, 'CLAUDE.md');
      expect(await pathExists(claudeMd)).toBe(true);
      expect(await fsp.readFile(claudeMd, 'utf-8')).toContain('# Core Rules');
    } finally {
      symlinkSpy.mockRestore();
    }
  });

  it('syncProjectRules() snapshots an existing CLAUDE.md before overwriting it, and agentbridge rollback restores it byte-for-byte', async () => {
    // The data-loss gap this closes: sync-rules used to overwrite an
    // existing target file with zero backup of any kind - not even
    // link-skills' own untracked sibling-folder backup. Now it goes
    // through rollback.ts's tracked snapshot system (same one sync-mcp
    // uses), so `agentbridge rollback` can undo it.
    const agentsMd = path.join(tempDir, 'AGENTS.md');
    await fsp.writeFile(agentsMd, '# New rules from AGENTS.md', 'utf-8');

    const claudeMd = path.join(tempDir, 'CLAUDE.md');
    const originalClaudeContent = 'MANUALLY CUSTOMIZED - irreplaceable notes, not in AGENTS.md';
    await fsp.writeFile(claudeMd, originalClaudeContent, 'utf-8');

    const snapshotsBefore = await listBackupSnapshots();
    expect(snapshotsBefore.length).toBe(0);

    await syncProjectRules(tempDir, { mode: 'copy' });

    // Overwritten as expected...
    const afterOverwrite = await fsp.readFile(claudeMd, 'utf-8');
    expect(afterOverwrite).not.toContain(originalClaudeContent);
    expect(afterOverwrite).toContain('# New rules from AGENTS.md');

    // ...but a snapshot of the pre-overwrite content now exists.
    const snapshotsAfter = await listBackupSnapshots();
    expect(snapshotsAfter.length).toBe(1);
    expect(snapshotsAfter[0].description).toBe('Rule Files Sync');
    expect(snapshotsAfter[0].files[path.resolve(claudeMd)]).toBe(originalClaudeContent);

    // agentbridge rollback restores it byte-for-byte.
    const rollbackResult = await restoreBackupSnapshot(snapshotsAfter[0].id);
    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.failedFiles).toEqual([]);
    const restoredContent = await fsp.readFile(claudeMd, 'utf-8');
    expect(restoredContent).toBe(originalClaudeContent);
  });

  it('syncProjectRules() creates no backup snapshot on a first run where no target files exist yet', async () => {
    const agentsMd = path.join(tempDir, 'AGENTS.md');
    await fsp.writeFile(agentsMd, '# Fresh project, no targets yet', 'utf-8');

    // Confirm the premise: none of the targets exist before syncing.
    expect(await pathExists(path.join(tempDir, 'CLAUDE.md'))).toBe(false);
    expect(await pathExists(path.join(tempDir, 'GEMINI.md'))).toBe(false);
    expect(await pathExists(path.join(tempDir, '.cursorrules'))).toBe(false);

    await syncProjectRules(tempDir, { mode: 'copy' });

    expect(await pathExists(path.join(tempDir, 'CLAUDE.md'))).toBe(true);

    // Nothing existed to protect, so no snapshot should have been written.
    const snapshots = await listBackupSnapshots();
    expect(snapshots.length).toBe(0);
  });

  it('syncProjectRules({ backupExisting: false }) overwrites an existing target with no snapshot (--no-backup)', async () => {
    const agentsMd = path.join(tempDir, 'AGENTS.md');
    await fsp.writeFile(agentsMd, '# New rules', 'utf-8');
    const claudeMd = path.join(tempDir, 'CLAUDE.md');
    await fsp.writeFile(claudeMd, 'old content', 'utf-8');

    await syncProjectRules(tempDir, { mode: 'copy', backupExisting: false });

    const afterOverwrite = await fsp.readFile(claudeMd, 'utf-8');
    expect(afterOverwrite).toContain('# New rules');
    expect(await listBackupSnapshots()).toEqual([]);
  });
});
