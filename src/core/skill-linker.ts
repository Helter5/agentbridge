import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  expandHome,
  ensureDir,
  pathExists,
  isSymlinkOrJunction,
  readLinkTarget,
  createCrossPlatformLink,
  copyDirRecursive,
  backupPath,
  removeLinkOrDir,
  withLock,
} from '../utils/fs.js';
import { parseFrontmatter, validateSkillFrontmatter } from '../utils/schema.js';
import { generateSkillMarkdown, type CreateSkillTemplateOptions } from '../templates/skill.template.js';
import { DEFAULT_HUB_SKILLS_PATH } from './detector.js';
import { DEFAULT_LOCK_PATH, LOCK_RETRY_MAX_WAIT_MS } from '../constants.js';

const lockFilePath = path.resolve(expandHome(DEFAULT_LOCK_PATH));
import type { DetectedAgent } from '../types/client.js';
import type {
  SkillManifest,
  SkillLinkResult,
  SkillSyncSummary,
} from '../types/skill.js';

export interface SkillLinkOptions {
  hubPath?: string;
  force?: boolean;
  backupExisting?: boolean;
  dryRun?: boolean;
}

/**
 * Sanitizes an untrusted skill name into a safe directory-name segment.
 * Strips everything but lowercase alphanumerics/hyphen/underscore, so a
 * value like "../../../../.ssh/authorized_keys" (e.g. from a malicious
 * skill's SKILL.md frontmatter `name:` field, which has no format
 * restriction) collapses to a harmless single segment instead of escaping
 * the intended target directory when joined into a path.
 */
export function sanitizeSkillDirName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed-skill';
}

/**
 * Joins `name` under `baseDir` after sanitizing it, and asserts the
 * result is actually still inside `baseDir`. Throws if it is not -
 * defense in depth on top of sanitizeSkillDirName() in case a future
 * caller passes an already-sanitized-looking value that isn't.
 */
