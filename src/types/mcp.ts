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

export interface MCPSyncResult {
  agentId: string;
  filePath: string;
  success: boolean;
  addedServers: string[];
  updatedServers: string[];
  totalServers: number;
  error?: string;
}

export interface MCPSyncSummary {
  mergedServers: Record<string, MCPServerConfig>;
  serverSources: Record<string, string[]>;
  results: MCPSyncResult[];
}
