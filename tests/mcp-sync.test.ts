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
  const tempDir = path.join(os.tmpdir(), `agentsync-mcp-test-${Date.now()}`);

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
});
