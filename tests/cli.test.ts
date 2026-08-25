import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('dist/cli.js');
// Read the expected version from package.json instead of hardcoding a
// literal here - a hardcoded expectation is exactly what let the CLI's
// own --version output silently drift out of sync with package.json
// (it did, for one release: package.json said 0.2.0, --version said 0.1.0).
const { version: expectedVersion } = JSON.parse(
  fs.readFileSync(path.resolve('package.json'), 'utf-8')
);

describe('CLI Integration Tests', () => {
  it('outputs version number on --version', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, '--version']);
    expect(stdout.trim()).toBe(expectedVersion);
  });

  it('outputs help text on --help', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, '--help']);
    expect(stdout).toContain('agentbridge');
    expect(stdout).toContain('Universal Skill & MCP Sync Engine');
    expect(stdout).toContain('status');
    expect(stdout).toContain('link-skills');
    expect(stdout).toContain('sync-mcp');
    expect(stdout).toContain('sync-rules');
    expect(stdout).toContain('add-skill');
    expect(stdout).toContain('doctor');
  });

  it('outputs valid JSON for status --json', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, 'status', '--json']);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('hubPath');
    expect(data).toHaveProperty('hubSkillsCount');
    expect(data).toHaveProperty('agents');
    expect(Array.isArray(data.agents)).toBe(true);
  });
});
