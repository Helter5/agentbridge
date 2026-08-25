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
import { ensureDir, pathExists, isSymlinkOrJunction, createCrossPlatformLink } from '../src/utils/fs.js';
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

  it('createNewSkill() rejects an empty/whitespace-only name with a clear error instead of silently falling back to "unnamed-skill"', async () => {
    // Found via manual testing: sanitizeSkillDirName('') falls back to
    // 'unnamed-skill' by design (used elsewhere, e.g. pick's collision
    // handling, where a fallback is the right call for a name that can't
    // be helped). But add-skill's name comes directly from what the user
    // typed - silently substituting a different name meant the skill got
    // created while every confirmation message still echoed back the
    // original empty string, never mentioning the real name used. Matches
    // how add-skill already refuses other invalid input (a colliding
    // name, above) rather than silently substituting something else.
    await expect(createNewSkill('', { description: 'd', hubPath: tempHub })).rejects.toThrow(
      'Skill name cannot be empty'
    );
    await expect(createNewSkill('   ', { description: 'd', hubPath: tempHub })).rejects.toThrow(
      'Skill name cannot be empty'
    );

    const unnamedFallbackPath = path.join(tempHub, 'unnamed-skill');
    expect(await pathExists(unnamedFallbackPath)).toBe(false);
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

    const merged = await mergeSkillsIntoHub([mockAgent], tempHub);
    expect(merged.importedSkills.length).toBe(1);
    expect(merged.collisions).toEqual([]);

    const hubSkills = await listSkillsInDirectory(tempHub);
    expect(hubSkills.some((s) => s.dirName === 'legacy-skill')).toBe(true);
  });

  it('mergeSkillsIntoHub() with options.dryRun does not create the hub directory at all', async () => {
    // ensureDir(absHub) was previously unconditional - a dry-run promising
    // to "simulate actions without writing to disk" still left a stray
    // empty hub directory behind.
    const agentSkillsDir = path.join(tempDir, 'agent-dryrun-skills');
    await ensureDir(path.join(agentSkillsDir, 'some-skill'));
    await fsp.writeFile(
      path.join(agentSkillsDir, 'some-skill', 'SKILL.md'),
      `---\nname: some-skill\ndescription: A skill\n---\n\nBody\n`,
      'utf-8'
    );

    const mockAgent: DetectedAgent = {
      id: 'antigravity',
      name: 'Google Antigravity',
      displayName: 'Google Antigravity',
      isInstalled: true,
      paths: { configDir: tempDir, skillsDir: agentSkillsDir },
      existingSkillsCount: 1,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };

    const freshHub = path.join(tempDir, 'never-created-hub');
    expect(await pathExists(freshHub)).toBe(false);

    const merged = await mergeSkillsIntoHub([mockAgent], freshHub, { dryRun: true });
    expect(merged.importedSkills.length).toBe(1); // still reports what WOULD be imported
    expect(await pathExists(freshHub)).toBe(false); // but touches nothing on disk
  });

  it('mergeSkillsIntoHub() reports a collision (not a plain "Imported") when two agents have a same-named skill with different content', async () => {
    // Found via manual testing of link-skills specifically (distinct from
    // the pick-flow collision already fixed): copyDirRecursive()'s
    // overwrite=false silently keeps whichever agent's version got there
    // first and drops the other's, per file - previously with zero
    // indication in the result, so both agents' skills were reported via
    // the same plain importedSkills success list even though only one
    // agent's content actually survived.
    const agentADir = path.join(tempDir, 'agent-a-skills');
    const agentBDir = path.join(tempDir, 'agent-b-skills');
    await ensureDir(path.join(agentADir, 'shared-name'));
    await ensureDir(path.join(agentBDir, 'shared-name'));
    await fsp.writeFile(
      path.join(agentADir, 'shared-name', 'SKILL.md'),
      `---\nname: shared-name\ndescription: Agent A version\n---\n\nAGENT_A_CONTENT\n`,
      'utf-8'
    );
    await fsp.writeFile(
      path.join(agentBDir, 'shared-name', 'SKILL.md'),
      `---\nname: shared-name\ndescription: Agent B version\n---\n\nAGENT_B_CONTENT\n`,
      'utf-8'
    );

    const agentA: DetectedAgent = {
      id: 'agent-a',
      name: 'Agent A',
      displayName: 'Agent A',
      isInstalled: true,
      paths: { configDir: tempDir, skillsDir: agentADir },
      existingSkillsCount: 1,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };
    const agentB: DetectedAgent = {
      id: 'agent-b',
      name: 'Agent B',
      displayName: 'Agent B',
      isInstalled: true,
      paths: { configDir: tempDir, skillsDir: agentBDir },
      existingSkillsCount: 1,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };

    const merged = await mergeSkillsIntoHub([agentA, agentB], tempHub);
    expect(merged.collisions).toEqual([
      { skillName: 'shared-name', keptFrom: 'Agent A', discardedFrom: 'Agent B' },
    ]);

    const skillMd = await fsp.readFile(path.join(tempHub, 'shared-name', 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('AGENT_A_CONTENT');
    expect(skillMd).not.toContain('AGENT_B_CONTENT');
  });

  it('mergeSkillsIntoHub() reports no collision when two agents have the exact same skill content (a normal re-sync, not a conflict)', async () => {
    const agentADir = path.join(tempDir, 'agent-a2-skills');
    const agentBDir = path.join(tempDir, 'agent-b2-skills');
    const identicalContent = `---\nname: shared-name\ndescription: Same everywhere\n---\n\nSAME_CONTENT\n`;
    await ensureDir(path.join(agentADir, 'shared-name'));
    await ensureDir(path.join(agentBDir, 'shared-name'));
    await fsp.writeFile(path.join(agentADir, 'shared-name', 'SKILL.md'), identicalContent, 'utf-8');
    await fsp.writeFile(path.join(agentBDir, 'shared-name', 'SKILL.md'), identicalContent, 'utf-8');

    const agentA: DetectedAgent = {
      id: 'agent-a2',
      name: 'Agent A2',
      displayName: 'Agent A2',
      isInstalled: true,
      paths: { configDir: tempDir, skillsDir: agentADir },
      existingSkillsCount: 1,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };
    const agentB: DetectedAgent = {
      id: 'agent-b2',
      name: 'Agent B2',
      displayName: 'Agent B2',
      isInstalled: true,
      paths: { configDir: tempDir, skillsDir: agentBDir },
      existingSkillsCount: 1,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };

    const merged = await mergeSkillsIntoHub([agentA, agentB], tempHub);
    expect(merged.collisions).toEqual([]);
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

  it('selectivelyImportSkills() imports a markdown_file skill with malformed YAML frontmatter, but reports a warning (not a plain silent success)', async () => {
    // Same silent-data-loss shape as the sync-mcp corrupt-JSON bug: a
    // `---`-delimited frontmatter block that fails to parse falls back to
    // regenerating a fresh header from name/description, discarding
    // whatever other fields (version, tags, custom fields) the original
    // had - without this warning, that would happen with no indication
    // to the user at all, identical to a normal successful import.
    const sourceBroken = path.join(tempDir, 'source-broken.md');
    await fsp.writeFile(
      sourceBroken,
      `---\nname: broken-skill\ndescription: [this is not, valid: yaml: at: all\n---\n\nBODY_MUST_SURVIVE_MARKER\n`,
      'utf-8'
    );

    const importTarget = path.join(tempDir, 'import-target-broken-frontmatter');
    await ensureDir(importTarget);

    const skill: DiscoveredSkill = {
      id: 'agent-a:broken-skill',
      name: 'broken-skill',
      agentId: 'agent-a',
      agentName: 'Agent A',
      description: 'A skill with malformed frontmatter',
      sourcePath: sourceBroken,
      type: 'markdown_file',
    };

    const result = await selectivelyImportSkills([skill], importTarget);
    expect(result.failedSkills).toEqual([]);
    expect(result.importedSkills).toEqual(['broken-skill']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe('broken-skill');
    expect(result.warnings[0].message).toContain('invalid YAML');

    // Body content survives; frontmatter got a fresh, valid regenerated
    // header instead of carrying over the broken YAML.
    const skillFilePath = path.join(importTarget, 'broken-skill', 'SKILL.md');
    const finalContent = await fsp.readFile(skillFilePath, 'utf-8');
    expect(finalContent).toContain('BODY_MUST_SURVIVE_MARKER');
    expect(finalContent).toContain('name: broken-skill');
  });

  it('selectivelyImportSkills() reports no warning for a markdown_file skill with no frontmatter block at all (the normal case)', async () => {
    // Control case: a plain markdown note with no `---` delimiters is NOT
    // an error, and must not trip the same warning as genuinely malformed
    // YAML (see parseFrontmatter's hadInvalidFrontmatterBlock distinction
    // in schema.test.ts).
    const sourcePlain = path.join(tempDir, 'source-plain.md');
    await fsp.writeFile(sourcePlain, `# Just a plain note\n\nNo frontmatter here.\n`, 'utf-8');

    const importTarget = path.join(tempDir, 'import-target-plain');
    await ensureDir(importTarget);

    const skill: DiscoveredSkill = {
      id: 'agent-a:plain-skill',
      name: 'plain-skill',
      agentId: 'agent-a',
      agentName: 'Agent A',
      description: 'A plain skill with no frontmatter',
      sourcePath: sourcePlain,
      type: 'markdown_file',
    };

    const result = await selectivelyImportSkills([skill], importTarget);
    expect(result.failedSkills).toEqual([]);
    expect(result.importedSkills).toEqual(['plain-skill']);
    expect(result.warnings).toEqual([]);
  });

  it('selectivelyImportSkills() reports a failure (not a false "Imported" success) for a directory-type skill whose sanitized name collides with an already-imported one, without overwrite', async () => {
    // Found via manual UX testing (not unit-test-only inspection): the
    // markdown_file branch above got an explicit collision check for
    // MEDIUM-002, but the directory branch called copyDirRecursive()
    // directly. copyDirRecursive(..., overwrite=false) only skips
    // individual files that already exist - it never surfaces a top-level
    // failure - so the second colliding skill was reported to the user as
    // "Imported" success while none of its files were actually written.
    const sourceDirA = path.join(tempDir, 'dir-source-a');
    await ensureDir(sourceDirA);
    await fsp.writeFile(
      path.join(sourceDirA, 'SKILL.md'),
      `---\nname: my-dir-skill\ndescription: original dir skill A\n---\n\nORIGINAL_DIR_A_MARKER\n`,
      'utf-8'
    );

    const sourceDirB = path.join(tempDir, 'dir-source-b');
    await ensureDir(sourceDirB);
    await fsp.writeFile(
      path.join(sourceDirB, 'SKILL.md'),
      `---\nname: my-dir-skill\ndescription: colliding dir skill B\n---\n\nDIFFERENT_DIR_B_MARKER\n`,
      'utf-8'
    );

    const importTarget = path.join(tempDir, 'import-target-dir-collision');
    await ensureDir(importTarget);

    const skillA: DiscoveredSkill = {
      id: 'agent-a:my-dir-skill',
      name: 'My Dir Skill!!!',
      agentId: 'agent-a',
      agentName: 'Agent A',
      description: 'original dir skill A',
      sourcePath: sourceDirA,
      type: 'directory',
    };
    const skillB: DiscoveredSkill = {
      id: 'agent-b:my-dir-skill',
      name: 'my-dir-skill',
      agentId: 'agent-b',
      agentName: 'Agent B',
      description: 'colliding dir skill B',
      sourcePath: sourceDirB,
      type: 'directory',
    };

    const firstResult = await selectivelyImportSkills([skillA], importTarget);
    expect(firstResult.failedSkills).toEqual([]);
    expect(firstResult.importedSkills).toEqual(['My Dir Skill!!!']);

    const skillFilePath = path.join(importTarget, 'my-dir-skill', 'SKILL.md');
    const contentAfterFirstImport = await fsp.readFile(skillFilePath, 'utf-8');
    expect(contentAfterFirstImport).toContain('ORIGINAL_DIR_A_MARKER');

    const secondResult = await selectivelyImportSkills([skillB], importTarget);
    expect(secondResult.importedSkills).toEqual([]);
    expect(secondResult.failedSkills).toHaveLength(1);
    expect(secondResult.failedSkills[0].name).toBe('my-dir-skill');
    expect(secondResult.failedSkills[0].error).toContain('already exists');

    const contentAfterSkippedImport = await fsp.readFile(skillFilePath, 'utf-8');
    expect(contentAfterSkippedImport).toBe(contentAfterFirstImport);
    expect(contentAfterSkippedImport).not.toContain('DIFFERENT_DIR_B_MARKER');
  });

  it('selectivelyImportSkills() overwrites a colliding directory-type skill when options.overwrite is true', async () => {
    const sourceDirA = path.join(tempDir, 'dir-source-a2');
    await ensureDir(sourceDirA);
    await fsp.writeFile(
      path.join(sourceDirA, 'SKILL.md'),
      `---\nname: my-dir-skill\ndescription: original dir skill A\n---\n\nORIGINAL_DIR_A_MARKER\n`,
      'utf-8'
    );

    const sourceDirB = path.join(tempDir, 'dir-source-b2');
    await ensureDir(sourceDirB);
    await fsp.writeFile(
      path.join(sourceDirB, 'SKILL.md'),
      `---\nname: my-dir-skill\ndescription: colliding dir skill B\n---\n\nDIFFERENT_DIR_B_MARKER\n`,
      'utf-8'
    );

    const importTarget = path.join(tempDir, 'import-target-dir-overwrite');
    await ensureDir(importTarget);

    const skillA: DiscoveredSkill = {
      id: 'agent-a:my-dir-skill',
      name: 'my-dir-skill',
      agentId: 'agent-a',
      agentName: 'Agent A',
      description: 'original dir skill A',
      sourcePath: sourceDirA,
      type: 'directory',
    };
    const skillB: DiscoveredSkill = {
      id: 'agent-b:my-dir-skill',
      name: 'my-dir-skill',
      agentId: 'agent-b',
      agentName: 'Agent B',
      description: 'colliding dir skill B',
      sourcePath: sourceDirB,
      type: 'directory',
    };

    await selectivelyImportSkills([skillA], importTarget);

    const secondResult = await selectivelyImportSkills([skillB], importTarget, { overwrite: true });
    expect(secondResult.failedSkills).toEqual([]);
    expect(secondResult.importedSkills).toEqual(['my-dir-skill']);

    const skillFilePath = path.join(importTarget, 'my-dir-skill', 'SKILL.md');
    const finalContent = await fsp.readFile(skillFilePath, 'utf-8');
    expect(finalContent).toContain('DIFFERENT_DIR_B_MARKER');
    expect(finalContent).not.toContain('ORIGINAL_DIR_A_MARKER');
  });

  it('mergeSkillsIntoHub()/linkAgentsToHub() skip a broken (orphaned-target) symlink/junction instead of crashing', async () => {
    // Found via manual end-to-end testing on a real machine, not by
    // inspection: an agent's skillsDir can be a symlink/junction whose
    // target no longer exists (e.g. left over from a hub rename). On
    // Windows, fs.access() on an orphaned junction reparse point can
    // report the entry as accessible even though its target is gone, so
    // pathExists() alone isn't a reliable guard - readdir() was the first
    // place this actually threw ENOENT and crashed the whole
    // link-skills command for every agent, not just the broken one.
    const realTarget = path.join(tempDir, 'real-target-dir');
    await ensureDir(realTarget);
    const skillsDir = path.join(tempDir, 'agent-skills-dir');
    const linkRes = await createCrossPlatformLink(realTarget, skillsDir, 'dir');
    expect(linkRes.success).toBe(true);
    expect(await isSymlinkOrJunction(skillsDir)).toBe(true);

    // Orphan it: remove the target the link points to, without removing
    // the link/junction itself.
    await fsp.rm(realTarget, { recursive: true, force: true });

    const mockAgent: DetectedAgent = {
      id: 'claude',
      name: 'Claude Code',
      displayName: 'Claude Code',
      isInstalled: true,
      paths: {
        configDir: tempDir,
        skillsDir,
      },
      existingSkillsCount: 0,
      existingMcpServersCount: 0,
      isLinkedToHub: false,
    };

    // Must not throw - the broken agent is skipped, not fatal to the
    // whole hub merge.
    const merged = await mergeSkillsIntoHub([mockAgent], tempHub);
    expect(merged.importedSkills).toEqual([]);
    expect(merged.collisions).toEqual([]);

    // linkAgentsToHub() must also complete and actually fix the broken
    // link by replacing it with a working one to the hub.
    const summary = await linkAgentsToHub([mockAgent], tempHub);
    expect(summary.linkedAgents[0].success).toBe(true);
    expect(await isSymlinkOrJunction(skillsDir)).toBe(true);
  });
});
