import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { runDiagnostics } from '../src/core/doctor.js';
import { ensureDir } from '../src/utils/fs.js';

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
});
