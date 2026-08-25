import path from 'node:path';
import {
  expandHome,
  pathExists,
  safeReadJson,
  safeWriteJson,
  backupPath,
  ensureDir,
} from '../utils/fs.js';
import { validateMCPConfigFile, validateMCPServerConfig } from '../utils/schema.js';
import { DEFAULT_MASTER_MCP_PATH } from '../constants.js';
import type { DetectedAgent } from '../types/client.js';
import type {
  MCPServerConfig,
  MCPConfigFile,
  MCPServerEntry,
  MCPSyncResult,
  MCPSyncSummary,
} from '../types/mcp.js';

export interface MCPSyncOptions {
  dryRun?: boolean;
  backupExisting?: boolean;
  targetAgents?: string[];
  outputPath?: string;
  masterHubPath?: string;
}

/**
 * Deep-merges individual MCP Server configurations
 */
export function mergeServerConfig(
  base: MCPServerConfig,
  incoming: MCPServerConfig
): MCPServerConfig {
  const merged: MCPServerConfig = { ...base, ...incoming };

  // Merge env variables
  if (base.env || incoming.env) {
    merged.env = {
      ...(base.env || {}),
      ...(incoming.env || {}),
    };
  }

  // Merge autoApprove arrays if present
  if (base.autoApprove || incoming.autoApprove) {
    const set = new Set<string>([
      ...(base.autoApprove || []),
      ...(incoming.autoApprove || []),
    ]);
    merged.autoApprove = Array.from(set);
  }

  // Prefer incoming command & args if present
  if (incoming.command) {
    merged.command = incoming.command;
    merged.args = incoming.args || base.args;
  }

  return merged;
}

export interface CollectMcpOptions {
  masterHubPath?: string;
}

/**
 * Collects and merges all MCP servers from detected agents
 */
export async function collectMcpServers(
  agents: DetectedAgent[],
  options: CollectMcpOptions = {}
): Promise<{
  mergedServers: Record<string, MCPServerConfig>;
  serverSources: Record<string, string[]>;
  serverEntries: MCPServerEntry[];
}> {
  const mergedServers: Record<string, MCPServerConfig> = {};
  const serverSources: Record<string, string[]> = {};

  // 1. Read master hub registry if present
  const masterHubPath = path.resolve(
    expandHome(options.masterHubPath || DEFAULT_MASTER_MCP_PATH)
  );
  if (await pathExists(masterHubPath)) {
    const hubContent = await safeReadJson<MCPConfigFile>(masterHubPath);
    if (hubContent?.mcpServers && typeof hubContent.mcpServers === 'object') {
      for (const [name, config] of Object.entries(hubContent.mcpServers)) {
        if (validateMCPServerConfig(config).isValid) {
          mergedServers[name] = { ...config };
          serverSources[name] = ['AgentSync Hub'];
        }
      }
    }
  }

  // 2. Read from all detected agents
  for (const agent of agents) {
    if (!agent.paths.mcpConfigFile) continue;
    const filePath = expandHome(agent.paths.mcpConfigFile);
    if (!(await pathExists(filePath))) continue;

    const fileContent = await safeReadJson<MCPConfigFile>(filePath);
    if (!fileContent || !fileContent.mcpServers || typeof fileContent.mcpServers !== 'object') {
      continue;
    }

    for (const [serverName, config] of Object.entries(fileContent.mcpServers)) {
      const validation = validateMCPServerConfig(config);
      if (!validation.isValid) continue;

      if (!mergedServers[serverName]) {
        mergedServers[serverName] = { ...config };
        serverSources[serverName] = [agent.name];
      } else {
        mergedServers[serverName] = mergeServerConfig(
          mergedServers[serverName],
          config
        );
        if (!serverSources[serverName].includes(agent.name)) {
          serverSources[serverName].push(agent.name);
        }
      }
    }
  }

  const serverEntries: MCPServerEntry[] = Object.entries(mergedServers).map(
    ([name, config]) => ({
      name,
      config,
      sourceAgents: serverSources[name] || [],
    })
  );

  return { mergedServers, serverSources, serverEntries };
}

/**
 * Syncs merged MCP configurations across all detected agent config files
 */
export async function syncMcpConfigs(
  agents: DetectedAgent[],
  options: MCPSyncOptions = {}
): Promise<MCPSyncSummary> {
  const { mergedServers, serverSources } = await collectMcpServers(agents, {
    masterHubPath: options.masterHubPath,
  });
  const results: MCPSyncResult[] = [];

  const filteredAgents = options.targetAgents
    ? agents.filter((a) => options.targetAgents!.includes(a.id))
    : agents;

  const targetFilePaths = filteredAgents
    .map((a) => (a.paths.mcpConfigFile ? expandHome(a.paths.mcpConfigFile) : null))
    .filter((p): p is string => Boolean(p));

  const masterHubMcpPath = path.resolve(
    expandHome(options.masterHubPath || DEFAULT_MASTER_MCP_PATH)
  );
  if (!options.dryRun) {
    targetFilePaths.push(masterHubMcpPath);
  }

  const performSync = async () => {
    for (const agent of filteredAgents) {
      if (!agent.paths.mcpConfigFile) continue;
      const filePath = expandHome(agent.paths.mcpConfigFile);

      const result: MCPSyncResult = {
        agentId: agent.id,
        filePath,
        success: false,
        addedServers: [],
        updatedServers: [],
        totalServers: 0,
      };

      try {
        let existingConfig: MCPConfigFile = {};
        if (await pathExists(filePath)) {
          existingConfig = (await safeReadJson<MCPConfigFile>(filePath)) || {};
        }

        const existingServers = existingConfig.mcpServers || {};
        const newServers: Record<string, MCPServerConfig> = { ...existingServers };

        for (const [name, serverDef] of Object.entries(mergedServers)) {
          if (!newServers[name]) {
            newServers[name] = serverDef;
            result.addedServers.push(name);
          } else {
            newServers[name] = mergeServerConfig(newServers[name], serverDef);
            result.updatedServers.push(name);
          }
        }

        result.totalServers = Object.keys(newServers).length;

        if (!options.dryRun) {
          if (options.backupExisting && (await pathExists(filePath))) {
            await backupPath(filePath);
          }
          await ensureDir(path.dirname(filePath));
          existingConfig.mcpServers = newServers;
          await safeWriteJson(filePath, existingConfig);
        }

        result.success = true;
      } catch (err: any) {
        result.success = false;
        result.error = err.message || String(err);
        if (!options.dryRun) {
          throw err;
        }
      }

      results.push(result);
    }

    // Always maintain master registry in central hub
    if (!options.dryRun) {
      try {
        await ensureDir(path.dirname(masterHubMcpPath));
        await safeWriteJson(masterHubMcpPath, {
          $schema: 'https://json.schemastore.org/mcp-server-config.json',
          version: '1.0.0',
          lastSynchronized: new Date().toISOString(),
          mcpServers: mergedServers,
        });
      } catch (err) {
        // Master write error in transactional block
        throw err;
      }
    }

    // Export to standalone custom file if specified
    if (options.outputPath && !options.dryRun) {
      const exportPath = path.resolve(expandHome(options.outputPath));
      await ensureDir(path.dirname(exportPath));
      await safeWriteJson(exportPath, { mcpServers: mergedServers });
    }
  };

  if (!options.dryRun) {
    const { executeTransactionalOperation } = await import('./rollback.js');
    await executeTransactionalOperation('MCP Configurations Sync', targetFilePaths, performSync);
  } else {
    await performSync();
  }

  return {
    mergedServers,
    serverSources,
    results,
  };
}
