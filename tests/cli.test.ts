import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

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

  it('rollback with a nonexistent snapshot ID prints the specific "Snapshot not found" reason, not just a generic failure', async () => {
    // restoreBackupSnapshot() (core/rollback.ts) already computed the right
    // reason (`error: "Snapshot not found: <id>"`) for this exact case, but
    // cli.ts's failure branch only ever looped over `result.failedFiles` -
    // empty here, since no per-file restore was ever attempted - so the
    // specific reason never reached the terminal, just a generic "Rollback
    // failed or was incomplete." This is a real CLI-level regression: it
    // has to run the built binary, not just call the core function.
    const tempDir = path.join(os.tmpdir(), `agentbridge-cli-rollback-test-${Date.now()}`);
    const backupsDir = path.join(tempDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    // At least one real (valid) snapshot must exist, otherwise the CLI
    // short-circuits earlier with "No backup snapshots found" - a
    // different, already-correct code path this test isn't targeting.
    fs.writeFileSync(
      path.join(backupsDir, 'snapshot-real.json'),
      JSON.stringify({
        id: 'snapshot-real',
        timestamp: new Date().toISOString(),
        description: 'unrelated real snapshot',
        files: {},
      }),
      'utf-8'
    );

    try {
      await execFileAsync(
        'node',
        [cliPath, 'rollback', 'totally-fake-snapshot-id-xyz'],
        { env: { ...process.env, AGENTBRIDGE_BACKUPS_DIR: backupsDir } }
      );
      throw new Error('expected rollback to exit non-zero');
    } catch (err: any) {
      // execFile rejects on non-zero exit; stdout/stderr are still attached.
      expect(err.code).toBe(1);
      const output = (err.stdout || '') + (err.stderr || '');
      expect(output).toContain('Snapshot not found: totally-fake-snapshot-id-xyz');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