function resolveSkillDestDir(baseDir: string, name: string): string {
  const destDir = path.join(baseDir, sanitizeSkillDirName(name));
  const resolvedBase = path.resolve(baseDir);
  const resolvedDest = path.resolve(destDir);
  if (resolvedDest !== resolvedBase && !resolvedDest.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Refusing to import skill '${name}': resolved path escapes target directory.`);
  }
  return destDir;
}

/**
 * Gets the absolute path of the central skills hub
 */
export function getHubSkillsPath(customPath?: string): string {
  return path.resolve(expandHome(customPath || DEFAULT_HUB_SKILLS_PATH));
}

/**
 * Reads and parses a single skill directory
 */
export async function readSkillDirectory(skillDirPath: string): Promise<SkillManifest | null> {
  try {
    const dirName = path.basename(skillDirPath);
    const skillFilePath = path.join(skillDirPath, 'SKILL.md');

    let content = '';
    let frontmatter: any = { name: dirName, description: `Skill for ${dirName}` };
    let isValid = true;
    const validationErrors: string[] = [];

    if (await pathExists(skillFilePath)) {
      const raw = await fsp.readFile(skillFilePath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      content = parsed.content;

      if (parsed.frontmatter) {
        frontmatter = parsed.frontmatter;
        const validation = validateSkillFrontmatter(parsed.frontmatter);
        if (!validation.isValid) {
          isValid = false;
          validationErrors.push(...validation.errors);
        }
      } else {
        isValid = false;
        validationErrors.push('Missing or invalid YAML frontmatter in SKILL.md');
      }
    } else {
      // Check if there are any .md files
      const entries = await fsp.readdir(skillDirPath);
      const mdFiles = entries.filter((e) => e.endsWith('.md'));
      if (mdFiles.length > 0) {
        const firstMd = path.join(skillDirPath, mdFiles[0]);
        const raw = await fsp.readFile(firstMd, 'utf-8');
        const parsed = parseFrontmatter(raw);
        content = parsed.content;
        if (parsed.frontmatter) {
          frontmatter = parsed.frontmatter;
        }
      } else {
        isValid = false;
        validationErrors.push('No SKILL.md found in skill directory');
      }
    }

    const files = await fsp.readdir(skillDirPath);

    return {
      name: frontmatter.name || dirName,
      dirName,
      path: skillDirPath,
      skillFilePath,
      frontmatter,
      content,
      isValid,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      filesCount: files.length,
    };
  } catch {
    return null;
  }
}

/**
 * Lists all skill packages found in a directory
 */
export async function listSkillsInDirectory(dirPath: string): Promise<SkillManifest[]> {
  const absPath = path.resolve(expandHome(dirPath));
  if (!(await pathExists(absPath))) return [];

  const skills: SkillManifest[] = [];
  const entries = await fsp.readdir(absPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subPath = path.join(absPath, entry.name);
      const manifest = await readSkillDirectory(subPath);
      if (manifest) {
        skills.push(manifest);
      }
    }
  }

  return skills;
}

/**
 * Merges skill directories from multiple agent paths into the central hub
 */
export async function mergeSkillsIntoHub(
  agents: DetectedAgent[],
  hubPath: string,
  options: SkillLinkOptions = {}
): Promise<string[]> {
  const absHub = getHubSkillsPath(hubPath);
  await ensureDir(absHub);

  const importedSkills: string[] = [];

  for (const agent of agents) {
    const skillsDir = expandHome(agent.paths.skillsDir);
    if (!(await pathExists(skillsDir))) continue;

    // Skip if it's already a symlink/junction pointing to hub
    const isLink = await isSymlinkOrJunction(skillsDir);
    if (isLink) {
      const target = await readLinkTarget(skillsDir);
      // readlink() can return a path relative to the link's own directory;
      // resolve against that directory, not cwd.
      if (target && path.resolve(path.dirname(skillsDir), target) === absHub) {
        continue;
      }
    }

    // Direct directory with skills: import them to hub
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const srcSkillDir = path.join(skillsDir, entry.name);
        const destSkillDir = path.join(absHub, entry.name);

        if (!options.dryRun) {
          if (await pathExists(destSkillDir)) {
            // Merge files without overwriting newer existing files
            await copyDirRecursive(srcSkillDir, destSkillDir, false);
          } else {
            await copyDirRecursive(srcSkillDir, destSkillDir, true);
          }
        }
        importedSkills.push(`${agent.name} / ${entry.name}`);
      }
    }
  }

  return importedSkills;
}

/**
 * Links detected agents to the central hub directory
 */
export async function linkAgentsToHub(
  agents: DetectedAgent[],
  hubPath?: string,
  options: SkillLinkOptions = {}
): Promise<SkillSyncSummary> {
  const absHub = getHubSkillsPath(hubPath);
  if (!options.dryRun) {
    await ensureDir(absHub);
  }

  // 1. Merge all existing skills into hub first to prevent data loss
  const importedSkills = await mergeSkillsIntoHub(agents, absHub, options);

  const linkedAgents: SkillLinkResult[] = [];

  // 2. Link each agent's skills dir to the hub
  for (const agent of agents) {
    const skillsDir = expandHome(agent.paths.skillsDir);
    const result: SkillLinkResult = {
      agentId: agent.id,
      agentName: agent.displayName,
      targetPath: absHub,
      linkPath: skillsDir,
      success: false,
      actionTaken: 'failed',
    };

    if (options.dryRun) {
      result.success = true;
      result.actionTaken = 'created_link';
      linkedAgents.push(result);
      continue;
    }

    try {
      // If skillsDir exists and is a regular folder (not a symlink), back it up or remove it
      if (await pathExists(skillsDir)) {
        const isLink = await isSymlinkOrJunction(skillsDir);
        if (isLink) {
          const target = await readLinkTarget(skillsDir);
          // readlink() can return a path relative to the link's own directory;
          // resolve against that directory, not cwd.
          if (target && path.resolve(path.dirname(skillsDir), target) === absHub) {
            result.success = true;
            result.actionTaken = 'already_linked';
            linkedAgents.push(result);
            continue;
          }
          await removeLinkOrDir(skillsDir);
        } else {
          // Regular folder: backup then remove
          if (options.backupExisting !== false) {
            await backupPath(skillsDir);
          } else {
            await removeLinkOrDir(skillsDir);
          }
        }
      }

      // Create cross-platform link (Junction on Windows, Symlink on Unix)
      const linkRes = await createCrossPlatformLink(absHub, skillsDir, 'dir');
      if (linkRes.success) {
        result.success = true;
        result.actionTaken =
          linkRes.action === 'already_linked' ? 'already_linked' : 'created_link';
      } else {
        result.success = false;
        result.actionTaken = 'failed';
        result.error = linkRes.error;
      }
    } catch (err: any) {
      result.success = false;
      result.actionTaken = 'failed';
      result.error = err.message || String(err);
    }

    linkedAgents.push(result);
  }

  const allHubSkills = await listSkillsInDirectory(absHub);

  return {
    hubPath: absHub,
    importedSkills,
    linkedAgents,
    totalSkillsInHub: allHubSkills.length,
  };
}

/**
 * Scaffolds a new skill in the central hub
 */
export async function createNewSkill(
  name: string,
  options: Partial<CreateSkillTemplateOptions> & { hubPath?: string } = {}
): Promise<{ skillPath: string; manifest: SkillManifest }> {
  const absHub = getHubSkillsPath(options.hubPath);
  await ensureDir(absHub);

  // Normalize directory name
  const sanitizedName = sanitizeSkillDirName(name);

  const skillDir = path.join(absHub, sanitizedName);
  await ensureDir(skillDir);

  const skillFile = path.join(skillDir, 'SKILL.md');
  // Same collision risk as MEDIUM-002 (selectivelyImportSkills): sanitizedName
  // can match an already-existing skill (typed again, or a differently-typed
  // name that happens to sanitize the same way). There's no --overwrite flag
  // on `add-skill` yet, so an existing skill is never silently replaced -
  // fail with a clear error instead.
  if (await pathExists(skillFile)) {
    throw new Error(
      `Skill '${sanitizedName}' already exists at ${skillFile} - skill already exists, refusing to overwrite it.`
    );
  }
  const markdown = generateSkillMarkdown({
    name: sanitizedName,
    description: options.description || `Custom skill for ${name}`,
    author: options.author,
    tags: options.tags,
    version: options.version || '0.1.0',
    instructions: options.instructions,
  });

  const wrote = await withLock(
    lockFilePath,
    async () => {
      await fsp.writeFile(skillFile, markdown, 'utf-8');
    },
    { maxWaitMs: LOCK_RETRY_MAX_WAIT_MS }
  );
  if (wrote === null) {
    // withLock() never runs the callback when it can't get the lock - it
    // does NOT queue and retry later, so proceeding here would report a
    // skill as created when SKILL.md was never actually written.
    throw new Error(
      `Could not create skill '${name}': another agentsync process is currently modifying configs. Try again in a moment.`
    );
  }

  const manifest = (await readSkillDirectory(skillDir))!;
  return {
    skillPath: skillDir,
    manifest,
  };
}

/**
 * Discovers all individual skills and custom commands across all agents
 */
export async function discoverAllAvailableSkills(
  agents: DetectedAgent[]
): Promise<import('../types/skill.js').DiscoveredSkill[]> {
  const discovered: import('../types/skill.js').DiscoveredSkill[] = [];

  for (const agent of agents) {
    const searchDirs: string[] = [];
    const skillsDir = expandHome(agent.paths.skillsDir);
    if (await pathExists(skillsDir)) searchDirs.push(skillsDir);

    // Extra directories (e.g. Claude commands)
    if (agent.id === 'claude') {
      const claudeCommands = expandHome('~/.claude/commands');
      if (await pathExists(claudeCommands)) searchDirs.push(claudeCommands);
    }

    for (const dir of searchDirs) {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === '.git' || entry.name === '.cache' || entry.name === 'node_modules') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const hasSkillMd = await pathExists(path.join(fullPath, 'SKILL.md'));
            
            // If it's a container folder (like .system) without its own SKILL.md, scan children
            if (!hasSkillMd && entry.name.startsWith('.')) {
              try {
                const subEntries = await fsp.readdir(fullPath, { withFileTypes: true });
                for (const sub of subEntries) {
                  if (sub.isDirectory() && !sub.name.startsWith('.')) {
                    const subPath = path.join(fullPath, sub.name);
                    const subManifest = await readSkillDirectory(subPath);
                    if (subManifest && (subManifest.isValid || await pathExists(path.join(subPath, 'SKILL.md')))) {
                      discovered.push({
                        id: `${agent.id}:${sub.name}`,
                        name: subManifest.name || sub.name,
                        agentId: agent.id,
                        agentName: `${agent.displayName} (System)`,
                        description:
                          subManifest.frontmatter?.description ||
                          `Built-in system skill from ${agent.displayName}`,
                        sourcePath: subPath,
                        type: 'directory',
                        frontmatter: subManifest.frontmatter,
                      });
                    }
                  }
                }
              } catch {
                // Ignore unreadable subfolder
              }
              continue;
            }

            const manifest = await readSkillDirectory(fullPath);
            discovered.push({
              id: `${agent.id}:${entry.name}`,
              name: manifest?.name || entry.name,
              agentId: agent.id,
              agentName: agent.displayName,
              description: manifest?.frontmatter?.description || `Skill from ${agent.displayName}`,
              sourcePath: fullPath,
              type: 'directory',
              frontmatter: manifest?.frontmatter,
            });
          } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.')) {
            const baseName = entry.name.replace(/\.md$/, '');
            const raw = await fsp.readFile(fullPath, 'utf-8');
            const parsed = parseFrontmatter(raw);
            discovered.push({
              id: `${agent.id}:${baseName}`,
              name: parsed.frontmatter?.name || baseName,
              agentId: agent.id,
              agentName: agent.displayName,
              description:
                parsed.frontmatter?.description ||
                `Command / recipe from ${agent.displayName}`,
              sourcePath: fullPath,
              type: 'markdown_file',
              frontmatter: parsed.frontmatter || undefined,
            });
          }
        }
      } catch {
        // Skip unreadable directory
      }
    }
  }

  return discovered;
}

/**
 * Selectively imports specific discovered skills into a target directory
 */
export async function selectivelyImportSkills(
  skillsToImport: import('../types/skill.js').DiscoveredSkill[],
  targetDir: string,
  options: { overwrite?: boolean } = {}
): Promise<import('../types/skill.js').SelectiveImportResult> {
  const absTarget = path.resolve(expandHome(targetDir));
  await ensureDir(absTarget);

  const importedSkills: string[] = [];
  const failedSkills: Array<{ name: string; error: string }> = [];

  for (const skill of skillsToImport) {
    let destDir: string;
    try {
      // skill.name may come straight from a parsed SKILL.md's YAML
      // frontmatter (see readSkillDirectory/discoverAllAvailableSkills),
      // which has no format restriction - treat it as untrusted input,
      // not internal metadata, before it's ever used as a path segment.
      destDir = resolveSkillDestDir(absTarget, skill.name);
    } catch (err: any) {
      failedSkills.push({ name: skill.name, error: err.message || String(err) });
      continue;
    }
    try {
      if (skill.type === 'directory') {
        await copyDirRecursive(skill.sourcePath, destDir, options.overwrite);
      } else {
        // Standalone markdown file -> wrap in folder with SKILL.md
        const skillFilePath = path.join(destDir, 'SKILL.md');
        // sanitizeSkillDirName() can map different skill.name values to the
        // same destDir (e.g. "My Skill!!!" and "my-skill" both sanitize to
        // "my-skill"), and it's also common for the same skill to exist
        // independently in more than one agent's directory. Mirror
        // copyDirRecursive()'s per-file overwrite check (utils/fs.ts) here
        // instead of unconditionally overwriting an existing SKILL.md.
        if (options.overwrite !== true && (await pathExists(skillFilePath))) {
          failedSkills.push({
            name: skill.name,
            error: `Skipped: '${skillFilePath}' already exists — use overwrite to replace it.`,
          });
          continue;
        }
        await ensureDir(destDir);
        const raw = await fsp.readFile(skill.sourcePath, 'utf-8');
        const parsed = parseFrontmatter(raw);
        let finalContent = raw;
        if (!parsed.frontmatter) {
          finalContent = generateSkillMarkdown({
            name: skill.name,
            description: skill.description,
            instructions: parsed.content,
          });
        }
        const wrote = await withLock(
          lockFilePath,
          async () => {
            await fsp.writeFile(skillFilePath, finalContent, 'utf-8');
          },
          { maxWaitMs: LOCK_RETRY_MAX_WAIT_MS }
        );
        if (wrote === null) {
          // withLock() never runs the callback when it can't get the lock
          // - pushing to importedSkills below would report success for a
          // file that was never written.
          throw new Error(
            'Another agentsync process is currently modifying configs. Try again in a moment.'
          );
        }
      }
      importedSkills.push(skill.name);
    } catch (err: any) {
      failedSkills.push({
        name: skill.name,
        error: err.message || String(err),
      });
    }
  }

  return {
    importedSkills,
    failedSkills,
    targetPath: absTarget,
  };
}

export interface SkillCollision {
  skillName: string;
  sources: Array<{
    agentName: string;
    sourcePath: string;
    contentPreview: string;
  }>;
}

/**
 * Detects skill name collisions across agents where contents differ
 */
export async function detectSkillCollisions(
  agents: DetectedAgent[]
): Promise<SkillCollision[]> {
  const discovered = await discoverAllAvailableSkills(agents);
  const byName = new Map<string, typeof discovered>();

  for (const skill of discovered) {
    const list = byName.get(skill.name) || [];
    list.push(skill);
    byName.set(skill.name, list);
  }

  const collisions: SkillCollision[] = [];
  for (const [name, skills] of byName.entries()) {
    if (skills.length > 1) {
      // Check if they are from different agents and not pointing to the exact same hub path
      const uniquePaths = new Set(skills.map((s) => path.resolve(s.sourcePath)));
      if (uniquePaths.size > 1) {
        collisions.push({
          skillName: name,
          sources: skills.map((s) => ({
            agentName: s.agentName,
            sourcePath: s.sourcePath,
            contentPreview: s.description || 'No description',
          })),
        });
      }
    }
  }

  return collisions;
}

/**
 * Unlinks agents from the central hub, restoring standalone folders with skills copied from the hub
 */
export async function unlinkAgentsFromHub(
  agents: DetectedAgent[],
  options: { hubPath?: string; restoreFiles?: boolean } = {}
): Promise<Array<{ agentId: string; agentName: string; success: boolean; error?: string }>> {
  const absHub = getHubSkillsPath(options.hubPath);
  const results: Array<{ agentId: string; agentName: string; success: boolean; error?: string }> = [];

  for (const agent of agents) {
    const skillsDir = expandHome(agent.paths.skillsDir);
    try {
      const isLink = await isSymlinkOrJunction(skillsDir);
      if (isLink) {
        await removeLinkOrDir(skillsDir);
        await ensureDir(skillsDir);

        // Restore copy of hub skills so the agent remains functional
        if (options.restoreFiles !== false && (await pathExists(absHub))) {
          await copyDirRecursive(absHub, skillsDir, true);
        }

        results.push({
          agentId: agent.id,
          agentName: agent.displayName,
          success: true,
        });
      } else {
        results.push({
          agentId: agent.id,
          agentName: agent.displayName,
          success: true,
        });
      }
    } catch (err: any) {
      results.push({
        agentId: agent.id,
        agentName: agent.displayName,
        success: false,
        error: err.message || String(err),
      });
    }
  }

  return results;
}


