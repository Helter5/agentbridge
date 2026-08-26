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
  resolveSharedLockPath,
} from '../utils/fs.js';
import { parseFrontmatter, validateSkillFrontmatter } from '../utils/schema.js';
import { generateSkillMarkdown, type CreateSkillTemplateOptions } from '../templates/skill.template.js';
import { DEFAULT_HUB_SKILLS_PATH } from './detector.js';
import { LOCK_RETRY_MAX_WAIT_MS } from '../constants.js';
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
/**
 * Extra context attached to an Error thrown mid-loop out of
 * mergeSkillsIntoHub() - which agent's turn it was when something threw,
 * and which agents before it in iteration order were already fully
 * handled (imported, already-linked, or a harmless no-op). Lets a caller
 * report partial completion instead of just the bare underlying error.
 */
export interface PartialMergeError extends Error {
  agentbridgePartialMergeContext?: {
    failedAgentName: string;
    succeededAgentNames: string[];
  };
}

export interface MergeSkillsResult {
  importedSkills: string[];
  /**
   * A genuine content collision: two different agents each had a skill
   * folder with the same name but different SKILL.md content (not just the
   * same skill being re-synced a second time). copyDirRecursive()'s own
   * overwrite=false only skips individual files that already exist - it
   * never reports this, so without tracking it here the losing agent's
   * skill was silently discarded while still being counted in
   * importedSkills as a plain success (see readme/PR history for the
   * near-identical bug already fixed in the pick command's collision
   * handling - this is the same shape in the link-skills merge path).
   */
  collisions: Array<{ skillName: string; keptFrom: string; discardedFrom: string }>;
}

export async function mergeSkillsIntoHub(
  agents: DetectedAgent[],
  hubPath: string,
  options: SkillLinkOptions = {}
): Promise<MergeSkillsResult> {
  const absHub = getHubSkillsPath(hubPath);
  // Dry-run must not touch disk at all - ensureDir() unconditionally here
  // (even though the actual copy below is already correctly gated) left a
  // stray empty hub directory behind after a run that promised to "simulate
  // actions without writing to disk".
  if (!options.dryRun) {
    await ensureDir(absHub);
  }

  const importedSkills: string[] = [];
  const collisions: MergeSkillsResult['collisions'] = [];
  // Tracks which agent's copy currently occupies each hub skill dir, within
  // this single call - best-effort provenance for a collision message, not
  // persisted across separate agentbridge invocations.
  const skillOwner: Record<string, string> = {};
  // Tracks which agents this loop has already fully handled (including a
  // no-op case - nothing to merge, already linked, or a harmlessly-broken
  // link) - if an agent later in the list throws, this is attached to the
  // error so the caller can report which agents were already done versus
  // never reached, instead of just the bare exception (see PR #20's
  // link-skills try/catch fix and the follow-up finding that it didn't
  // surface this partial-completion context).
  const processedAgentNames: string[] = [];

  for (const agent of agents) {
    const skillsDir = expandHome(agent.paths.skillsDir);
    if (!(await pathExists(skillsDir))) {
      processedAgentNames.push(agent.name);
      continue;
    }

    // Skip if it's already a symlink/junction pointing to hub
    const isLink = await isSymlinkOrJunction(skillsDir);
    if (isLink) {
      const target = await readLinkTarget(skillsDir);
      // readlink() can return a path relative to the link's own directory;
      // resolve against that directory, not cwd.
      if (target && path.resolve(path.dirname(skillsDir), target) === absHub) {
        processedAgentNames.push(agent.name);
        continue;
      }
    }

    // Direct directory with skills: import them to hub.
    // skillsDir can be a *broken* symlink/junction (its old target no
    // longer exists - e.g. left over from a hub rename/rebrand).
    // pathExists() above isn't a reliable guard against that case: on
    // Windows, fs.access() on an orphaned junction reparse point can
    // report the entry as accessible even though its target is gone, so
    // readdir() below is the first place this actually surfaces. Treat a
    // broken link the same as "nothing to merge" instead of crashing the
    // whole link-skills operation for every agent.
    let entries;
    try {
      entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    } catch (err: any) {
      if (err.code === 'ENOENT' && isLink) {
        processedAgentNames.push(agent.name);
        continue;
      }
      (err as PartialMergeError).agentbridgePartialMergeContext = {
        failedAgentName: agent.name,
        succeededAgentNames: [...processedAgentNames],
      };
      throw err;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const srcSkillDir = path.join(skillsDir, entry.name);
        const destSkillDir = path.join(absHub, entry.name);

        if (!options.dryRun) {
          if (await pathExists(destSkillDir)) {
            // Detect a genuine content collision before merging - two
            // different agents' skill folders sharing the same name is
            // common (the same skill, copied across agents) and merging
            // file-by-file is the right move there. But if their SKILL.md
            // content actually differs, this is a real collision: the
            // incoming one is about to be silently discarded (merge below
            // keeps whatever's already in destSkillDir, per file), so record
            // it rather than letting it vanish behind a plain "Imported".
            const srcSkillMd = path.join(srcSkillDir, 'SKILL.md');
            const destSkillMd = path.join(destSkillDir, 'SKILL.md');
            if ((await pathExists(srcSkillMd)) && (await pathExists(destSkillMd))) {
              const [srcContent, destContent] = await Promise.all([
                fsp.readFile(srcSkillMd, 'utf-8'),
                fsp.readFile(destSkillMd, 'utf-8'),
              ]);
              if (srcContent !== destContent) {
                collisions.push({
                  skillName: entry.name,
                  keptFrom: skillOwner[destSkillDir] || 'an earlier sync',
                  discardedFrom: agent.name,
                });
              }
            }
            // Merge files without overwriting newer existing files
            await copyDirRecursive(srcSkillDir, destSkillDir, false);
          } else {
            await copyDirRecursive(srcSkillDir, destSkillDir, true);
            skillOwner[destSkillDir] = agent.name;
          }
        }
        importedSkills.push(`${agent.name} / ${entry.name}`);
      }
    }
    processedAgentNames.push(agent.name);
  }

  return { importedSkills, collisions };
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
  const { importedSkills, collisions } = await mergeSkillsIntoHub(agents, absHub, options);

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
  // Same "only count a real SKILL.md" rule as status's Total Hub Skills -
  // a broken/empty folder that got imported alongside real skills
  // shouldn't inflate this summary count either.
  const validHubSkillsCount = allHubSkills.filter((s) => s.isValid).length;

  return {
    hubPath: absHub,
    importedSkills,
    collisions,
    linkedAgents,
    totalSkillsInHub: validHubSkillsCount,
  };
}

