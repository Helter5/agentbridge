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
    await new Promise((r) => setTimeout(r, 150)); // past debounceMs

    expect(onRuleChange).toHaveBeenCalled();
    const [eventType, , result] = onRuleChange.mock.calls[onRuleChange.mock.calls.length - 1];
    expect(eventType).not.toBe('initial');
    expect(result.targets.every((t: any) => t.action === 'failed')).toBe(true);

    syncSpy.mockRestore();
  });
});
