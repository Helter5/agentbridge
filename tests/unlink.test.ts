import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  linkAgentsToHub,
  unlinkAgentsFromHub,
  detectSkillCollisions,
  createNewSkill,
} from '../src/core/skill-linker.js';
import { ensureDir, isSymlinkOrJunction, pathExists } from '../src/utils/fs.js';
import type { DetectedAgent } from '../src/types/client.js';

describe('Unlink and Collision Detection Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentsync-unlink-test-${Date.now()}`);
  const tempHub = path.join(tempDir, 'hub');

  beforeEach(async () => {
    await ensureDir(tempDir);
    await ensureDir(tempHub);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('links an agent and then cleanly unlinks it restoring files', async () => {
    await createNewSkill('sample-skill', {
      description: 'A test skill for unlinking',
      hubPath: tempHub,
    });

    const agentSkills = path.join(tempDir, 'agent-skills');
    const mockAgent: DetectedAgent = {
      id: 'antigravity',
      name: 'Google Antigravity',
      displayName: 'Google Antigravity',
      isInstalled: true,
      paths: {
        configDir: tempDir,
        skillsDir: agentSkills,
      },
      existingSkillsCount: 0,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };

    // 1. Link
    await linkAgentsToHub([mockAgent], tempHub);
    expect(await isSymlinkOrJunction(agentSkills)).toBe(true);

    // 2. Unlink
    const unlinkRes = await unlinkAgentsFromHub([mockAgent], {
      hubPath: tempHub,
      restoreFiles: true,
    });
    expect(unlinkRes[0].success).toBe(true);
    expect(await isSymlinkOrJunction(agentSkills)).toBe(false);
    expect(await pathExists(path.join(agentSkills, 'sample-skill', 'SKILL.md'))).toBe(true);
  });
});

