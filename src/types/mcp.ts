export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
  url?: string;
  transport?: 'stdio' | 'sse' | 'websocket' | string;
  [key: string]: unknown;
}

export interface MCPConfigFile {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: unknown;
}

export interface MCPServerEntry {
  name: string;
  config: MCPServerConfig;
  sourceAgents: string[];
}

/**
 * Two agents independently configured a server with the same name, but
 * their definitions genuinely disagree on one or more fields (not just
 * "one has an extra env var the other doesn't") - the later-merged side
 * silently wins on those fields. Unlike SkillCollision (skill-linker.ts),
 * this doesn't block anything; it's purely a signal for the caller to
 * surface to the user.
 */
export interface MCPServerCollision {
  serverName: string;
  conflictingFields: string[];
  sources: string[];
}

export interface MCPSyncResult {
  agentId: string;
  filePath: string;
  success: boolean;
  addedServers: string[];
  updatedServers: string[];
  totalServers: number;
  error?: string;
  /**
   * True when this agent's existing config file had unparseable JSON at
   * sync time. The sync still proceeds (treating it as if the file were
   * empty, then backing it up and rewriting it), but callers should
   * surface this distinctly from a normal success - the file's prior
   * content (and any of its own MCP servers) was silently dropped from
   * the merge rather than genuinely absent.
   */
  configWasInvalid?: boolean;
}

export interface MCPSyncSummary {
  mergedServers: Record<string, MCPServerConfig>;
  serverSources: Record<string, string[]>;
  results: MCPSyncResult[];
  invalidConfigs: { agentId: string; agentName: string; filePath: string }[];
  collisions: MCPServerCollision[];
}