/**
 * Scaffolds a new skill in the central hub
 */
export async function createNewSkill(
  name: string,
  options: Partial<CreateSkillTemplateOptions> & { hubPath?: string } = {}
): Promise<{ skillPath: string; manifest: SkillManifest }> {
  // An empty/whitespace-only name used to fall through silently to
  // sanitizeSkillDirName()'s generic 'unnamed-skill' fallback - the skill
  // still got created, but every confirmation message echoed the original
  // empty string back ("Skill '' is now active..."), never mentioning the
  // real name actually used. add-skill already refuses other invalid
  // input outright (a colliding name, a path-traversal attempt) rather
  // than silently substituting something else - this matches that.
  if (!name || !name.trim()) {
    throw new Error('Skill name cannot be empty.');
  }

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
    resolveSharedLockPath(),
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
      `Could not create skill '${name}': another agentbridge process is currently modifying configs. Try again in a moment.`
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
  const warnings: Array<{ name: string; message: string }> = [];

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
        // Same collision risk as the markdown_file branch below (MEDIUM-002):
        // sanitizeSkillDirName() can map two different skill.name values to
        // the same destDir. copyDirRecursive()'s own overwrite=false only
        // skips individual files that already exist - it never reports a
        // top-level failure, so without this check a colliding directory
        // skill was silently absorbed (no files touched) while still being
        // reported to the user as "Imported" success.
        const destSkillFile = path.join(destDir, 'SKILL.md');
        if (options.overwrite !== true && (await pathExists(destSkillFile))) {
          failedSkills.push({
            name: skill.name,
            error: `Skipped: '${destDir}' already exists — use overwrite to replace it.`,
          });
          continue;
        }
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
          if (parsed.hadInvalidFrontmatterBlock) {
            // Distinct from "no frontmatter block at all" (a normal, silent
            // case for a plain markdown note) - here the file had a
            // `---`-delimited block that failed to parse as YAML. The
            // regenerated header only carries name/description; anything
            // else the original had (version, tags, custom fields) is gone.
            warnings.push({
              name: skill.name,
              message: `'${skill.sourcePath}' had a frontmatter block with invalid YAML - it was replaced with a minimal regenerated header (name/description only); any other original fields were lost.`,
            });
          }
        }
        const wrote = await withLock(
          resolveSharedLockPath(),
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
            'Another agentbridge process is currently modifying configs. Try again in a moment.'
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
    warnings,
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
      // Check if they are from different agents and not pointing to the exact same hub path.
      // Two agents linked to the same hub folder (the normal post-link-skills state)
      // each have their own symlink/junction under a different agent skills dir, so
      // their sourcePath strings are never equal - path.resolve() alone can't tell
      // they're the same file. realpath() follows the link/junction to the real
      // underlying hub path, which IS equal for both, so this only flags a genuine
      // collision (two truly separate directories). Falls back to path.resolve() for
      // a path realpath can't resolve (e.g. a dangling symlink) rather than throwing.
      const resolvedPaths = await Promise.all(
        skills.map(async (s) => {
          try {
            return await fsp.realpath(s.sourcePath);
          } catch {
            return path.resolve(s.sourcePath);
          }
        })
      );
      const uniquePaths = new Set(resolvedPaths);
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


