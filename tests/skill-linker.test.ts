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
  selectivelyImportSkills,
  sanitizeSkillDirName,
} from '../src/core/skill-linker.js';
import { ensureDir, pathExists, isSymlinkOrJunction } from '../src/utils/fs.js';
import type { DetectedAgent } from '../src/types/client.js';
import type { DiscoveredSkill } from '../src/types/skill.js';

describe('Skill Linking Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-skills-test-${Date.now()}`);
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

  it('createNewSkill() refuses to overwrite an already-existing skill (LOW-004)', async () => {
    await createNewSkill('docker-helper', {
      description: 'Original description',
      author: 'Original Author',
      hubPath: tempHub,
    });

    const skillFile = path.join(tempHub, 'docker-helper', 'SKILL.md');
    const originalContent = await fsp.readFile(skillFile, 'utf-8');
    expect(originalContent).toContain('Original description');

    // Calling it again with the same (sanitized) name, no overwrite
    // mechanism exists on add-skill - must fail, not silently replace.
    await expect(
      createNewSkill('docker-helper', {
        description: 'A different, colliding description',
        author: 'Different Author',
        hubPath: tempHub,
      })
    ).rejects.toThrow('already exists');

    const contentAfterCollision = await fsp.readFile(skillFile, 'utf-8');
    expect(contentAfterCollision).toBe(originalContent);
    expect(contentAfterCollision).not.toContain('A different, colliding description');
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

  it('sanitizeSkillDirName() strips path traversal and separator characters', () => {
    expect(sanitizeSkillDirName('../../../../.ssh/authorized_keys')).not.toContain('..');
    expect(sanitizeSkillDirName('../../../../.ssh/authorized_keys')).not.toContain('/');
    expect(sanitizeSkillDirName('docker-helper')).toBe('docker-helper');
    expect(sanitizeSkillDirName('')).toBe('unnamed-skill');
    expect(sanitizeSkillDirName('   ')).toBe('unnamed-skill');
  });

  it('selectivelyImportSkills() neutralizes a path-traversal payload in a discovered skill name instead of writing outside the target directory', async () => {
    // A malicious skill's SKILL.md frontmatter `name:` field has no format
    // restriction (SkillFrontmatterSchema.name is a bare optional string),
    // so a value like this is exactly what discoverAllAvailableSkills()
    // would hand back for a crafted skill package.
    const maliciousSourceDir = path.join(tempDir, 'malicious-skill-source');
    await ensureDir(maliciousSourceDir);
    await fsp.writeFile(
      path.join(maliciousSourceDir, 'SKILL.md'),
      `---\nname: ../../../../escaped-payload\ndescription: looks harmless in the picker\n---\n\n# Evil\n`,
      'utf-8'
    );

    const importTarget = path.join(tempDir, 'import-target');
    await ensureDir(importTarget);

    const maliciousSkill: DiscoveredSkill = {
      id: 'evil:payload',
      name: '../../../../escaped-payload',
      agentId: 'evil',
      agentName: 'Evil Agent',
      description: 'looks harmless in the picker',
      sourcePath: maliciousSourceDir,
      type: 'directory',
    };

    const result = await selectivelyImportSkills([maliciousSkill], importTarget);

    // The traversal characters are stripped, so the import still succeeds
    // - just confined to a sanitized directory name inside importTarget,
    // never escaping it.
    expect(result.failedSkills).toEqual([]);
    expect(await pathExists(path.join(importTarget, 'escaped-payload', 'SKILL.md'))).toBe(true);

    // The whole point: nothing was written outside importTarget via
    // traversal - the unsanitized path.join(importTarget, skill.name)
    // would have resolved several directories above tempDir.
    const escapedPath = path.resolve(importTarget, '../../../../escaped-payload');
    expect(await pathExists(escapedPath)).toBe(false);
  });

  it('selectivelyImportSkills() still imports a normally-named skill successfully', async () => {
    const sourceDir = path.join(tempDir, 'normal-skill-source');
    await ensureDir(sourceDir);
    await fsp.writeFile(
      path.join(sourceDir, 'SKILL.md'),
      `---\nname: normal-skill\ndescription: a perfectly normal skill\n---\n\n# Normal\n`,
      'utf-8'
    );

    const importTarget = path.join(tempDir, 'import-target-2');
    await ensureDir(importTarget);

    const normalSkill: DiscoveredSkill = {
      id: 'good:normal-skill',
      name: 'normal-skill',
      agentId: 'good',
      agentName: 'Good Agent',
      description: 'a perfectly normal skill',
      sourcePath: sourceDir,
      type: 'directory',
    };

    const result = await selectivelyImportSkills([normalSkill], importTarget);

    expect(result.failedSkills).toEqual([]);
    expect(result.importedSkills).toEqual(['normal-skill']);
    expect(await pathExists(path.join(importTarget, 'normal-skill', 'SKILL.md'))).toBe(true);
  });

  it('selectivelyImportSkills() skips a markdown_file skill whose sanitized name collides with an already-imported one, without overwrite', async () => {
    // "My Skill!!!" and "my-skill" both sanitize to the same destDir - a
    // realistic collision (same skill present in two agents' directories,
    // or a crafted name deliberately chosen to collide).
    const sourceA = path.join(tempDir, 'source-a.md');
    await fsp.writeFile(
      sourceA,
      `---\nname: my-skill\ndescription: original skill A\n---\n\nORIGINAL_A_CONTENT_MARKER\n`,
      'utf-8'
    );
    const sourceB = path.join(tempDir, 'source-b.md');
    await fsp.writeFile(
      sourceB,
      `---\nname: my-skill\ndescription: colliding skill B\n---\n\nDIFFERENT_B_CONTENT_MARKER\n`,
      'utf-8'
    );

    const importTarget = path.join(tempDir, 'import-target-collision');
    await ensureDir(importTarget);

    const skillA: DiscoveredSkill = {
      id: 'agent-a:my-skill',
      name: 'My Skill!!!',
      agentId: 'agent-a',
      agentName: 'Agent A',
      description: 'original skill A',
      sourcePath: sourceA,
      type: 'markdown_file',
    };
    const skillB: DiscoveredSkill = {
      id: 'agent-b:my-skill',
      name: 'my-skill',
      agentId: 'agent-b',
      agentName: 'Agent B',
      description: 'colliding skill B',
      sourcePath: sourceB,
      type: 'markdown_file',
    };

    const firstResult = await selectivelyImportSkills([skillA], importTarget);
    expect(firstResult.failedSkills).toEqual([]);
    expect(firstResult.importedSkills).toEqual(['My Skill!!!']);

    const skillFilePath = path.join(importTarget, 'my-skill', 'SKILL.md');
    const contentAfterFirstImport = await fsp.readFile(skillFilePath, 'utf-8');
    expect(contentAfterFirstImport).toContain('ORIGINAL_A_CONTENT_MARKER');

    // Import the colliding skill without overwrite - must be skipped, not
    // silently clobber A's content.
    const secondResult = await selectivelyImportSkills([skillB], importTarget);
    expect(secondResult.importedSkills).toEqual([]);
    expect(secondResult.failedSkills).toHaveLength(1);
    expect(secondResult.failedSkills[0].name).toBe('my-skill');
    expect(secondResult.failedSkills[0].error).toContain('already exists');

    const contentAfterSkippedImport = await fsp.readFile(skillFilePath, 'utf-8');
    expect(contentAfterSkippedImport).toBe(contentAfterFirstImport);
    expect(contentAfterSkippedImport).not.toContain('DIFFERENT_B_CONTENT_MARKER');
  });

  it('selectivelyImportSkills() overwrites a colliding markdown_file skill when options.overwrite is true', async () => {
    const sourceA = path.join(tempDir, 'source-a.md');
    await fsp.writeFile(
      sourceA,
      `---\nname: my-skill\ndescription: original skill A\n---\n\nORIGINAL_A_CONTENT_MARKER\n`,
      'utf-8'
    );
    const sourceB = path.join(tempDir, 'source-b.md');
    await fsp.writeFile(
      sourceB,
      `---\nname: my-skill\ndescription: colliding skill B\n---\n\nDIFFERENT_B_CONTENT_MARKER\n`,
      'utf-8'
    );

    const importTarget = path.join(tempDir, 'import-target-overwrite');
    await ensureDir(importTarget);

    const skillA: DiscoveredSkill = {
      id: 'agent-a:my-skill',
      name: 'my-skill',
      agentId: 'agent-a',
      agentName: 'Agent A',
      description: 'original skill A',
      sourcePath: sourceA,
      type: 'markdown_file',
    };
    const skillB: DiscoveredSkill = {
      id: 'agent-b:my-skill',
      name: 'my-skill',
      agentId: 'agent-b',
      agentName: 'Agent B',
      description: 'colliding skill B',
      sourcePath: sourceB,
      type: 'markdown_file',
    };

    await selectivelyImportSkills([skillA], importTarget);

    const secondResult = await selectivelyImportSkills([skillB], importTarget, { overwrite: true });
    expect(secondResult.failedSkills).toEqual([]);
    expect(secondResult.importedSkills).toEqual(['my-skill']);

    const skillFilePath = path.join(importTarget, 'my-skill', 'SKILL.md');
    const finalContent = await fsp.readFile(skillFilePath, 'utf-8');
    expect(finalContent).toContain('DIFFERENT_B_CONTENT_MARKER');
    expect(finalContent).not.toContain('ORIGINAL_A_CONTENT_MARKER');
  });
});
