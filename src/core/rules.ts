import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  pathExists,
  isSymlinkOrJunction,
  createCrossPlatformLink,
  ensureDir,
  withLock,
  resolveSharedLockPath,
} from '../utils/fs.js';
import type { RuleTarget, RuleSyncResult, RuleTargetType } from '../types/rules.js';
import {
  RULE_TARGET_FILES,
  AUTO_GENERATED_HEADER,
  RULE_SOURCE_CANDIDATES,
  LOCK_RETRY_MAX_WAIT_MS,
} from '../constants.js';

export { RULE_TARGET_FILES, AUTO_GENERATED_HEADER, RULE_SOURCE_CANDIDATES };

export interface RuleSyncOptions {
  mode?: 'symlink' | 'copy';
  targets?: RuleTargetType[];
  force?: boolean;
}

/**
 * Finds the primary rule source file in a project workspace
 */
export async function findRuleSourceFile(projectRoot: string): Promise<string | null> {
  for (const file of RULE_SOURCE_CANDIDATES) {
    const p = path.join(projectRoot, file);
    if (await pathExists(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Inspects rule files in a project workspace
 */
export async function inspectProjectRules(projectRoot: string): Promise<{
  sourceFile: string | null;
  targets: RuleTarget[];
}> {
  const sourcePath = await findRuleSourceFile(projectRoot);
  const targets: RuleTarget[] = [];

  for (const [type, relPath] of Object.entries(RULE_TARGET_FILES) as [RuleTargetType, string][]) {
    const filePath = path.join(projectRoot, relPath);
    const exists = await pathExists(filePath);
    const isSymlink = await isSymlinkOrJunction(filePath);

    let status: RuleTarget['status'] = 'missing';

    if (exists || isSymlink) {
      if (isSymlink) {
        status = 'symlinked';
      } else if (sourcePath) {
        try {
          const sourceContent = await fsp.readFile(sourcePath, 'utf-8');
          const targetContent = await fsp.readFile(filePath, 'utf-8');
          const cleanTarget = targetContent.replace(AUTO_GENERATED_HEADER, '');
          if (cleanTarget.trim() === sourceContent.trim()) {
            status = 'synced';
          } else {
            status = 'out_of_sync';
          }
        } catch {
          status = 'out_of_sync';
        }
      } else {
        status = 'synced';
      }
    }

    targets.push({
      type,
      fileName: relPath,
      filePath,
      exists,
      isSymlink,
      status,
    });
  }

  return { sourceFile: sourcePath, targets };
}

/**
 * Initializes a default AGENTS.md in the project workspace
 */
export async function initAgentsRuleFile(
  projectRoot: string,
  projectName = 'Project'
): Promise<string> {
  const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
  if (await pathExists(agentsMdPath)) {
    return agentsMdPath;
  }

  const defaultContent = `# ${projectName} - AI Agent Instructions

Welcome to the AI Agent Guide for ${projectName}. This file acts as the universal source-of-truth for all AI coding agents (Google Antigravity, Claude Code, Cursor, Windsurf, Roo).

## Project Guidelines
- **Code Style**: Modern TypeScript / Clean Architecture
- **Testing**: Run all unit tests before committing
- **Safety**: Do not mutate protected credentials or production environments

## Architecture & Conventions
1. Keep modular boundaries clear.
2. Follow strict typing and comprehensive error handling.
`;

  const wrote = await withLock(
    resolveSharedLockPath(),
    async () => {
      await ensureDir(path.dirname(agentsMdPath));
      await fsp.writeFile(agentsMdPath, defaultContent, 'utf-8');
    },
    { maxWaitMs: LOCK_RETRY_MAX_WAIT_MS }
  );
  if (wrote === null) {
    // withLock() never runs the callback when it can't get the lock - it
    // does NOT queue and retry later, so silently returning agentsMdPath
    // here would tell the caller a file was created that never was.
    throw new Error(
      `Could not create AGENTS.md at ${agentsMdPath}: another agentsync process is currently modifying configs. Try again in a moment.`
    );
  }
  return agentsMdPath;
}

/**
 * Synchronizes project rules from AGENTS.md to CLAUDE.md, GEMINI.md, .cursorrules, etc.
 */
export async function syncProjectRules(
  projectRoot: string,
  options: RuleSyncOptions = {}
): Promise<RuleSyncResult> {
  let sourcePath = await findRuleSourceFile(projectRoot);

  if (!sourcePath) {
    sourcePath = await initAgentsRuleFile(projectRoot);
  }

  const sourceContent = await fsp.readFile(sourcePath, 'utf-8');
  const mode = options.mode || 'copy';
  const targetTypes = options.targets || (Object.keys(RULE_TARGET_FILES) as RuleTargetType[]);

  const results: RuleSyncResult['targets'] = [];

  for (const type of targetTypes) {
    const relPath = RULE_TARGET_FILES[type];
    const targetPath = path.join(projectRoot, relPath);

    // Skip if target is the same as source
    if (path.resolve(targetPath) === path.resolve(sourcePath)) {
      results.push({
        fileName: relPath,
        filePath: targetPath,
        action: 'skipped',
      });
      continue;
    }

    try {
      await ensureDir(path.dirname(targetPath));

      if (mode === 'symlink') {
        const linkRes = await createCrossPlatformLink(sourcePath, targetPath, 'file');
        if (linkRes.success) {
          results.push({
            fileName: relPath,
            filePath: targetPath,
            action: 'symlinked',
          });
        } else {
          // Fallback to copy
          const contentToWrite = `${AUTO_GENERATED_HEADER}${sourceContent}`;
          const wrote = await withLock(
            resolveSharedLockPath(),
            async () => {
              await fsp.writeFile(targetPath, contentToWrite, 'utf-8');
            },
            { maxWaitMs: LOCK_RETRY_MAX_WAIT_MS }
          );
          if (wrote === null) {
            throw new Error(
              'Another agentsync process is currently modifying configs. Try again in a moment.'
            );
          }
          results.push({
            fileName: relPath,
            filePath: targetPath,
            action: 'created',
          });
        }
      } else {
        // Copy mode
        const contentToWrite = `${AUTO_GENERATED_HEADER}${sourceContent}`;
        const wrote = await withLock(
          resolveSharedLockPath(),
          async () => {
            const isLink = await isSymlinkOrJunction(targetPath);
            if (isLink) {
              await fsp.unlink(targetPath);
            }
            await fsp.writeFile(targetPath, contentToWrite, 'utf-8');
          },
          { maxWaitMs: LOCK_RETRY_MAX_WAIT_MS }
        );
        if (wrote === null) {
          throw new Error(
            'Another agentsync process is currently modifying configs. Try again in a moment.'
          );
        }
        results.push({
          fileName: relPath,
          filePath: targetPath,
          action: 'created',
        });
      }
    } catch (err: any) {
      results.push({
        fileName: relPath,
        filePath: targetPath,
        action: 'failed',
        error: err.message || String(err),
      });
    }
  }

  return {
    sourcePath,
    targets: results,
  };
}
