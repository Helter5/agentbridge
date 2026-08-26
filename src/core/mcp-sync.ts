import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  expandHome,
  pathExists,
  safeReadJson,
  safeWriteJson,
  backupPath,
  ensureDir,
} from '../utils/fs.js';
import {
  validateMCPConfigFile,
  validateMCPServerConfig,
  redactEnvRecord,
  interpolateEnvString,
  isEnvPlaceholder,
} from '../utils/schema.js';
import { DEFAULT_MASTER_MCP_PATH } from '../constants.js';
import type { DetectedAgent } from '../types/client.js';
import type {
  MCPServerConfig,
  MCPConfigFile,
  MCPServerEntry,
  MCPServerCollision,
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
 * MCP server names come straight from JSON.parse()'d agent config files
 * (see safeReadJson). Assigning into a plain object with obj[name] = ...
 * where name is "__proto__" invokes Object.prototype's __proto__ setter
 * and reassigns that object's own prototype - reject those keys before
 * any such assignment.
 */
function isUnsafeObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * Reads and parses a JSON file, distinguishing "file has invalid JSON" from
 * "file is missing/unreadable". safeReadJson() (utils/fs.ts) collapses both
 * into a plain null, which is fine for its other callers but hides a real
 * problem here: a hand-edited agent config with a syntax error (trailing
 * comma, truncated write, etc.) would otherwise be silently treated as an
 * empty config and its existing servers dropped from the merge / its file
 * rewritten from scratch, with no indication to the user that anything was
 * wrong versus a normal "first sync" of a fresh file.
 */
async function readJsonFileWithDiagnostics<T = unknown>(
  filePath: string
): Promise<{ data: T | null; invalid: boolean }> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch {
    return { data: null, invalid: false };
  }
  try {
    return { data: JSON.parse(content) as T, invalid: false };
  } catch {
    return { data: null, invalid: true };
  }
}

/**
 * Describes which fields two definitions of the "same" MCP server (same
 * name, independently configured in two different agents) genuinely
 * disagree on - i.e. where mergeServerConfig() below would silently keep
 * one side's value and discard the other's, not just add something new.
 * A key present in only one side's `env` isn't a conflict (it's a union,
 * both survive) - only a key present in both with a different value is,
 * since the later side wins there. Same reasoning for `args`: it's only
 * ever wholesale-replaced (never merged) when the incoming side also sets
 * `command`, so a difference only matters in that case.
 */
