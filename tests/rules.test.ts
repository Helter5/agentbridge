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
import { ensureDir, pathExists } from '../src/utils/fs.js';

describe('Rule Consolidator Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-rules-test-${Date.now()}`);

  beforeEach(async () => {
    await ensureDir(tempDir);
  });

  afterEach(async () => {
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
});
