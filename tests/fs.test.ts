import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  expandHome,
  contractHome,
  pathExists,
  pathExistsSync,
  ensureDir,
  isSymlinkOrJunction,
  readLinkTarget,
  safeReadJson,
  safeWriteJson,
  copyDirRecursive,
  backupPath,
  removeLinkOrDir,
  createCrossPlatformLink,
} from '../src/utils/fs.js';

describe('Filesystem Utilities', () => {
  const tempDir = path.join(os.tmpdir(), `agentsync-fs-test-${Date.now()}`);

  beforeEach(async () => {
    await ensureDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('expands and contracts home directory paths correctly', () => {
    const home = os.homedir();
    // A path outside the home directory, built from the OS's own root
    // rather than a hardcoded POSIX ('/usr/local', '/tmp') or Windows
    // literal, so this assertion holds on every platform in CI.
    const unrelatedPath = path.join(path.parse(home).root, 'agentsync-unrelated-dir');

    expect(expandHome('~')).toBe(home);
    expect(expandHome('~/foo/bar')).toBe(path.join(home, 'foo', 'bar'));
    expect(expandHome('~\\foo\\bar')).toBe(path.join(home, 'foo', 'bar'));
    expect(expandHome(unrelatedPath)).toBe(unrelatedPath);

    expect(contractHome(home)).toBe('~');
    expect(contractHome(path.join(home, 'projects'))).toBe('~' + path.sep + 'projects');
    expect(contractHome(unrelatedPath)).toBe(unrelatedPath);
  });

  it('verifies pathExists and pathExistsSync', async () => {
    const filePath = path.join(tempDir, 'sample.txt');
    expect(await pathExists(filePath)).toBe(false);
    expect(pathExistsSync(filePath)).toBe(false);

    await fsp.writeFile(filePath, 'hello', 'utf-8');
    expect(await pathExists(filePath)).toBe(true);
    expect(pathExistsSync(filePath)).toBe(true);
  });

  it('safely reads and writes JSON data', async () => {
    const jsonFile = path.join(tempDir, 'data.json');
    expect(await safeReadJson(jsonFile)).toBeNull();

    await safeWriteJson(jsonFile, { key: 'value', numbers: [1, 2, 3] });
    const read = await safeReadJson<{ key: string; numbers: number[] }>(jsonFile);
    expect(read).toEqual({ key: 'value', numbers: [1, 2, 3] });
  });

  it('copies directories recursively', async () => {
    const srcDir = path.join(tempDir, 'src');
    const destDir = path.join(tempDir, 'dest');
    await ensureDir(path.join(srcDir, 'sub'));
    await fsp.writeFile(path.join(srcDir, 'file1.txt'), 'content 1', 'utf-8');
    await fsp.writeFile(path.join(srcDir, 'sub', 'file2.txt'), 'content 2', 'utf-8');

    await copyDirRecursive(srcDir, destDir);
    expect(await pathExists(path.join(destDir, 'file1.txt'))).toBe(true);
    expect(await pathExists(path.join(destDir, 'sub', 'file2.txt'))).toBe(true);
  });

  it('creates timestamped backups', async () => {
    const targetFile = path.join(tempDir, 'target.txt');
    await fsp.writeFile(targetFile, 'original', 'utf-8');

    const backup = await backupPath(targetFile);
    expect(await pathExists(backup)).toBe(true);
    expect(await pathExists(targetFile)).toBe(false);
  });

  it('creates cross-platform links and identifies links/junctions', async () => {
    const sourceDir = path.join(tempDir, 'source-folder');
    const linkDir = path.join(tempDir, 'link-folder');
    await ensureDir(sourceDir);
    await fsp.writeFile(path.join(sourceDir, 'sample.txt'), 'data', 'utf-8');

    const result = await createCrossPlatformLink(sourceDir, linkDir, 'dir');
    expect(result.success).toBe(true);
    expect(await isSymlinkOrJunction(linkDir)).toBe(true);

    const target = await readLinkTarget(linkDir);
    expect(target).not.toBeNull();

    // Re-linking existing target returns already_linked
    const reLink = await createCrossPlatformLink(sourceDir, linkDir, 'dir');
    expect(reLink.success).toBe(true);
    expect(reLink.action).toBe('already_linked');

    // Clean removal
    await removeLinkOrDir(linkDir);
    expect(await isSymlinkOrJunction(linkDir)).toBe(false);
  });
});
