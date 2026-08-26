import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { startWatcher } from '../src/core/watcher.js';
import * as rulesModule from '../src/core/rules.js';
import { ensureDir } from '../src/utils/fs.js';
import type { RuleSyncResult } from '../src/types/rules.js';

describe('File Watcher Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-watcher-test-${Date.now()}`);
  let closeFn: (() => void) | null = null;

  beforeEach(async () => {
    await ensureDir(tempDir);
    await fsp.writeFile(path.join(tempDir, 'AGENTS.md'), '# Test Rules\nv1\n', 'utf-8');
  });

  afterEach(async () => {
    if (closeFn) {
      closeFn();
      closeFn = null;
    }
    vi.restoreAllMocks();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('onRuleChange receives the real RuleSyncResult (with any failed targets) instead of firing unconditionally on any resolution', async () => {
    // Found via live E2E testing: syncProjectRules() catches its own
    // per-target write failures internally (e.g. a target locked by
    // another concurrently-running agentbridge command) and returns them
    // as `targets[].action === 'failed'` rather than throwing. The watcher
    // previously discarded that return value and fired onRuleChange
    // unconditionally, so cli.ts logged a plain "✔ Auto-synchronized"
    // success message even when every target had actually failed.
    const partialFailureResult: RuleSyncResult = {
      sourcePath: path.join(tempDir, 'AGENTS.md'),
      targets: [
        { fileName: 'CLAUDE.md', filePath: path.join(tempDir, 'CLAUDE.md'), action: 'failed', error: 'Another agentbridge process is currently modifying configs.' },
        { fileName: 'GEMINI.md', filePath: path.join(tempDir, 'GEMINI.md'), action: 'created' },
      ],
    };
    const syncSpy = vi.spyOn(rulesModule, 'syncProjectRules').mockResolvedValue(partialFailureResult);

    const onRuleChange = vi.fn();
    const onRuleSyncError = vi.fn();

    const watcher = await startWatcher({
      projectRoot: tempDir,
      debounceMs: 20,
      onRuleChange,
      onRuleSyncError,
    });
    closeFn = watcher.close;

    // The initial-reconciliation call (startWatcher's own startup sync,
    // guarded the same way) already exercises this path once - wait for it.
    await new Promise((r) => setTimeout(r, 50));

    expect(onRuleSyncError).not.toHaveBeenCalled();
    expect(onRuleChange).toHaveBeenCalled();
    const [, , result] = onRuleChange.mock.calls[0];
    expect(result).toEqual(partialFailureResult);
    // The whole point: the caller receives the actual result object, not a
    // bare "it happened" signal - it can see the failed target and choose
    // not to report a plain success.
    expect(result.targets.some((t: any) => t.action === 'failed')).toBe(true);

    syncSpy.mockRestore();
  });

  it('onRuleSyncError fires (instead of an unhandled rejection) when syncProjectRules() itself throws', async () => {
    const syncSpy = vi
      .spyOn(rulesModule, 'syncProjectRules')
      .mockRejectedValue(new Error('EACCES: permission denied, open AGENTS.md'));

    const onRuleChange = vi.fn();
    const onRuleSyncError = vi.fn();

    // If startWatcher() let this throw escape uncaught, this whole test
    // process would crash with an unhandled rejection instead of the
    // assertions below ever running.
    const watcher = await startWatcher({
      projectRoot: tempDir,
      debounceMs: 20,
      onRuleChange,
      onRuleSyncError,
    });
    closeFn = watcher.close;

    await new Promise((r) => setTimeout(r, 50));

    expect(onRuleChange).not.toHaveBeenCalled();
    expect(onRuleSyncError).toHaveBeenCalled();
    const [eventType, filename, error] = onRuleSyncError.mock.calls[0];
    expect(eventType).toBe('initial');
    expect(filename).toBe('AGENTS.md');
    expect(error).toContain('permission denied');

    syncSpy.mockRestore();
  });

  it('the debounced AGENTS.md-change resync (not just the initial one) also surfaces a failed result via onRuleChange, not a false success', async () => {
    // Same fix, the other call site: the recurring debounce timer in
    // watcher.ts had no result-inspection at all before this fix (only the
    // initial-reconciliation call had a try/catch, and neither inspected
    // the resolved result). Let the initial sync succeed normally, then
    // switch the mock to a failure and trigger a real file change.
    const cleanResult: RuleSyncResult = {
      sourcePath: path.join(tempDir, 'AGENTS.md'),
      targets: [{ fileName: 'CLAUDE.md', filePath: path.join(tempDir, 'CLAUDE.md'), action: 'created' }],
    };
    const failedResult: RuleSyncResult = {
      sourcePath: path.join(tempDir, 'AGENTS.md'),
      targets: [{ fileName: 'CLAUDE.md', filePath: path.join(tempDir, 'CLAUDE.md'), action: 'failed', error: 'locked' }],
    };
    const syncSpy = vi
      .spyOn(rulesModule, 'syncProjectRules')
      .mockResolvedValueOnce(cleanResult) // initial reconciliation
      .mockResolvedValue(failedResult); // every subsequent (debounced) call

    const onRuleChange = vi.fn();

    const watcher = await startWatcher({
      projectRoot: tempDir,
      debounceMs: 20,
      onRuleChange,
    });
    closeFn = watcher.close;

    await new Promise((r) => setTimeout(r, 50)); // let the initial sync land
    onRuleChange.mockClear();

    await fsp.writeFile(path.join(tempDir, 'AGENTS.md'), '# Test Rules\nv2\n', 'utf-8');
    await new Promise((r) => setTimeout(r, 500)); // past debounceMs

    expect(onRuleChange).toHaveBeenCalled();
    const [eventType, , result] = onRuleChange.mock.calls[onRuleChange.mock.calls.length - 1];
    expect(eventType).not.toBe('initial');
    expect(result.targets.every((t: any) => t.action === 'failed')).toBe(true);

    syncSpy.mockRestore();
  });

  it('picks up AGENTS.md created after the watcher already started, not just one that existed at startup', async () => {
    // Found via real-machine dogfooding: the old code only registered
    // fs.watch() on AGENTS.md if it already existed at startup
    // (`if (await pathExists(agentsMd)) { fs.watch(agentsMd, ...) }`) - a
    // project without one yet (or an editor's atomic save deleting and
    // recreating it, the same staleness risk already called out for
    // --mode symlink) was invisible to an already-running watcher until it
    // was restarted. Now watches the project root directory itself,
    // filtered to the AGENTS.md filename, which doesn't require the file
    // to exist yet.
    //
    // Uses its own fresh subdirectory, never beforeEach's tempDir (which
    // already has an AGENTS.md) - deleting that file first to simulate
    // "doesn't exist yet" turned out to be its own change event on some
    // platforms (macOS FSEvents fired a 'rename' for the delete), and
    // syncProjectRules() auto-creates a fresh AGENTS.md when none exists,
    // so the delete alone was enough to trigger a real (if unintended)
    // sync before this test's own write ever happened.
    const freshProjectDir = path.join(tempDir, 'fresh-project-no-agents-md-yet');
    await ensureDir(freshProjectDir);

    const onRuleChange = vi.fn();
    const onRuleSyncError = vi.fn();

    const watcher = await startWatcher({
      projectRoot: freshProjectDir,
      debounceMs: 20,
      onRuleChange,
      onRuleSyncError,
    });
    closeFn = watcher.close;

    // Initial reconciliation finds nothing (AGENTS.md doesn't exist yet) -
    // confirm that, then create the file for the first time.
    await new Promise((r) => setTimeout(r, 50));
    expect(onRuleChange).not.toHaveBeenCalled();
    expect(onRuleSyncError).not.toHaveBeenCalled();

    await fsp.writeFile(path.join(freshProjectDir, 'AGENTS.md'), '# Created after watch started\n', 'utf-8');
    // This one exercises the real (unmocked) syncProjectRules(), which
    // writes 5 target files with its own file locking - a wider margin
    // than the other, mocked-sync tests in this file need. Found flaky on
    // a loaded Windows CI runner at 200ms (during a GitHub Actions
    // incident, but the margin itself was genuinely tight regardless).
    await new Promise((r) => setTimeout(r, 500)); // past debounceMs

    expect(onRuleChange).toHaveBeenCalled();
    const claudeMd = await fsp.readFile(path.join(freshProjectDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('Created after watch started');
  });

  it('ignores an unrelated file change in the project root instead of resyncing on every write', async () => {
    // The directory-level watch above filters to the AGENTS.md filename
    // specifically - a change to some other file in the project root
    // (package.json, a source file, .git internals, ...) must not trigger
    // a resync.
    const onRuleChange = vi.fn();

    const watcher = await startWatcher({
      projectRoot: tempDir,
      debounceMs: 20,
      onRuleChange,
    });
    closeFn = watcher.close;

    await new Promise((r) => setTimeout(r, 50)); // let the initial sync land
    onRuleChange.mockClear();

    await fsp.writeFile(path.join(tempDir, 'unrelated-file.txt'), 'not AGENTS.md', 'utf-8');
    await new Promise((r) => setTimeout(r, 500)); // past debounceMs

    expect(onRuleChange).not.toHaveBeenCalled();
  });

  it('ignores doctor\'s own .test-write housekeeping file in the hub, but still reports a real skill change', async () => {
    // Found during a long real-machine watch session: doctor's
    // hub-write-access check creates and deletes a `.test-write` file
    // inside the hub on every run (see doctor.ts) - with no filter here,
    // every doctor invocation showed up as a "Skill change detected" log
    // line, indistinguishable from an actual skill edit. Same reserved-
    // entry treatment mergeSkillsIntoHub() already gives dot-prefixed hub
    // entries (never real skills).
    const isolatedHub = path.join(tempDir, 'isolated-hub');
    await ensureDir(isolatedHub);

    const onSkillChange = vi.fn();
    const watcher = await startWatcher({
      projectRoot: tempDir,
      hubPath: isolatedHub,
      debounceMs: 20,
      onSkillChange,
    });
    closeFn = watcher.close;

    await new Promise((r) => setTimeout(r, 50)); // let the watcher register

    // Simulate doctor's own write-permission check: create then delete
    // `.test-write` at the hub root.
    const testWritePath = path.join(isolatedHub, '.test-write');
    await fsp.writeFile(testWritePath, '', 'utf-8');
    await fsp.rm(testWritePath, { force: true });
    await new Promise((r) => setTimeout(r, 500)); // past debounceMs

    expect(onSkillChange).not.toHaveBeenCalled();

    // A real skill change in the same hub must still be reported.
    await ensureDir(path.join(isolatedHub, 'real-skill'));
    await fsp.writeFile(path.join(isolatedHub, 'real-skill', 'SKILL.md'), 'Body', 'utf-8');
    await new Promise((r) => setTimeout(r, 500)); // past debounceMs

    expect(onSkillChange).toHaveBeenCalled();
  });
});
