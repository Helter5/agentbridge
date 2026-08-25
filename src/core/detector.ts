import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  expandHome,
  pathExists,
  isSymlinkOrJunction,
  readLinkTarget,
  safeReadJson,
} from '../utils/fs.js';
import type {
  AgentId,
  AgentDefinition,
  DetectedAgent,
  AgentConfigPaths,
} from '../types/client.js';
import type { MCPConfigFile } from '../types/mcp.js';

import {
  DEFAULT_HUB_SKILLS_PATH,
  SUPPORTED_AGENTS,
} from '../constants.js';

export { DEFAULT_HUB_SKILLS_PATH, SUPPORTED_AGENTS };

export interface DetectorOptions {
  customHubPath?: string;
  checkAll?: boolean;
}

/**
 * Counts skills in a given directory
 */
async function countSkillsInDir(skillsDir: string): Promise<number> {
  try {
    if (!(await pathExists(skillsDir))) return 0;
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Only a directory that actually contains SKILL.md is a skill -
        // both branches here used to increment unconditionally, so any
        // unrelated subdirectory (a broken partial copy, .git, an empty
        // folder) was counted as a skill too.
        const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
        if (await pathExists(skillMd)) {
          count++;
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Standalone markdown_file-type skills (a loose .md file directly
        // in the skills dir, not wrapped in its own folder) - unaffected
        // by the directory-only fix above.
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Counts configured MCP servers in a given config file
 */
async function countMcpServers(configFile?: string): Promise<number> {
  if (!configFile) return 0;
  const json = await safeReadJson<MCPConfigFile>(configFile);
  if (!json || !json.mcpServers || typeof json.mcpServers !== 'object') return 0;
  return Object.keys(json.mcpServers).length;
}

/**
 * Checks link status of an agent's skills dir against the central hub
 */
async function checkLinkStatus(
  skillsDir: string,
  hubPath: string
): Promise<{ isLinked: boolean; status: DetectedAgent['linkStatus'] }> {
  if (!(await pathExists(skillsDir)) && !(await isSymlinkOrJunction(skillsDir))) {
    return { isLinked: false, status: 'missing' };
  }

  const isLink = await isSymlinkOrJunction(skillsDir);
  if (isLink) {
    const target = await readLinkTarget(skillsDir);
    const absHub = path.resolve(hubPath);
    // readlink() can return a path relative to the link's own directory
    // (common for POSIX symlinks); resolve against that directory, not cwd.
    if (target && path.resolve(path.dirname(skillsDir), target) === absHub) {
      return { isLinked: true, status: 'linked' };
    }
    return { isLinked: false, status: 'broken_link' };
  }

  return { isLinked: false, status: 'direct_dir' };
}

/**
 * Detects all installed AI coding agents on the machine
 */
export async function detectInstalledAgents(
  options: DetectorOptions = {}
): Promise<DetectedAgent[]> {
  const hubPath = expandHome(options.customHubPath || DEFAULT_HUB_SKILLS_PATH);
  const detected: DetectedAgent[] = [];

  for (const [id, def] of Object.entries(SUPPORTED_AGENTS) as [AgentId, AgentDefinition][]) {
    const skillsDir = expandHome(def.defaultPaths.skillsDir);
    const mcpConfigFile = def.defaultPaths.mcpConfigFile
      ? expandHome(def.defaultPaths.mcpConfigFile)
      : undefined;
    const globalRulesFile = def.defaultPaths.globalRulesFile
      ? expandHome(def.defaultPaths.globalRulesFile)
      : undefined;
    const settingsFile = def.defaultPaths.settingsFile
      ? expandHome(def.defaultPaths.settingsFile)
      : undefined;

    const configDir = path.dirname(skillsDir);

    // Alternative path resolution for Antigravity (checks both ~/.gemini/config and ~/.gemini/antigravity)
    let actualMcpFile = mcpConfigFile;
    if (id === 'antigravity') {
      const altMcp = expandHome('~/.gemini/antigravity/mcp_config.json');
      if (actualMcpFile && !(await pathExists(actualMcpFile)) && (await pathExists(altMcp))) {
        actualMcpFile = altMcp;
      }
    }
    // Alternative path resolution for Claude (checks ~/.claude.json as well)
    if (id === 'claude') {
      const altClaudeJson = expandHome('~/.claude.json');
      if (actualMcpFile && !(await pathExists(actualMcpFile)) && (await pathExists(altClaudeJson))) {
        actualMcpFile = altClaudeJson;
      }
    }

    const paths: AgentConfigPaths = {
      configDir,
      skillsDir,
      mcpConfigFile: actualMcpFile,
      globalRulesFile,
      settingsFile,
    };

    // Determine if installed
    const configDirExists = await pathExists(configDir);
    const skillsDirExists =
      (await pathExists(skillsDir)) || (await isSymlinkOrJunction(skillsDir));
    const mcpExists = actualMcpFile ? await pathExists(actualMcpFile) : false;
    const settingsExists = settingsFile ? await pathExists(settingsFile) : false;

    const isInstalled =
      configDirExists || skillsDirExists || mcpExists || settingsExists;

    if (isInstalled || options.checkAll) {
      const { isLinked, status } = await checkLinkStatus(skillsDir, hubPath);
      const existingSkillsCount = await countSkillsInDir(skillsDir);
      const existingMcpServersCount = await countMcpServers(actualMcpFile);

      detected.push({
        id,
        name: def.name,
        displayName: def.displayName,
        isInstalled,
        paths,
        existingSkillsCount,
        existingMcpServersCount,
        isLinkedToHub: isLinked,
        linkStatus: status,
      });
    }
  }

  return detected;
}
