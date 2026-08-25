export type AgentId =
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'cursor';

export interface AgentConfigPaths {
  configDir: string;
  skillsDir: string;
  mcpConfigFile?: string;
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
