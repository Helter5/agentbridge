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

  it('unlink reports "Successfully unlinked." (no "and restored") when --no-restore is passed, and the full phrase by default', async () => {
    // Found via manual testing: this line was hardcoded to always say
    // "and restored" regardless of --no-restore - with --no-restore the
    // standalone folder is genuinely left empty (nothing copied back), so
    // the message claimed something that didn't happen. success itself was
    // always accurate (the unlink genuinely succeeded); only the wording
    // was wrong - a different, shallower bug than the PR #11-16 family
    // (those had success:true over an actual failure; this has an
    // accurate success with an inaccurate verb).
    const fakeHome = path.join(os.tmpdir(), `agentbridge-cli-unlink-test-${Date.now()}`);
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    };

    try {
      fs.mkdirSync(path.join(fakeHome, '.claude', 'skills', 'demo-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: demo\n---\n\nBody\n',
        'utf-8'
      );

      // Default: link, then unlink with no flags - restore did happen.
      await execFileAsync('node', [cliPath, 'link-skills', '--yes'], { env });
      const { stdout: defaultOut } = await execFileAsync('node', [cliPath, 'unlink', '--yes'], { env });
      expect(defaultOut).toContain('Successfully unlinked and restored.');

      // --no-restore: link again, then unlink with --no-restore - the
      // folder is left empty, so the message must not claim a restore.
      await execFileAsync('node', [cliPath, 'link-skills', '--yes'], { env });
      const { stdout: noRestoreOut } = await execFileAsync(
        'node',
        [cliPath, 'unlink', '--yes', '--no-restore'],
        { env }
      );
      expect(noRestoreOut).toContain('Successfully unlinked.');
      expect(noRestoreOut).not.toContain('Successfully unlinked and restored.');

      const restoredContents = fs.readdirSync(path.join(fakeHome, '.claude', 'skills'));
      expect(restoredContents).toEqual([]);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('link-skills reports the exact path it backed up an existing skills folder to, and says nothing with --no-backup', async () => {
    // Found via manual sandbox testing: link-skills silently renames an
    // existing regular skills folder aside to `<dir>.backup-<timestamp>`
    // before linking (the --no-backup flag's protection) - the backup
    // itself worked, but the CLI never said so, and this backup is a
    // separate mechanism from rollback.ts's tracked snapshots (`agentbridge
    // rollback --list` doesn't know about it either). A user recovering
    // from a bad link had to know to go looking for it themselves.
    const fakeHome = path.join(os.tmpdir(), `agentbridge-cli-backup-msg-test-${Date.now()}`);
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    };
    const skillsDir = path.join(fakeHome, '.claude', 'skills');

    try {
      fs.mkdirSync(path.join(skillsDir, 'demo-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(skillsDir, 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: demo\n---\n\nBody\n',
        'utf-8'
      );

      const { stdout } = await execFileAsync('node', [cliPath, 'link-skills', '--yes'], { env });
      expect(stdout).toContain('Backed up existing skills to');

      const match = stdout.match(/Backed up existing skills to (.+skills\.backup-[^\s]+)/);
      expect(match).not.toBeNull();
      const reportedPath = match![1].trim();
      // The path is printed via contractHome() (a leading ~ instead of the
      // full home dir), same as every other path in the CLI's output - so
      // resolve it back against fakeHome rather than using it verbatim.
      const actualBackupDir = path.join(fakeHome, '.claude', path.basename(reportedPath));
      // The path the CLI printed must be the real, existing backup - not
      // just plausible-looking text.
      expect(fs.existsSync(actualBackupDir)).toBe(true);
      expect(fs.existsSync(path.join(actualBackupDir, 'demo-skill', 'SKILL.md'))).toBe(true);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }

    // --no-backup: nothing was renamed aside, so nothing should be reported.
    const fakeHome2 = path.join(os.tmpdir(), `agentbridge-cli-nobackup-msg-test-${Date.now()}`);
    const env2 = {
      ...process.env,
      HOME: fakeHome2,
      USERPROFILE: fakeHome2,
      APPDATA: path.join(fakeHome2, 'AppData', 'Roaming'),
    };
    const skillsDir2 = path.join(fakeHome2, '.claude', 'skills');
    try {
      fs.mkdirSync(path.join(skillsDir2, 'demo-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(skillsDir2, 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: demo\n---\n\nBody\n',
        'utf-8'
      );

      const { stdout } = await execFileAsync(
        'node',
        [cliPath, 'link-skills', '--yes', '--no-backup'],
        { env: env2 }
      );
      expect(stdout).not.toContain('Backed up existing skills to');
    } finally {
      fs.rmSync(fakeHome2, { recursive: true, force: true });
    }
  });

  it('sync-rules with a nonexistent --cwd errors instead of silently creating a whole new project directory tree', async () => {
    // Found via manual testing: --cwd pointing at a path that doesn't exist
    // didn't error at all - it silently created the entire directory
    // (mkdir -p) plus a fresh boilerplate AGENTS.md and every target file,
    // then exited 0. A typo'd --cwd would leave the real project untouched
    // while a brand-new, unrelated directory tree appeared at the wrong
    // path with no warning.
    const base = path.join(os.tmpdir(), `agentbridge-cli-syncrules-test-${Date.now()}`);
    const nonexistentCwd = path.join(base, 'does-not-exist-anywhere');
    // base itself doesn't exist either - confirms nothing gets created at
    // any level of the path, not just the leaf directory.
    expect(fs.existsSync(base)).toBe(false);

    try {
      await execFileAsync('node', [cliPath, 'sync-rules', '--cwd', nonexistentCwd, '--yes']);
      throw new Error('expected sync-rules to exit non-zero for a nonexistent --cwd');
    } catch (err: any) {
      expect(err.code).toBe(1);
      const output = (err.stdout || '') + (err.stderr || '');
      expect(output).toContain('Directory does not exist');
      expect(output).toContain(nonexistentCwd);
      expect(fs.existsSync(base)).toBe(false);
    }
  });

  it('link-skills reports a clear error and exits 1 instead of "Something went wrong" + exit 0 when an agent\'s skillsDir is unreadable', async () => {
    // Found via manual testing: link-skills was the only one of the 5
    // mutating commands (status/doctor/unlink/pick/sync-mcp/sync-rules/
    // add-skill all already had this) with no try/catch around its core
    // call. A real fs error (here: skillsDir exists as a plain FILE, not
    // a directory - fsp.readdir() on it throws ENOTDIR) escaped uncaught,
    // past @clack/prompts' own uncaughtExceptionMonitor (which prints a
    // generic "Something went wrong" purely to clean up the spinner
    // display) with no process.exitCode ever set - exit 0 despite a
    // completely failed operation and zero specifics about why.
    const fakeHome = path.join(os.tmpdir(), `agentbridge-cli-linkskills-enotdir-${Date.now()}`);
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    };

    try {
      fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
      // skillsDir exists as a plain file where a directory is expected.
      fs.writeFileSync(path.join(fakeHome, '.claude', 'skills'), 'not a directory', 'utf-8');

      await execFileAsync('node', [cliPath, 'link-skills', '--yes'], { env });
      throw new Error('expected link-skills to exit non-zero');
    } catch (err: any) {
      expect(err.code).toBe(1);
      const output = (err.stdout || '') + (err.stderr || '');
      expect(output).not.toContain('Something went wrong');
      expect(output).toMatch(/ENOTDIR|not a directory/i);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('link-skills reports which agent failed and which were already processed when it fails partway through multiple agents', async () => {
    // Follow-up to the ENOTDIR test above: that test only has 1 agent, so
    // it can't tell "the failing agent" apart from "the whole operation".
    // With 3 detected agents (Google Antigravity, Claude Code, OpenAI
    // Codex - Claude Code deliberately broken as the 2nd one processed),
    // the terminal output must name which agent actually failed and which
    // agent completed before it - not just repeat the bare exception.
    const fakeHome = path.join(os.tmpdir(), `agentbridge-cli-linkskills-partial-${Date.now()}`);
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    };

    try {
      // Google Antigravity - valid, processed 1st, should succeed.
      fs.mkdirSync(path.join(fakeHome, '.gemini', 'config', 'skills', 'gemini-skill'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(fakeHome, '.gemini', 'config', 'skills', 'gemini-skill', 'SKILL.md'),
        '---\nname: gemini-skill\ndescription: d\n---\n',
        'utf-8'
      );
      // Claude Code - broken, processed 2nd, causes the failure.
      fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, '.claude', 'skills'), 'not a directory', 'utf-8');
      // OpenAI Codex - valid, but never reached (processed 3rd).
      fs.mkdirSync(path.join(fakeHome, '.codex', 'skills', 'codex-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.codex', 'skills', 'codex-skill', 'SKILL.md'),
        '---\nname: codex-skill\ndescription: d\n---\n',
        'utf-8'
      );

      await execFileAsync('node', [cliPath, 'link-skills', '--yes'], { env });
      throw new Error('expected link-skills to exit non-zero');
    } catch (err: any) {
      expect(err.code).toBe(1);
      const output = (err.stdout || '') + (err.stderr || '');
      expect(output).toContain('Google Antigravity');
      expect(output).toContain('Claude Code');
      expect(output).toMatch(/doctor/i);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor without --fix exits 1 when it finds issues (even warning-level ones like a broken link), and 0 after --fix resolves them', async () => {
    // Found via manual testing: the text already said "⚠ Found issues
    // requiring attention" truthfully, but process.exitCode was never
    // set - a script relying on the exit code (`agentbridge doctor &&
    // deploy`) would proceed past real problems. Broken links, exposed
    // secrets, and skill-name collisions are all reported at `warning`
    // severity (not `errors`) in doctor's own report, so checking
    // `errors` alone (a first-pass fix) would have missed the exact
    // broken-link case this test exercises - checking warnings too was
    // needed.
    const fakeHome = path.join(os.tmpdir(), `agentbridge-cli-doctor-exit-${Date.now()}`);
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    };

    try {
      // A skills dir that's a real symlink/junction, but points at a
      // target that doesn't exist - doctor's "Broken Link" warning.
      const claudeDir = path.join(fakeHome, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const brokenTarget = path.join(fakeHome, 'nonexistent-target');
      fs.mkdirSync(brokenTarget, { recursive: true });
      fs.symlinkSync(brokenTarget, path.join(claudeDir, 'skills'), 'junction');
      fs.rmSync(brokenTarget, { recursive: true, force: true });

      try {
        await execFileAsync('node', [cliPath, 'doctor'], { env });
        throw new Error('expected doctor to exit non-zero without --fix');
      } catch (err: any) {
        expect(err.code).toBe(1);
        const output = (err.stdout || '') + (err.stderr || '');
        expect(output).toContain('Broken Link');
      }

      // --fix resolves it - exit code goes back to 0.
      const { stdout: fixOut } = await execFileAsync('node', [cliPath, 'doctor', '--fix'], { env });
      expect(fixOut).toContain('Fixed');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
