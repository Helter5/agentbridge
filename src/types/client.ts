// 'cursor' deliberately excluded for now - see SUPPORTED_AGENTS
// (constants.ts). Re-add here first when bringing it back; the Record
// there won't compile until every id here also has an entry.
export type AgentId =
  | 'antigravity'
  | 'claude'
  | 'codex';

export interface AgentConfigPaths {
  configDir: string;
  skillsDir: string;
  mcpConfigFile?: string;
  /**
   * On-disk format of mcpConfigFile. Defaults to 'json' when unset - every
   * supported agent except Codex uses JSON. Codex's config.toml is real
   * TOML (see utils/toml.ts): reading/writing it as JSON silently no-ops
   * (JSON.parse throws on TOML, or worse, succeeds on an unrelated file)
   * without this discriminator telling mcp-sync.ts / doctor.ts which
   * parser to use.
   */
  mcpConfigFormat?: 'json' | 'toml';
  globalRulesFile?: string;
  settingsFile?: string;
}

export interface AgentDefinition {
  id: AgentId;
  name: string;
  displayName: string;
  homepage: string;
  description: string;
  defaultPaths: {
    skillsDir: string;
    mcpConfigFile?: string;
    mcpConfigFormat?: 'json' | 'toml';
    globalRulesFile?: string;
    settingsFile?: string;
  };
}

export interface DetectedAgent {
  id: AgentId;
  name: string;
  displayName: string;
  isInstalled: boolean;
  paths: AgentConfigPaths;
  existingSkillsCount: number;
  existingMcpServersCount: number;
  isLinkedToHub: boolean;
  linkStatus?: 'linked' | 'direct_dir' | 'missing' | 'broken_link';
}