function describeServerConflicts(a: MCPServerConfig, b: MCPServerConfig): string[] {
  const diffs: string[] = [];
  if (a.command && b.command && a.command !== b.command) {
    diffs.push('command');
  }
  if (b.command && a.args !== undefined && b.args !== undefined) {
    if (JSON.stringify(a.args) !== JSON.stringify(b.args)) {
      diffs.push('args');
    }
  }
  const envA = a.env || {};
  const envB = b.env || {};
  for (const key of Object.keys(envA)) {
    if (!(key in envB)) continue;
    // Found via real-machine testing: one side can hold `${VAR}` (e.g. the
    // hub registry, or an agent config already redacted by a previous
    // sync-mcp) while the other holds the literal value it resolves to
    // (e.g. an agent config synced before that env var was set, or edited
    // by hand) - same secret, not a genuine disagreement.
    const resolvedA = interpolateEnvString(envA[key]);
    const resolvedB = interpolateEnvString(envB[key]);
    if (resolvedA === resolvedB) continue;
    // If either side is STILL a placeholder after interpolation, its env
    // var isn't currently set, so there's no way to prove the two values
    // actually differ - it may well be the correct value once the var is
    // set. Only flag a conflict once both sides are known, comparable
    // values (never treat "can't verify" the same as "genuinely differs").
    if (isEnvPlaceholder(resolvedA) || isEnvPlaceholder(resolvedB)) continue;
    diffs.push(`env.${key}`);
  }
  return diffs;
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
 * Returns a copy of a server-config map with every env value that matches
 * its own env var replaced back with the ${VAR} placeholder, so resolved
 * secrets never get persisted to disk (see redactEnvRecord in utils/schema).
 */
function redactServerConfigsEnv(
  servers: Record<string, MCPServerConfig>
): Record<string, MCPServerConfig> {
  const redacted: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (isUnsafeObjectKey(name)) continue;
    redacted[name] = config.env ? { ...config, env: redactEnvRecord(config.env) } : config;
  }
  return redacted;
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
  invalidConfigs: { agentId: string; agentName: string; filePath: string }[];
  collisions: MCPServerCollision[];
}> {
  const mergedServers: Record<string, MCPServerConfig> = {};
  const serverSources: Record<string, string[]> = {};
  const invalidConfigs: { agentId: string; agentName: string; filePath: string }[] = [];
  const collisions: MCPServerCollision[] = [];

  // 1. Read master hub registry if present
  const masterHubPath = path.resolve(
    expandHome(options.masterHubPath || DEFAULT_MASTER_MCP_PATH)
  );
  if (await pathExists(masterHubPath)) {
    const hubContent = await safeReadJson<MCPConfigFile>(masterHubPath);
    if (hubContent?.mcpServers && typeof hubContent.mcpServers === 'object') {
      for (const [name, config] of Object.entries(hubContent.mcpServers)) {
        if (isUnsafeObjectKey(name)) continue;
        if (validateMCPServerConfig(config).isValid) {
          mergedServers[name] = { ...config };
          serverSources[name] = ['AgentBridge Hub'];
        }
      }
    }
  }

  // 2. Read from all detected agents
  for (const agent of agents) {
    if (!agent.paths.mcpConfigFile) continue;
    const filePath = expandHome(agent.paths.mcpConfigFile);
    if (!(await pathExists(filePath))) continue;

    const { data: fileContent, invalid } = await readJsonFileWithDiagnostics<MCPConfigFile>(filePath);
    if (invalid) {
      invalidConfigs.push({ agentId: agent.id, agentName: agent.name, filePath });
      continue;
    }
    if (!fileContent || !fileContent.mcpServers || typeof fileContent.mcpServers !== 'object') {
      continue;
    }

    for (const [serverName, config] of Object.entries(fileContent.mcpServers)) {
      if (isUnsafeObjectKey(serverName)) continue;
      const validation = validateMCPServerConfig(config);
      if (!validation.isValid) continue;

      if (!mergedServers[serverName]) {
        mergedServers[serverName] = { ...config };
        serverSources[serverName] = [agent.name];
      } else {
        // Unlike detectSkillCollisions() (skill-linker.ts), this check must
        // happen BEFORE the merge below overwrites the losing side - the
        // whole point is catching what mergeServerConfig() is about to
        // silently discard.
        const conflictingFields = describeServerConflicts(mergedServers[serverName], config);
        mergedServers[serverName] = mergeServerConfig(
          mergedServers[serverName],
          config
        );
        if (!serverSources[serverName].includes(agent.name)) {
          serverSources[serverName].push(agent.name);
        }
        if (conflictingFields.length > 0) {
          collisions.push({
            serverName,
            conflictingFields,
            sources: [...serverSources[serverName]],
          });
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

  return { mergedServers, serverSources, serverEntries, invalidConfigs, collisions };
}

/**
 * Syncs merged MCP configurations across all detected agent config files
 */
export async function syncMcpConfigs(
  agents: DetectedAgent[],
  options: MCPSyncOptions = {}
): Promise<MCPSyncSummary> {
  const { mergedServers, serverSources, invalidConfigs, collisions } = await collectMcpServers(agents, {
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
        configWasInvalid: invalidConfigs.some((c) => c.filePath === filePath),
      };

      try {
        let existingConfig: MCPConfigFile = {};
        if (await pathExists(filePath)) {
          // A parse failure here is intentionally treated the same as
          // "file absent" for the write itself (existingConfig stays {}),
          // matching prior behavior of not aborting the sync - but
          // result.configWasInvalid (set above from collectMcpServers'
          // pass over the same files) lets the caller warn the user
          // instead of reporting a silent, misleading "success".
          const { data } = await readJsonFileWithDiagnostics<MCPConfigFile>(filePath);
          existingConfig = data || {};
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
          existingConfig.mcpServers = redactServerConfigsEnv(newServers);
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
          mcpServers: redactServerConfigsEnv(mergedServers),
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
      await safeWriteJson(exportPath, { mcpServers: redactServerConfigsEnv(mergedServers) });
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
    invalidConfigs,
    collisions,
  };
}
