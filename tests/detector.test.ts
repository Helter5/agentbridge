import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { detectInstalledAgents, SUPPORTED_AGENTS } from '../src/core/detector.js';
import { safeWriteJson, ensureDir } from '../src/utils/fs.js';

describe('Client Detector Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentsync-detector-test-${Date.now()}`);
  const tempHub = path.join(tempDir, 'hub');

  beforeEach(async () => {
    await ensureDir(tempDir);
    await ensureDir(tempHub);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('defines all 4 core AI coding agents in registry', () => {
    expect(SUPPORTED_AGENTS.antigravity).toBeDefined();
    expect(SUPPORTED_AGENTS.claude).toBeDefined();
    expect(SUPPORTED_AGENTS.codex).toBeDefined();
    expect(SUPPORTED_AGENTS.cursor).toBeDefined();
  });

  it('detects agent presence when config files or directories exist', async () => {
    const agents = await detectInstalledAgents({
      customHubPath: tempHub,
      checkAll: true,
    });

    expect(agents.length).toBe(Object.keys(SUPPORTED_AGENTS).length);
    const antigravity = agents.find((a) => a.id === 'antigravity');
    expect(antigravity).toBeDefined();
    expect(antigravity?.name).toBe('Google Antigravity');
  });
});
