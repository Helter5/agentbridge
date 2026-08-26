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
  removeLinkOrDir,
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
    const tmpDir = path.join(os.tmpdir(), `agentbridge-check-${Date.now()}`);
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
    } else {
      // Neither a link nor an existing regular folder - the agent is
      // installed (something else about it, e.g. its config file, matched)
      // but its skills directory was never created at all. Found via
      // real-machine testing: this case fell through both branches above
      // silently, so the report said nothing whatsoever about this agent's
      // skills folder - inconsistent with "Skills in Central Hub" below,
      // which does have an explicit message for its own empty case.
      // createCrossPlatformLink() can create a junction/symlink at a path
      // where nothing exists yet (it only removes an existing item first
      // if there is one), so this is fixable the same way as the other
      // case.
      checks.push({
        id: `agent-link-${agent.id}`,
        category: 'symlinks',
        title: `${agent.displayName} Skills Folder`,
        description: `Skills directory does not exist yet: ${skillsDir}`,
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
      description: `Hub is currently empty (${hubPath}). Use 'agentbridge add-skill <name>' to create one.`,
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

  // 5b. Reserved/system folders that leaked into the hub before
  // mergeSkillsIntoHub() excluded them (e.g. OpenAI Codex's own `.system`
  // bundle, imported wholesale by an older agentbridge version and then
  // cross-linked into every other agent via the shared hub). Safe to
  // remove from the hub specifically - mergeSkillsIntoHub() only ever
  // copies from an agent's own folder into the hub, never deletes the
  // source, so the agent's real copy (e.g. ~/.codex/skills/.system) is
  // untouched either way.
  const reservedHubEntries = hubSkills.filter(
    (s) => s.dirName.startsWith('.') || s.dirName === 'node_modules'
  );
  if (reservedHubEntries.length > 0) {
    checks.push({
      id: 'hub-reserved-folders',
      category: 'skills',
      title: 'Reserved Folder Leaked Into Hub',
      description: `${reservedHubEntries.length} reserved/system folder(s) (e.g. an agent's own internal skills bundle) were imported into the hub and are now shared with every linked agent`,
      status: 'warning',
      fixable: true,
      details: reservedHubEntries.map((s) => s.path),
      fixAction: async () => {
        try {
          for (const entry of reservedHubEntries) {
            await removeLinkOrDir(entry.path);
          }
          return true;
        } catch {
          return false;
        }
      },
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
          
          // Secret scan inside MCP servers - checked per-field (rather than
          // one JSON.stringify of the whole server object) so the scanner
          // knows which field name each value came from. That lets it tell
          // a git commit SHA apart from a bare 40-hex secret look-alike
          // (see detectPotentialSecrets' fieldName option).
          const exposedSecrets: string[] = [];
          const checkField = (label: string, fieldName: string, fieldValue: unknown) => {
            if (typeof fieldValue !== 'string') return;
            const secretCheck = detectPotentialSecrets(fieldValue, { fieldName });
            if (secretCheck.hasSecret) {
              exposedSecrets.push(`${label}: ${secretCheck.reason}`);
            }
          };
          for (const [serverName, srv] of Object.entries(json.mcpServers || {})) {
            if (!srv || typeof srv !== 'object') continue;
            for (const [fieldName, fieldValue] of Object.entries(srv as Record<string, unknown>)) {
              if (Array.isArray(fieldValue)) {
                fieldValue.forEach((v) => checkField(`${serverName}.${fieldName}`, fieldName, v));
              } else if (fieldValue && typeof fieldValue === 'object') {
                // e.g. env: { GITHUB_TOKEN: "..." } - use the inner key
                // (the actual env var name) as the field-name context.
                for (const [subKey, subVal] of Object.entries(fieldValue as Record<string, unknown>)) {
                  checkField(`${serverName}.${fieldName}.${subKey}`, subKey, subVal);
                }
              } else {
                checkField(`${serverName}.${fieldName}`, fieldName, fieldValue);
              }
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
              details: [
                ...exposedSecrets,
                // Report-only, deliberately no --fix here (see README's
                // "Secret Redaction" section) - setting an OS-level env var
                // is a real side effect on the user's machine that this
                // tool shouldn't perform unprompted, and the right variable
                // name/value is something only the user knows for certain.
                'How to fix: set the matching name as a real OS environment variable (e.g. Windows: [System.Environment]::SetEnvironmentVariable(\'VAR_NAME\', \'value\', \'User\') · macOS/Linux: add `export VAR_NAME=value` to your shell profile), then run `agentbridge sync-mcp` again - it rewrites any config value matching that variable back to `${VAR_NAME}` automatically. See README > Secret Redaction.',
              ],
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
