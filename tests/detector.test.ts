import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { detectInstalledAgents, SUPPORTED_AGENTS } from '../src/core/detector.js';
import { safeWriteJson, ensureDir } from '../src/utils/fs.js';

describe('Client Detector Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-detector-test-${Date.now()}`);
  const tempHub = path.join(tempDir, 'hub');

  beforeEach(async () => {
    await ensureDir(tempDir);
    await ensureDir(tempHub);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('defines all 4 core AI coding agents in registry', () => {
    expect(SUPPORTED_AGENTS.antigravity).toBeDefined();
    expect(SUPPORTED_AGENTS.claude).toBeDefined();
    expect(SUPPORTED_AGENTS.codex).toBeDefined();
    expect(SUPPORTED_AGENTS.cursor).toBeDefined();
  });

  it('detects agent presence when config files or directories exist', async () => {
    const agents = await detectInstalledAgents({
      customHubPath: tempHub,
      checkAll: true,
    });

    expect(agents.length).toBe(Object.keys(SUPPORTED_AGENTS).length);
    const antigravity = agents.find((a) => a.id === 'antigravity');
    expect(antigravity).toBeDefined();
    expect(antigravity?.name).toBe('Google Antigravity');
  });

  it('existingSkillsCount only counts directories that actually contain SKILL.md, not any unrelated subdirectory', async () => {
    // Found via manual testing: the previous implementation's if/else on
    // SKILL.md presence incremented the count in BOTH branches - dead
    // code that made the check pointless. A directory with 2 real skills
    // plus one unrelated subdirectory (no SKILL.md at all - a broken
    // partial copy, a stray .git, anything) reported 3, not 2.
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const fakeHome = path.join(tempDir, 'fake-home');
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    try {
      const skillsDir = path.join(fakeHome, '.claude', 'skills');
      await ensureDir(path.join(skillsDir, 'skill-a'));
      await fsp.writeFile(
        path.join(skillsDir, 'skill-a', 'SKILL.md'),
        '---\nname: skill-a\ndescription: a\n---\n',
        'utf-8'
      );
      await ensureDir(path.join(skillsDir, 'skill-b'));
      await fsp.writeFile(
        path.join(skillsDir, 'skill-b', 'SKILL.md'),
        '---\nname: skill-b\ndescription: b\n---\n',
        'utf-8'
      );
      // Unrelated subdirectory - no SKILL.md at all.
      await ensureDir(path.join(skillsDir, 'not-a-skill'));

      const agents = await detectInstalledAgents({ customHubPath: tempHub, checkAll: true });
      const claude = agents.find((a) => a.id === 'claude');
      expect(claude?.existingSkillsCount).toBe(2);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('existingSkillsCount still counts a standalone markdown_file-type skill (a loose .md, not in its own folder)', async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const fakeHome = path.join(tempDir, 'fake-home-2');
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    try {
      const skillsDir = path.join(fakeHome, '.claude', 'skills');
      await ensureDir(skillsDir);
      await fsp.writeFile(
        path.join(skillsDir, 'loose-skill.md'),
        '---\nname: loose-skill\ndescription: standalone\n---\n',
        'utf-8'
      );

      const agents = await detectInstalledAgents({ customHubPath: tempHub, checkAll: true });
      const claude = agents.find((a) => a.id === 'claude');
      expect(claude?.existingSkillsCount).toBe(1);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });
});
