import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  mergeServerConfig,
  collectMcpServers,
  syncMcpConfigs,
} from '../src/core/mcp-sync.js';
import { safeWriteJson, safeReadJson, ensureDir } from '../src/utils/fs.js';
import type { DetectedAgent } from '../src/types/client.js';
import type { MCPConfigFile } from '../src/types/mcp.js';

describe('MCP Synchronizer Engine', () => {
  const tempDir = path.join(os.tmpdir(), `agentbridge-mcp-test-${Date.now()}`);

  beforeEach(async () => {
    await ensureDir(tempDir);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('merges server configurations with deep environment variables', () => {
    const base = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: { DB_PORT: '5432', SHARED_KEY: 'base' },
    };

    const incoming = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: { DB_HOST: 'localhost', SHARED_KEY: 'override' },
      autoApprove: ['query'],
    };

    const merged = mergeServerConfig(base, incoming);
    expect(merged.command).toBe('npx');
    expect(merged.env).toEqual({
      DB_PORT: '5432',
      DB_HOST: 'localhost',
      SHARED_KEY: 'override',
    });
    expect(merged.autoApprove).toEqual(['query']);
  });

  it('collects and merges MCP servers across multiple agent configs', async () => {
    const antigravityConfigFile = path.join(tempDir, 'gemini-mcp.json');
    const claudeConfigFile = path.join(tempDir, 'claude-desktop.json');

    await safeWriteJson(antigravityConfigFile, {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'token123' },
        },
      },
      unrelatedSetting: 'antigravity-custom',
    });

    await safeWriteJson(claudeConfigFile, {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_USER: 'octocat' },
        },
        memory: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
        },
      },
      claudeTheme: 'dark',
    });

    const mockAgents: DetectedAgent[] = [
      {
        id: 'antigravity',
        name: 'Google Antigravity',
        displayName: 'Google Antigravity',
        isInstalled: true,
        paths: {
          configDir: tempDir,
          skillsDir: path.join(tempDir, 'skills1'),
          mcpConfigFile: antigravityConfigFile,
        },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
      {
        id: 'claude',
        name: 'Claude Code',
        displayName: 'Claude Code',
        isInstalled: true,
        paths: {
          configDir: tempDir,
          skillsDir: path.join(tempDir, 'skills2'),
          mcpConfigFile: claudeConfigFile,
        },
        existingSkillsCount: 0,
        existingMcpServersCount: 2,
        isLinkedToHub: false,
      },
    ];

    const isolatedHubMcp = path.join(tempDir, 'isolated-master-hub.json');
    const { mergedServers, serverSources } = await collectMcpServers(mockAgents, {
      masterHubPath: isolatedHubMcp,
    });

    expect(Object.keys(mergedServers).sort()).toEqual(['github', 'memory']);
    expect(serverSources.github).toContain('Google Antigravity');
    expect(serverSources.github).toContain('Claude Code');
    expect(mergedServers.github.env).toEqual({
      GITHUB_TOKEN: 'token123',
      GITHUB_USER: 'octocat',
    });

    // Now test synchronization
    const summary = await syncMcpConfigs(mockAgents, {
      masterHubPath: isolatedHubMcp,
    });
    expect(summary.results.every((r) => r.success)).toBe(true);

    const updatedAntigravity = await safeReadJson<MCPConfigFile>(antigravityConfigFile);
    expect(updatedAntigravity?.unrelatedSetting).toBe('antigravity-custom');
    expect(Object.keys(updatedAntigravity?.mcpServers || {}).sort()).toEqual(['github', 'memory']);

    const updatedClaude = await safeReadJson<MCPConfigFile>(claudeConfigFile);
    expect(updatedClaude?.claudeTheme).toBe('dark');
    expect(Object.keys(updatedClaude?.mcpServers || {}).sort()).toEqual(['github', 'memory']);
  });

  it('never persists a resolved secret value to disk - writes back the ${VAR} placeholder', async () => {
    const REAL_TOKEN = 'sk-real-secret-1234567890abcdef1234567890';
    const envVarName = 'AGENTBRIDGE_TEST_SECRET';
    const originalEnvValue = process.env[envVarName];
    process.env[envVarName] = REAL_TOKEN;

    try {
      const claudeConfigFile = path.join(tempDir, 'claude-secret.json');
      // Simulates a source config where the env value has already been
      // resolved to the literal secret (e.g. typed directly by a user).
      await safeWriteJson(claudeConfigFile, {
        mcpServers: {
          secretServer: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-secret'],
            env: { [envVarName]: REAL_TOKEN },
          },
        },
      });

      const mockAgents: DetectedAgent[] = [
        {
          id: 'claude',
          name: 'Claude Code',
          displayName: 'Claude Code',
          isInstalled: true,
          paths: {
            configDir: tempDir,
            skillsDir: path.join(tempDir, 'skills-secret'),
            mcpConfigFile: claudeConfigFile,
          },
          existingSkillsCount: 0,
          existingMcpServersCount: 1,
          isLinkedToHub: false,
        },
      ];

      const isolatedHubMcp = path.join(tempDir, 'isolated-secret-hub.json');
      const exportPath = path.join(tempDir, 'exported-secret.json');

      await syncMcpConfigs(mockAgents, {
        masterHubPath: isolatedHubMcp,
        outputPath: exportPath,
      });

      // Every location the sync writes to must carry the placeholder, never
      // the raw resolved token.
      for (const filePath of [claudeConfigFile, isolatedHubMcp, exportPath]) {
        const raw = await fsp.readFile(filePath, 'utf-8');
        expect(raw).not.toContain(REAL_TOKEN);
        expect(raw).toContain(`\${${envVarName}}`);
      }

      const updatedClaude = await safeReadJson<MCPConfigFile>(claudeConfigFile);
      expect(updatedClaude?.mcpServers?.secretServer.env?.[envVarName]).toBe(
        `\${${envVarName}}`
      );
    } finally {
      if (originalEnvValue === undefined) {
        delete process.env[envVarName];
      } else {
        process.env[envVarName] = originalEnvValue;
      }
    }
  });

  it('rejects a "__proto__" MCP server name instead of reassigning the merged object\'s prototype', async () => {
    const claudeConfigFile = path.join(tempDir, 'claude-proto.json');
    // A crafted agent config file with a "__proto__"-named server entry -
    // JSON.parse() creates this as a normal own property, but assigning
    // it into a plain object via obj[name] = ... (not spread) invokes the
    // real Object.prototype.__proto__ setter.
    await fsp.writeFile(
      claudeConfigFile,
      JSON.stringify({
        mcpServers: {
          '__proto__': { command: 'evil', args: ['payload'] },
          legit: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        },
      }),
      'utf-8'
    );

    const mockAgents: DetectedAgent[] = [
      {
        id: 'claude',
        name: 'Claude Code',
        displayName: 'Claude Code',
        isInstalled: true,
        paths: {
          configDir: tempDir,
          skillsDir: path.join(tempDir, 'skills-proto'),
          mcpConfigFile: claudeConfigFile,
        },
        existingSkillsCount: 0,
        existingMcpServersCount: 2,
        isLinkedToHub: false,
      },
    ];

    const isolatedHubMcp = path.join(tempDir, 'isolated-proto-hub.json');
    const { mergedServers } = await collectMcpServers(mockAgents, {
      masterHubPath: isolatedHubMcp,
    });

    // The legit entry made it through; "__proto__" did not become an own
    // property (bracket-assigning it would have swapped the object's
    // prototype instead of adding a key named "__proto__").
    expect(Object.keys(mergedServers)).toEqual(['legit']);
    // And the object's actual prototype is untouched - still the normal
    // Object.prototype, not the attacker-supplied { command: 'evil', ... }.
    expect(Object.getPrototypeOf(mergedServers)).toBe(Object.prototype);
  });
});
