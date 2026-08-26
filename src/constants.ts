import path from 'node:path';
import os from 'node:os';
import type { AgentId, AgentDefinition } from './types/client.js';
import type { RuleTargetType } from './types/rules.js';

// Central Hub Paths
export const DEFAULT_HUB_ROOT = '~/.agentbridge';
export const DEFAULT_HUB_SKILLS_PATH = '~/.agentbridge/skills';
export const DEFAULT_MASTER_MCP_PATH = '~/.agentbridge/mcp_servers.json';
export const DEFAULT_GLOBAL_RULES_PATH = '~/.agentbridge/global_rules.md';
export const DEFAULT_CONFIG_PATH = '~/.agentbridge/config.json';
// Single shared lockfile path so every writer (CLI commands, watcher,
// rollback snapshots) contends on the same lock.
export const DEFAULT_LOCK_PATH = '~/.agentbridge/.lock';
// One-shot CLI commands (as opposed to the long-running watcher, which is
// fine skipping a change and picking it up on its next debounce) retry
// acquiring the shared lock for this long before giving up and reporting
// a clear failure - long enough to ride out a typical watcher-triggered
// sync (tens of milliseconds) without the user's command silently no-op'ing.
export const LOCK_RETRY_MAX_WAIT_MS = 3000;

// Generated Header Comment for mirrored rule files
export const AUTO_GENERATED_HEADER = `<!-- Auto-synchronized by AgentBridge from AGENTS.md. DO NOT EDIT DIRECTLY. -->\n\n`;

// Supported Project Rule Targets
export const RULE_TARGET_FILES: Record<RuleTargetType, string> = {
  claude: 'CLAUDE.md',
  gemini: 'GEMINI.md',
  codex: 'CODEX.md',
  cursor: '.cursorrules',
  copilot: '.github/copilot-instructions.md',
};

// Candidate rule filenames to look for in a project root
export const RULE_SOURCE_CANDIDATES = [
  'AGENTS.md',
  'agents.md',
  'CLAUDE.md',
  'GEMINI.md',
  'CODEX.md',
  '.cursorrules',
];

/**
 * Returns OS-specific paths for Claude Desktop configuration
 */
export function getClaudeDesktopConfigPath(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  } else if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, 'Claude', 'claude_desktop_config.json');
  }
}

/**
 * Registry of supported AI Coding Agents. Cursor is deliberately excluded
 * for now (see AgentId, types/client.ts) - the type stays absent so
 * SUPPORTED_AGENTS' Record<AgentId, AgentDefinition> can't silently drift
 * out of sync with which agents are actually wired up.
 */
export const SUPPORTED_AGENTS: Record<AgentId, AgentDefinition> = {
  antigravity: {
    id: 'antigravity',
    name: 'Google Antigravity',
    displayName: 'Google Antigravity',
    homepage: 'https://github.com/google-deepmind/antigravity',
    description: 'Advanced Agentic Coding IDE & CLI by Google DeepMind',
    defaultPaths: {
      skillsDir: '~/.gemini/config/skills',
      mcpConfigFile: '~/.gemini/config/mcp_config.json',
      globalRulesFile: '~/.gemini/GEMINI.md',
      settingsFile: '~/.gemini/config/settings.json',
    },
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    displayName: 'Claude Code / Desktop',
    homepage: 'https://claude.ai/code',
    description: 'Anthropic Claude Code CLI & Desktop Agent',
    defaultPaths: {
      skillsDir: '~/.claude/skills',
      mcpConfigFile: getClaudeDesktopConfigPath(),
      globalRulesFile: '~/.claude/CLAUDE.md',
      settingsFile: '~/.claude/settings.json',
    },
  },
  codex: {
    id: 'codex',
    name: 'OpenAI Codex',
    displayName: 'OpenAI Codex',
    homepage: 'https://openai.com/codex',
    description: 'OpenAI Codex Developer Agent CLI',
    defaultPaths: {
      skillsDir: '~/.codex/skills',
      // Real Codex CLI reads MCP servers from config.toml's [mcp_servers.*]
      // tables, not a config.json - confirmed by inspecting an actual
      // installed Codex's config on a real machine (config.json isn't read
      // at all; a prior sync writing there left Codex silently blind to
      // every synced server despite that file looking perfectly valid).
      mcpConfigFile: '~/.codex/config.toml',
      mcpConfigFormat: 'toml',
      globalRulesFile: '~/.codex/CODEX.md',
      settingsFile: '~/.codex/settings.json',
    },
  },
  // Cursor deliberately excluded for now - see AgentId (types/client.ts).
};

