import fs from 'node:fs';
import path from 'node:path';
import { pathExists, withLock, resolveSharedLockPath } from '../utils/fs.js';
import { getHubSkillsPath } from './skill-linker.js';
import { syncProjectRules } from './rules.js';

export interface WatcherOptions {
  hubPath?: string;
  projectRoot?: string;
  debounceMs?: number;
  onSkillChange?: (eventType: string, filename: string | null) => void;
  onRuleChange?: (eventType: string, filename: string | null) => void;
}

/**
 * Watches skills and project rule files for real-time live synchronization with debouncing and lockfile protection
 */
export async function startWatcher(options: WatcherOptions = {}): Promise<{
  close: () => void;
  isWatching: boolean;
}> {
  const hubSkillsPath = getHubSkillsPath(options.hubPath);
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : process.cwd();
  const debounceDelay = options.debounceMs || 300;
  const lockFilePath = resolveSharedLockPath();

  const watchers: fs.FSWatcher[] = [];
  // Each timer debounces per watched target (the whole skills directory /
  // the single AGENTS.md file), not per individual file. Several files
  // changing within one debounceDelay window collapse into a single fire
  // carrying only the last fs.watch event's filename - see the two usages
  // below for why that's safe in each case.
  let skillDebounceTimer: NodeJS.Timeout | null = null;
  let ruleDebounceTimer: NodeJS.Timeout | null = null;

  // Initial startup reconciliation
  const agentsMdInitial = path.join(projectRoot, 'AGENTS.md');
  if (await pathExists(agentsMdInitial)) {
    try {
      // syncProjectRules() locks its own writes internally (see rules.ts);
      // no outer withLock here to avoid nesting on the same lockfile.
      await syncProjectRules(projectRoot, { mode: 'copy' });
    } catch {
      // Non-critical
    }
  }

  // 1. Watch Hub Skills Directory with Debounce
  if (await pathExists(hubSkillsPath)) {
    try {
      const skillsWatcher = fs.watch(
        hubSkillsPath,
        { recursive: true },
        (eventType, filename) => {
          if (skillDebounceTimer) clearTimeout(skillDebounceTimer);
          skillDebounceTimer = setTimeout(async () => {
            await withLock(lockFilePath, async () => {
              // onSkillChange only surfaces a log message (it doesn't
              // itself resync anything), so a burst of changes across
              // several skill files coalescing into one callback with
              // just the last filename loses nothing but that log line's
              // precision - no file content is derived from `filename`.
              if (options.onSkillChange) {
                options.onSkillChange(eventType, filename);
              }
            });
          }, debounceDelay);
        }
      );
      watchers.push(skillsWatcher);
    } catch {
      // Recursive watch fallback
    }
  }

  // 2. Watch AGENTS.md in Project Workspace with Debounce
  const agentsMd = path.join(projectRoot, 'AGENTS.md');
  if (await pathExists(agentsMd)) {
    try {
      const rulesWatcher = fs.watch(agentsMd, (eventType) => {
        if (ruleDebounceTimer) clearTimeout(ruleDebounceTimer);
        ruleDebounceTimer = setTimeout(async () => {
          // Only one file (AGENTS.md) is watched here, so there's no
          // multi-file coalescing to worry about. syncProjectRules()
          // re-reads AGENTS.md's full current content on every call
          // rather than acting on `eventType`/a filename, so even
          // multiple rapid saves debounced into one fire still produce a
          // fully up-to-date resync - it doesn't matter how many writes
          // happened in between, only what the file contains when this
          // timer fires.
          // syncProjectRules() locks its own writes internally (see rules.ts);
          // no outer withLock here to avoid nesting on the same lockfile.
          await syncProjectRules(projectRoot, { mode: 'copy' });
          if (options.onRuleChange) {
            options.onRuleChange(eventType, 'AGENTS.md');
          }
        }, debounceDelay);
      });
      watchers.push(rulesWatcher);
    } catch {
      // Non-critical
    }
  }

  return {
    close: () => {
      if (skillDebounceTimer) clearTimeout(skillDebounceTimer);
      if (ruleDebounceTimer) clearTimeout(ruleDebounceTimer);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // Ignore close errors
        }
      }
    },
    isWatching: watchers.length > 0,
  };
}
