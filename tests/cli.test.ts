import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('dist/cli.js');

describe('CLI Integration Tests', () => {
  it('outputs version number on --version', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, '--version']);
    expect(stdout.trim()).toBe('0.1.0');
  });

  it('outputs help text on --help', async () => {
    const { stdout } = await execFileAsync('node', [cliPath, '--help']);
    expect(stdout).toContain('agentsync');
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
