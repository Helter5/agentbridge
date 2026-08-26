import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { runDiagnostics } from '../src/core/doctor.js';
import { ensureDir, pathExists } from '../src/utils/fs.js';

describe('Doctor & Health Diagnostics Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-doctor-test-${Date.now()}`);
  const tempHub = path.join(tempDir, 'hub');

  beforeEach(async () => {
    await ensureDir(tempDir);
    await ensureDir(tempHub);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('runs complete diagnostic checks and generates report', async () => {
    const report = await runDiagnostics({ hubPath: tempHub });

    expect(report).toBeDefined();
    expect(report.osInfo.platform).toBe(process.platform);
    expect(report.checks.length).toBeGreaterThan(0);

    const nodeCheck = report.checks.find((c) => c.id === 'env-node');
    expect(nodeCheck?.status).toBe('success');

    const hubCheck = report.checks.find((c) => c.id === 'hub-write-access');
    expect(hubCheck?.status).toBe('success');

    const symlinkCheck = report.checks.find((c) => c.id === 'symlink-capability');
    expect(symlinkCheck).toBeDefined();
  });

  it('flags and can clean up a reserved folder (e.g. a leaked .system bundle) that ended up in the hub before the mergeSkillsIntoHub() filter existed', async () => {
    // Simulates pre-fix contamination: an older agentbridge version copied
    // an agent's reserved .system folder straight into the hub. The
    // real, original copy at the agent's own skillsDir is a separate
    // concern (untouched by this cleanup) - this check is specifically
    // about the accidental duplicate living inside the shared hub, which
    // gets cross-linked into every other agent.
    await ensureDir(path.join(tempHub, '.system', 'imagegen'));
    await fsp.writeFile(
      path.join(tempHub, '.system', 'imagegen', 'SKILL.md'),
      `---\nname: imagegen\ndescription: leaked\n---\n\nBody\n`,
      'utf-8'
    );
    await ensureDir(path.join(tempHub, 'real-skill'));
    await fsp.writeFile(
      path.join(tempHub, 'real-skill', 'SKILL.md'),
      `---\nname: real-skill\ndescription: a real hub skill\n---\n\nBody\n`,
      'utf-8'
    );

    const report = await runDiagnostics({ hubPath: tempHub });
    const reservedCheck = report.checks.find((c) => c.id === 'hub-reserved-folders');
    expect(reservedCheck?.status).toBe('warning');
    expect(reservedCheck?.fixable).toBe(true);
    expect(reservedCheck?.details?.[0]).toContain('.system');

    // Deliberately NOT fixDiagnostics(report) here: runDiagnostics()
    // internally calls the real, un-mocked detectInstalledAgents() (only
    // hubPath is overridable - there's no equivalent override for an
    // agent's own skillsDir), so the report can also contain a REAL
    // "agent skills folder not linked" check for whatever AI agents are
    // actually installed on the machine running this test. Found the hard
    // way: fixDiagnostics(report) ran that check's fixAction too, which
    // created a real junction from the developer's actual ~/.claude/skills
    // (etc.) to this test's tempHub - later deleted by afterEach(),
    // leaving a broken link on their real machine. Call only the specific
    // fixAction this test is about instead of ever fixing a whole report
    // that came from an unmocked detectInstalledAgents() call.
    expect(reservedCheck?.fixAction).toBeDefined();
    const fixed = await reservedCheck!.fixAction!();
    expect(fixed).toBe(true);

    // The reserved folder is gone from the hub...
    expect(await pathExists(path.join(tempHub, '.system'))).toBe(false);
    // ...but the real skill that happened to live alongside it wasn't touched.
    expect(await pathExists(path.join(tempHub, 'real-skill', 'SKILL.md'))).toBe(true);
  });
});
