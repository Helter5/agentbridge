import fs from 'node:fs';
import path from 'node:path';
import { pathExists, withLock, resolveSharedLockPath } from '../utils/fs.js';
import { getHubSkillsPath } from './skill-linker.js';
import { syncProjectRules } from './rules.js';
import type { RuleSyncResult } from '../types/rules.js';

export interface WatcherOptions {
  hubPath?: string;
  projectRoot?: string;
  debounceMs?: number;
  onSkillChange?: (eventType: string, filename: string | null) => void;
  /**
   * Fires after every debounced AGENTS.md resync that actually ran to
   * completion (didn't throw) - `result` is the real per-target outcome
   * from syncProjectRules(), including any 'failed' targets (e.g. from
   * lock contention with another concurrently-running agentbridge
   * command). Check `result.targets` before treating this as a clean
   * success - see onRuleSyncError for the case where syncProjectRules()
   * itself threw instead of returning a result.
   */
  onRuleChange?: (eventType: string, filename: string | null, result: RuleSyncResult) => void;
  /**
   * Fires when the debounced resync itself throws (distinct from a
   * per-target 'failed' entry in a resolved RuleSyncResult - see
   * onRuleChange) - e.g. AGENTS.md becoming unreadable between the
   * change event and the read. Without this, such an error would
   * propagate out of an async setTimeout callback as an unhandled
   * rejection, with no chance for a caller to log it or keep watching.
   */
  onRuleSyncError?: (eventType: string, filename: string | null, error: string) => void;
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
      const initialResult = await syncProjectRules(projectRoot, { mode: 'copy' });
      if (options.onRuleChange) {
        options.onRuleChange('initial', 'AGENTS.md', initialResult);
      }
    } catch (err: any) {
      // Non-critical to watcher startup itself (watchers still get
      // registered below either way), but still worth surfacing - same
      // reasoning as the debounced resync's own catch further down.
      if (options.onRuleSyncError) {
        options.onRuleSyncError('initial', 'AGENTS.md', err.message || String(err));
      }
    }
  }

  // 1. Watch Hub Skills Directory with Debounce
  if (await pathExists(hubSkillsPath)) {
    try {
      const skillsWatcher = fs.watch(
        hubSkillsPath,
        { recursive: true },
        (eventType, filename) => {
          // Ignore dot-prefixed entries at the hub root - same reserved
          // treatment mergeSkillsIntoHub() already gives them (never real
          // skills). Found via a long real-machine watch session: doctor's
          // own hub-write-access check creates and deletes a `.test-write`
          // file inside the hub on every run, and with no filter here that
          // showed up as a "Skill change detected" log line each time -
          // confusing noise with nothing to do with an actual skill.
          const topLevelEntry = filename ? filename.split(/[\\/]/)[0] : null;
          if (topLevelEntry && topLevelEntry.startsWith('.')) {
            return;
          }
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
  //
  // Watches the project root directory itself, filtered to AGENTS.md,
  // rather than fs.watch(agentsMdPath, ...) on the file directly. Found via
  // real-machine testing: a direct file watch only ever gets registered if
  // AGENTS.md already exists at the moment `watch` starts (the old code's
  // pathExists() gate below never re-ran) - so a project that gets its
  // AGENTS.md created *after* `watch` is already running (a fresh project,
  // or an editor's atomic save doing delete+rewrite - the same staleness
  // risk already called out for --mode symlink) was silently invisible to
  // the running watcher until it was restarted. A directory watch doesn't
  // require the file to exist yet, and keeps working across a delete+
  // recreate cycle since it's not watching a specific file handle.
  try {
    const rulesWatcher = fs.watch(projectRoot, (eventType, filename) => {
      // filename can be null on platforms/filesystems that don't support
      // it - can't filter in that case, so fall through and resync on any
      // project-root change rather than silently doing nothing. Harmless
      // (syncProjectRules() is idempotent and debounced), just occasionally
      // more eager than strictly necessary.
      if (filename !== null && filename !== 'AGENTS.md') {
        return;
      }
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
        try {
          // The result MUST be inspected, not discarded: syncProjectRules()
          // catches its own per-target write failures internally (e.g. a
          // target file locked by another concurrently-running agentbridge
          // command) and returns them as `targets[].action === 'failed'`
          // rather than throwing - a caller that fires a bare "success"
          // callback on any resolution, ignoring the result, ends up
          // reporting a clean sync even when every target actually failed.
          const result = await syncProjectRules(projectRoot, { mode: 'copy' });
          if (options.onRuleChange) {
            options.onRuleChange(eventType, 'AGENTS.md', result);
          }
        } catch (err: any) {
          // A genuine throw (e.g. AGENTS.md becomes unreadable between the
          // change event and this read) - without this catch, it would
          // escape as an unhandled rejection from this async setTimeout
          // callback, silently killing the whole watch process with no
          // clear message (see the initial-reconciliation sync above,
          // which already has this same guard).
          if (options.onRuleSyncError) {
            options.onRuleSyncError(eventType, 'AGENTS.md', err.message || String(err));
          }
        }
      }, debounceDelay);
    });
    watchers.push(rulesWatcher);
  } catch {
    // Non-critical
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
