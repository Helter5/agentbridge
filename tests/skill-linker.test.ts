import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  createNewSkill,
  listSkillsInDirectory,
  readSkillDirectory,
  linkAgentsToHub,
  mergeSkillsIntoHub,
} from '../src/core/skill-linker.js';
import { ensureDir, pathExists, isSymlinkOrJunction } from '../src/utils/fs.js';
import type { DetectedAgent } from '../src/types/client.js';

describe('Skill Linking Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentsync-skills-test-${Date.now()}`);
  const tempHub = path.join(tempDir, 'hub-skills');

  beforeEach(async () => {
    await ensureDir(tempDir);
    await ensureDir(tempHub);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('scaffolds a new skill with valid SKILL.md and frontmatter', async () => {
    const res = await createNewSkill('docker-helper', {
      description: 'Helper skill for Docker operations',
      author: 'Test Author',
      tags: ['docker', 'devops'],
      hubPath: tempHub,
    });

    expect(await pathExists(res.skillPath)).toBe(true);
    expect(res.manifest.isValid).toBe(true);
    expect(res.manifest.frontmatter.name).toBe('docker-helper');
    expect(res.manifest.frontmatter.description).toBe('Helper skill for Docker operations');
    expect(res.manifest.frontmatter.author).toBe('Test Author');
  });

  it('lists skills in directory with metadata', async () => {
    await createNewSkill('skill-a', {
      description: 'Skill A description',
      hubPath: tempHub,
    });
    await createNewSkill('skill-b', {
      description: 'Skill B description',
      hubPath: tempHub,
    });

    const skills = await listSkillsInDirectory(tempHub);
    expect(skills.length).toBe(2);
    expect(skills.map((s) => s.dirName).sort()).toEqual(['skill-a', 'skill-b']);
  });

  it('merges existing skills from an agent into the central hub', async () => {
    const agentSkillsDir = path.join(tempDir, 'agent-custom-skills');
    const existingSkill = path.join(agentSkillsDir, 'legacy-skill');
    await ensureDir(existingSkill);
    await fsp.writeFile(
      path.join(existingSkill, 'SKILL.md'),
      `---\nname: legacy-skill\ndescription: An old skill\n---\n\n# Legacy\n`,
      'utf-8'
    );

    const mockAgent: DetectedAgent = {
      id: 'antigravity',
      name: 'Google Antigravity',
      displayName: 'Google Antigravity',
      isInstalled: true,
      paths: {
        configDir: tempDir,
        skillsDir: agentSkillsDir,
      },
      existingSkillsCount: 1,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };

    const imported = await mergeSkillsIntoHub([mockAgent], tempHub);
    expect(imported.length).toBe(1);

    const hubSkills = await listSkillsInDirectory(tempHub);
    expect(hubSkills.some((s) => s.dirName === 'legacy-skill')).toBe(true);
  });

  it('links an agent to the central hub using cross-platform links', async () => {
    const agentSkillsDir = path.join(tempDir, 'claude-skills');

    const mockAgent: DetectedAgent = {
      id: 'claude',
      name: 'Claude Code',
      displayName: 'Claude Code',
      isInstalled: true,
      paths: {
        configDir: tempDir,
        skillsDir: agentSkillsDir,
      },
      existingSkillsCount: 0,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };

    const summary = await linkAgentsToHub([mockAgent], tempHub);
    expect(summary.linkedAgents[0].success).toBe(true);
    expect(await isSymlinkOrJunction(agentSkillsDir)).toBe(true);
  });
});
