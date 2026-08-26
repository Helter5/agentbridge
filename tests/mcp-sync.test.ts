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
  let originalBackupsDirEnv: string | undefined;

  beforeEach(async () => {
    await ensureDir(tempDir);
    // syncMcpConfigs() goes through executeTransactionalOperation(), which
    // creates a real backup snapshot before every attempt - isolate it so
    // these tests don't leave stray files in ~/.agentbridge/backups.
    originalBackupsDirEnv = process.env.AGENTBRIDGE_BACKUPS_DIR;
    process.env.AGENTBRIDGE_BACKUPS_DIR = path.join(tempDir, 'backups');
  });

  afterEach(async () => {
    if (originalBackupsDirEnv === undefined) {
      delete process.env.AGENTBRIDGE_BACKUPS_DIR;
    } else {
      process.env.AGENTBRIDGE_BACKUPS_DIR = originalBackupsDirEnv;
    }
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

  it('collectMcpServers() reports an agent config with invalid JSON via invalidConfigs instead of silently dropping it', async () => {
    const claudeConfigFile = path.join(tempDir, 'claude-corrupt.json');
    // A hand-edited config with a trailing comma - real-world corruption
    // (truncated write, manual edit typo), not a crafted attack.
    await fsp.writeFile(
      claudeConfigFile,
      '{"mcpServers":{"demo":{"command":"npx","args":["-y","demo"]},}}',
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
          skillsDir: path.join(tempDir, 'skills-corrupt'),
          mcpConfigFile: claudeConfigFile,
        },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
    ];

    const isolatedHubMcp = path.join(tempDir, 'isolated-corrupt-hub.json');
    const { mergedServers, invalidConfigs } = await collectMcpServers(mockAgents, {
      masterHubPath: isolatedHubMcp,
    });

    expect(Object.keys(mergedServers)).toEqual([]);
    expect(invalidConfigs).toEqual([
      { agentId: 'claude', agentName: 'Claude Code', filePath: claudeConfigFile },
    ]);
  });

  it('syncMcpConfigs() flags configWasInvalid (not a plain success) when it resets a corrupt agent config, and backs up the original', async () => {
    const claudeConfigFile = path.join(tempDir, 'claude-corrupt-sync.json');
    const originalRaw = '{"mcpServers":{"demo":{"command":"npx","args":["-y","demo"]},}}';
    await fsp.writeFile(claudeConfigFile, originalRaw, 'utf-8');

    const antigravityConfigFile = path.join(tempDir, 'gemini-valid.json');
    await safeWriteJson(antigravityConfigFile, {
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
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
          skillsDir: path.join(tempDir, 'skills-corrupt-sync'),
          mcpConfigFile: claudeConfigFile,
        },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
      {
        id: 'antigravity',
        name: 'Google Antigravity',
        displayName: 'Google Antigravity',
        isInstalled: true,
        paths: {
          configDir: tempDir,
          skillsDir: path.join(tempDir, 'skills-corrupt-sync-2'),
          mcpConfigFile: antigravityConfigFile,
        },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
    ];

    const isolatedHubMcp = path.join(tempDir, 'isolated-corrupt-sync-hub.json');
    const summary = await syncMcpConfigs(mockAgents, {
      masterHubPath: isolatedHubMcp,
      backupExisting: true,
    });

    const claudeResult = summary.results.find((r) => r.agentId === 'claude');
    expect(claudeResult?.success).toBe(true);
    expect(claudeResult?.configWasInvalid).toBe(true);

    const antigravityResult = summary.results.find((r) => r.agentId === 'antigravity');
    expect(antigravityResult?.configWasInvalid).toBeFalsy();

    // File was reset and rewritten with valid JSON (the merged servers from
    // the OTHER agent - its own "demo" server is gone, since it could never
    // be parsed out of the corrupt original).
    const rewritten = await safeReadJson<MCPConfigFile>(claudeConfigFile);
    expect(Object.keys(rewritten?.mcpServers || {})).toEqual(['github']);

    // The original corrupt content was preserved as a sibling backup file
    // (backupPath renames-aside before rewriting), not just discarded.
    const siblingFiles = await fsp.readdir(tempDir);
    const backupFile = siblingFiles.find((f) => f.startsWith('claude-corrupt-sync.json.backup-'));
    expect(backupFile).toBeDefined();
    const backupContent = await fsp.readFile(path.join(tempDir, backupFile!), 'utf-8');
    expect(backupContent).toBe(originalRaw);
  });

  it('collectMcpServers() reports a collision when two agents independently configure the same server name with genuinely different command/args/env', async () => {
    // Unlike skills (detectSkillCollisions), this used to be entirely
    // silent - mergeServerConfig() would just let the later-processed
    // agent's value win on conflicting fields with no signal to the user
    // at all.
    const claudeConfigFile = path.join(tempDir, 'claude-conflict.json');
    const codexConfigFile = path.join(tempDir, 'codex-conflict.json');

    await safeWriteJson(claudeConfigFile, {
      mcpServers: {
        postgres: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://prod-db/app'],
          env: { DB_PASSWORD: 'claude-side-password' },
        },
      },
    });

    await safeWriteJson(codexConfigFile, {
      mcpServers: {
        postgres: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://staging-db/app'],
          env: { DB_PASSWORD: 'codex-side-password' },
        },
      },
    });

    const mockAgents: DetectedAgent[] = [
      {
        id: 'claude',
        name: 'Claude Code',
        displayName: 'Claude Code',
        isInstalled: true,
        paths: { configDir: tempDir, skillsDir: path.join(tempDir, 'skills-c1'), mcpConfigFile: claudeConfigFile },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
      {
        id: 'codex',
        name: 'OpenAI Codex',
        displayName: 'OpenAI Codex',
        isInstalled: true,
        paths: { configDir: tempDir, skillsDir: path.join(tempDir, 'skills-c2'), mcpConfigFile: codexConfigFile },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
    ];

    const isolatedHubMcp = path.join(tempDir, 'isolated-conflict-hub.json');
    const { collisions } = await collectMcpServers(mockAgents, { masterHubPath: isolatedHubMcp });

    expect(collisions.length).toBe(1);
    expect(collisions[0].serverName).toBe('postgres');
    expect(collisions[0].conflictingFields.sort()).toEqual(['args', 'env.DB_PASSWORD']);
    expect(collisions[0].sources).toEqual(['Claude Code', 'OpenAI Codex']);
  });

  it('collectMcpServers() does not report a collision when agents only contribute complementary (non-overlapping) fields for the same server', async () => {
    // Same server name, same command/args, and their env keys don't
    // overlap at all - this is a normal union merge (both survive), not a
    // conflict. Distinct from the test above, which has both an args
    // difference and a genuinely conflicting (same-key) env value.
    const claudeConfigFile = path.join(tempDir, 'claude-nocollide.json');
    const codexConfigFile = path.join(tempDir, 'codex-nocollide.json');

    await safeWriteJson(claudeConfigFile, {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'shared-token' },
        },
      },
    });

    await safeWriteJson(codexConfigFile, {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'shared-token', EXTRA_OPTION: 'codex-only' },
        },
      },
    });

    const mockAgents: DetectedAgent[] = [
      {
        id: 'claude',
        name: 'Claude Code',
        displayName: 'Claude Code',
        isInstalled: true,
        paths: { configDir: tempDir, skillsDir: path.join(tempDir, 'skills-n1'), mcpConfigFile: claudeConfigFile },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
      {
        id: 'codex',
        name: 'OpenAI Codex',
        displayName: 'OpenAI Codex',
        isInstalled: true,
        paths: { configDir: tempDir, skillsDir: path.join(tempDir, 'skills-n2'), mcpConfigFile: codexConfigFile },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
    ];

    const isolatedHubMcp = path.join(tempDir, 'isolated-nocollide-hub.json');
    const { collisions, mergedServers } = await collectMcpServers(mockAgents, {
      masterHubPath: isolatedHubMcp,
    });

    expect(collisions).toEqual([]);
    // Both env keys survived the merge.
    expect(mergedServers.github.env).toEqual({
      GITHUB_TOKEN: 'shared-token',
      EXTRA_OPTION: 'codex-only',
    });
  });

  it('does not flag a false collision between a ${VAR} placeholder and the literal value it resolves to (same secret, not a disagreement)', async () => {
    // Found via real-machine testing: the hub registry (or an agent config
    // already redacted by a previous sync-mcp) can hold `${VAR}` while
    // another agent's config still holds the literal value - same secret,
    // written at different points in time, not a genuine conflict. Three
    // cases in one test: unresolved (env var unset) must not be flagged
    // (can't prove a real difference), resolved-and-matching must not be
    // flagged, resolved-and-different must still be flagged.
    const envVarName = 'AGENTBRIDGE_TEST_TOKEN_EQUIVALENCE';
    const originalEnvValue = process.env[envVarName];

    const claudeConfigFile = path.join(tempDir, 'claude-placeholder.json');
    const codexConfigFile = path.join(tempDir, 'codex-literal.json');

    await safeWriteJson(claudeConfigFile, {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { [envVarName]: `\${${envVarName}}` },
        },
      },
    });
    await safeWriteJson(codexConfigFile, {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { [envVarName]: 'ghp_someRealLookingToken1234567890' },
        },
      },
    });

    const mockAgents: DetectedAgent[] = [
      {
        id: 'claude',
        name: 'Claude Code',
        displayName: 'Claude Code',
        isInstalled: true,
        paths: { configDir: tempDir, skillsDir: path.join(tempDir, 'skills-eq1'), mcpConfigFile: claudeConfigFile },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
      {
        id: 'codex',
        name: 'OpenAI Codex',
        displayName: 'OpenAI Codex',
        isInstalled: true,
        paths: { configDir: tempDir, skillsDir: path.join(tempDir, 'skills-eq2'), mcpConfigFile: codexConfigFile },
        existingSkillsCount: 0,
        existingMcpServersCount: 1,
        isLinkedToHub: false,
      },
    ];

    try {
      // Case 1: env var not set - can't verify, must not flag a collision.
      delete process.env[envVarName];
      const hub1 = path.join(tempDir, 'eq-hub-1.json');
      const { collisions: c1 } = await collectMcpServers(mockAgents, { masterHubPath: hub1 });
      expect(c1).toEqual([]);

      // Case 2: env var set to match the literal - genuinely the same
      // secret, must not flag a collision.
      process.env[envVarName] = 'ghp_someRealLookingToken1234567890';
      const hub2 = path.join(tempDir, 'eq-hub-2.json');
      const { collisions: c2 } = await collectMcpServers(mockAgents, { masterHubPath: hub2 });
      expect(c2).toEqual([]);

      // Case 3: env var set to something else entirely - now both sides
      // resolve to different, known values, so this is a real conflict.
      process.env[envVarName] = 'ghp_completelyDifferentToken000000';
      const hub3 = path.join(tempDir, 'eq-hub-3.json');
      const { collisions: c3 } = await collectMcpServers(mockAgents, { masterHubPath: hub3 });
      expect(c3.length).toBe(1);
      expect(c3[0].conflictingFields).toEqual([`env.${envVarName}`]);
    } finally {
      if (originalEnvValue === undefined) {
        delete process.env[envVarName];
      } else {
        process.env[envVarName] = originalEnvValue;
      }
    }
  });
});
