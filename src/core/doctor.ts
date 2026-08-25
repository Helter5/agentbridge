import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  expandHome,
  pathExists,
  isSymlinkOrJunction,
  readLinkTarget,
  ensureDir,
  createCrossPlatformLink,
  safeReadJson,
} from '../utils/fs.js';
import {
  validateMCPConfigFile,
  validateSkillFrontmatter,
  parseFrontmatter,
  detectPotentialSecrets,
} from '../utils/schema.js';
import { detectInstalledAgents, DEFAULT_HUB_SKILLS_PATH } from './detector.js';
import { listSkillsInDirectory, getHubSkillsPath } from './skill-linker.js';
import type { HealthCheckItem, DoctorReport, DiagnosticSeverity } from '../types/doctor.js';
import type { MCPConfigFile } from '../types/mcp.js';

export interface DoctorOptions {
  hubPath?: string;
  projectRoot?: string;
}

/**
 * Runs end-to-end health diagnostics for the agent ecosystem
 */
export async function runDiagnostics(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: HealthCheckItem[] = [];
  const hubPath = getHubSkillsPath(options.hubPath);

  // 1. Environment & Node Check
  const nodeVersion = process.version;
  const majorNode = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
  if (majorNode >= 18) {
    checks.push({
      id: 'env-node',
      category: 'paths',
      title: 'Node.js Runtime Version',
      description: `Running Node.js ${nodeVersion} (>= 18.0.0 required)`,
      status: 'success',
      fixable: false,
    });
  } else {
    checks.push({
      id: 'env-node',
      category: 'paths',
      title: 'Node.js Runtime Version',
      description: `Current version ${nodeVersion} is below required Node.js 18+`,
      status: 'error',
      fixable: false,
    });
  }

  // 2. Central Hub Permissions & Existence
  try {
    await ensureDir(hubPath);
    const testFile = path.join(hubPath, '.test-write');
    await fsp.writeFile(testFile, 'ok', 'utf-8');
    await fsp.unlink(testFile);

    checks.push({
      id: 'hub-write-access',
      category: 'permissions',
      title: 'Central Hub Permissions',
      description: `Hub directory is writable: ${hubPath}`,
      status: 'success',
      fixable: false,
    });
  } catch (err: any) {
    checks.push({
      id: 'hub-write-access',
      category: 'permissions',
      title: 'Central Hub Permissions',
      description: `Cannot write to hub directory: ${hubPath} (${err.message})`,
      status: 'error',
      fixable: false,
    });
  }

  // 3. Symlink / Junction Capability Check
  try {
    const tmpDir = path.join(os.tmpdir(), `agentsync-check-${Date.now()}`);
    const tmpTarget = path.join(tmpDir, 'target');
    const tmpLink = path.join(tmpDir, 'link');

    await ensureDir(tmpTarget);
    const linkRes = await createCrossPlatformLink(tmpTarget, tmpLink, 'dir');
    if (linkRes.success) {
      checks.push({
        id: 'symlink-capability',
        category: 'symlinks',
        title: 'Cross-Platform Linking Support',
        description: `Symlink / Directory Junction capability verified on ${process.platform}`,
        status: 'success',
        fixable: false,
      });
    } else {
      checks.push({
        id: 'symlink-capability',
        category: 'symlinks',
        title: 'Cross-Platform Linking Support',
        description: `Linking failed: ${linkRes.error}`,
        status: 'warning',
        fixable: false,
      });
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch (err: any) {
    checks.push({
      id: 'symlink-capability',
      category: 'symlinks',
      title: 'Cross-Platform Linking Support',
      description: `Failed to test linking capability: ${err.message}`,
      status: 'warning',
      fixable: false,
    });
  }

  // 4. Detected Agents & Symlink Integrity
  const agents = await detectInstalledAgents({ customHubPath: hubPath, checkAll: true });
  const installedAgents = agents.filter((a) => a.isInstalled);

  if (installedAgents.length === 0) {
    checks.push({
      id: 'agents-detected',
      category: 'paths',
      title: 'AI Agent Installations',
      description: 'No AI agent configurations detected in default paths',
      status: 'warning',
      fixable: false,
    });
  } else {
    checks.push({
      id: 'agents-detected',
      category: 'paths',
      title: 'AI Agent Installations',
      description: `Detected ${installedAgents.length} active agent(s): ${installedAgents.map((a) => a.name).join(', ')}`,
      status: 'success',
      fixable: false,
    });
  }

  // Inspect each agent's skills directory link integrity
  for (const agent of installedAgents) {
    const skillsDir = expandHome(agent.paths.skillsDir);
    const exists = await pathExists(skillsDir);
    const isLink = await isSymlinkOrJunction(skillsDir);

    if (isLink) {
      const target = await readLinkTarget(skillsDir);
      if (target && (path.resolve(target) === path.resolve(hubPath) || target === hubPath)) {
        checks.push({
          id: `agent-link-${agent.id}`,
          category: 'symlinks',
          title: `${agent.displayName} Skills Link`,
          description: `Properly linked to hub: ${skillsDir} → ${hubPath}`,
          status: 'success',
          fixable: false,
        });
      } else {
        checks.push({
          id: `agent-link-${agent.id}`,
          category: 'symlinks',
          title: `${agent.displayName} Broken Link`,
          description: `Points to invalid target (${target || 'unknown'}) instead of hub`,
          status: 'warning',
          fixable: true,
          fixAction: async () => {
            const res = await createCrossPlatformLink(hubPath, skillsDir, 'dir');
            return res.success;
          },
        });
      }
    } else if (exists) {
      checks.push({
        id: `agent-link-${agent.id}`,
        category: 'symlinks',
        title: `${agent.displayName} Skills Folder`,
        description: `Skills directory is not linked to hub: ${skillsDir}`,
        status: 'info',
        fixable: true,
        fixAction: async () => {
          const res = await createCrossPlatformLink(hubPath, skillsDir, 'dir');
          return res.success;
        },
      });
    }
  }

  // 5. Hub Skills Validation
  const hubSkills = await listSkillsInDirectory(hubPath);
  let invalidSkillsCount = 0;
  const invalidDetails: string[] = [];

  for (const skill of hubSkills) {
    if (!skill.isValid) {
      invalidSkillsCount++;
      invalidDetails.push(`${skill.dirName}: ${skill.validationErrors?.join(', ')}`);
    }
  }

  if (hubSkills.length === 0) {
    checks.push({
      id: 'hub-skills-count',
      category: 'skills',
      title: 'Skills in Central Hub',
      description: `Hub is currently empty (${hubPath}). Use 'agentsync add-skill <name>' to create one.`,
      status: 'info',
      fixable: false,
    });
  } else if (invalidSkillsCount > 0) {
    checks.push({
      id: 'hub-skills-validation',
      category: 'skills',
      title: 'Skill Frontmatter Validation',
      description: `${invalidSkillsCount} skill(s) have invalid SKILL.md schemas`,
      status: 'warning',
      fixable: false,
      details: invalidDetails,
    });
  } else {
    checks.push({
      id: 'hub-skills-validation',
      category: 'skills',
      title: 'Skill Frontmatter Validation',
      description: `All ${hubSkills.length} skill(s) passed schema validation`,
      status: 'success',
      fixable: false,
    });
  }

  // 6. MCP Configuration Files Check & Secret Audit
  for (const agent of installedAgents) {
    if (!agent.paths.mcpConfigFile) continue;
    const mcpFile = expandHome(agent.paths.mcpConfigFile);
    if (await pathExists(mcpFile)) {
      try {
        const content = await fsp.readFile(mcpFile, 'utf-8');
        const json = JSON.parse(content);
        const validation = validateMCPConfigFile(json);
        if (validation.isValid) {
          const serverCount = Object.keys(json.mcpServers || {}).length;
          
          // Secret scan inside MCP servers
          const exposedSecrets: string[] = [];
          for (const [serverName, srv] of Object.entries(json.mcpServers || {})) {
            const rawStr = JSON.stringify(srv);
            const secretCheck = detectPotentialSecrets(rawStr);
            if (secretCheck.hasSecret) {
              exposedSecrets.push(`${serverName}: ${secretCheck.reason}`);
            }
          }

          if (exposedSecrets.length > 0) {
            checks.push({
              id: `mcp-secret-${agent.id}`,
              category: 'mcp',
              title: `${agent.displayName} Plaintext Secrets Warning`,
              description: `Detected plain-text credentials in ${path.basename(mcpFile)}. Consider using environment variable references (\${VAR}).`,
              status: 'warning',
              fixable: false,
              details: exposedSecrets,
            });
          }

          checks.push({
            id: `mcp-config-${agent.id}`,
            category: 'mcp',
            title: `${agent.displayName} MCP Config`,
            description: `Valid JSON schema with ${serverCount} configured server(s)`,
            status: 'success',
            fixable: false,
          });
        } else {
          checks.push({
            id: `mcp-config-${agent.id}`,
            category: 'mcp',
            title: `${agent.displayName} MCP Config`,
            description: `Schema errors in ${mcpFile}: ${validation.errors.join(', ')}`,
            status: 'warning',
            fixable: false,
          });
        }
      } catch (err: any) {
        checks.push({
          id: `mcp-config-${agent.id}`,
          category: 'mcp',
          title: `${agent.displayName} MCP Config Syntax`,
          description: `Invalid JSON syntax in ${mcpFile}: ${err.message}`,
          status: 'error',
          fixable: false,
        });
      }
    }
  }

  // 7. Skill Collision Detection
  const { detectSkillCollisions } = await import('./skill-linker.js');
  const collisions = await detectSkillCollisions(installedAgents);
  if (collisions.length > 0) {
    checks.push({
      id: 'skill-collisions',
      category: 'skills',
      title: 'Skill Name Collisions',
      description: `Detected ${collisions.length} skill(s) with identical names across agents`,
      status: 'warning',
      fixable: false,
      details: collisions.map(
        (c) => `${c.skillName}: present in ${c.sources.map((s) => s.agentName).join(' & ')}`
      ),
    });
  } else {
    checks.push({
      id: 'skill-collisions',
      category: 'skills',
      title: 'Skill Conflict Check',
      description: 'Zero naming collisions detected across active agents',
      status: 'success',
      fixable: false,
    });
  }

  // Summary counts
  const total = checks.length;
  const passed = checks.filter((c) => c.status === 'success').length;
  const warnings = checks.filter((c) => c.status === 'warning').length;
  const errors = checks.filter((c) => c.status === 'error').length;
  const fixableCount = checks.filter((c) => c.fixable).length;

  return {
    timestamp: new Date().toISOString(),
    osInfo: {
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      nodeVersion: process.version,
    },
    checks,
    summary: {
      total,
      passed,
      warnings,
      errors,
      fixableCount,
    },
  };
}

/**
 * Automatically fixes fixable diagnostic issues
 */
export async function fixDiagnostics(report: DoctorReport): Promise<{
  fixedCount: number;
  failedCount: number;
}> {
  let fixedCount = 0;
  let failedCount = 0;

  for (const check of report.checks) {
    if (check.fixable && check.fixAction) {
      try {
        const ok = await check.fixAction();
        if (ok) fixedCount++;
        else failedCount++;
      } catch {
        failedCount++;
      }
    }
  }

  return { fixedCount, failedCount };
}
