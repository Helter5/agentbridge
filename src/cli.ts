import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { printBanner, renderTable, icons, badge, formatStatusLine } from './utils/ui.js';
import { detectInstalledAgents } from './core/detector.js';
import {
  linkAgentsToHub,
  listSkillsInDirectory,
  getHubSkillsPath,
  createNewSkill,
} from './core/skill-linker.js';
import { syncMcpConfigs, collectMcpServers } from './core/mcp-sync.js';
import { syncProjectRules, inspectProjectRules } from './core/rules.js';
import { runDiagnostics, fixDiagnostics } from './core/doctor.js';
import { contractHome, pathExists } from './utils/fs.js';

// Read the version from package.json at runtime rather than hardcoding a
// literal here - a hardcoded string silently drifts out of sync with the
// actual published version on every bump (it did: this file said 0.1.0
// while package.json had already moved to 0.2.0). Resolved relative to
// this file's own location so it works both from src/ (dev) and from the
// bundled dist/cli.js (one directory up from the package root either way).
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version: packageVersion } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

const program = new Command();

program
  .name('agentbridge')
  .description('Universal Skill & MCP Sync Engine for AI Coding Agents')
  .version(packageVersion);

/**
 * agentbridge status
 */
program
  .command('status')
  .description('Display detected agents, active skills, and configured MCP servers')
  .option('--json', 'Output results as raw JSON')
  .option('--hub <path>', 'Custom skills hub directory')
  .action(async (options) => {
    const hubPath = getHubSkillsPath(options.hub);
    const agents = await detectInstalledAgents({ customHubPath: hubPath, checkAll: true });
    const hubSkills = await listSkillsInDirectory(hubPath);
    // Only a directory that actually contains a valid SKILL.md counts as a
    // real skill (matches the per-agent "Local Skills" count) - a broken
    // partial copy or empty folder still shows up in `skills` below (each
    // entry carries its own `valid` flag) but shouldn't inflate the total.
    const validHubSkillsCount = hubSkills.filter((s) => s.isValid).length;
    const { mergedServers } = await collectMcpServers(agents);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            hubPath,
            hubSkillsCount: validHubSkillsCount,
            skills: hubSkills.map((s) => ({
              name: s.name,
              dir: s.dirName,
              valid: s.isValid,
            })),
            mcpServersCount: Object.keys(mergedServers).length,
            mcpServers: Object.keys(mergedServers),
            agents: agents.map((a) => ({
              id: a.id,
              name: a.name,
              isInstalled: a.isInstalled,
              skillsCount: a.existingSkillsCount,
              mcpCount: a.existingMcpServersCount,
              linkStatus: a.linkStatus,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    printBanner();

    console.log(pc.bold('System Overview'));
    console.log(formatStatusLine('Skills Hub', contractHome(hubPath), 'ok'));
    console.log(
      formatStatusLine('Total Hub Skills', `${validHubSkillsCount} active`, 'ok')
    );
    console.log(
      formatStatusLine(
        'Unified MCP Servers',
        `${Object.keys(mergedServers).length} configured`,
        'ok'
      )
    );
    console.log('');

    console.log(pc.bold('Detected AI Coding Agents\n'));

    const tableRows = agents.map((agent) => {
      let statusBadge = pc.dim('Not Found');
      if (agent.isInstalled) {
        statusBadge = pc.green('Installed');
      }

      let linkBadge = pc.dim('—');
      if (agent.linkStatus === 'linked') {
        linkBadge = pc.green('✔ Linked to Hub');
      } else if (agent.linkStatus === 'direct_dir') {
        linkBadge = pc.yellow('⚠ Direct Folder');
      } else if (agent.linkStatus === 'broken_link') {
        linkBadge = pc.red('✖ Broken Link');
      } else if (agent.isInstalled) {
        linkBadge = pc.dim('Not Linked');
      }

      return {
        agent: agent.displayName,
        status: statusBadge,
        skills: agent.existingSkillsCount ? `${agent.existingSkillsCount} skills` : pc.dim('0'),
        mcp: agent.existingMcpServersCount ? `${agent.existingMcpServersCount} servers` : pc.dim('0'),
        link: linkBadge,
      };
    });

    console.log(
      renderTable(
        [
          { key: 'agent', header: 'Agent', width: 24 },
          { key: 'status', header: 'Status', width: 14 },
          { key: 'skills', header: 'Local Skills', width: 14 },
          { key: 'mcp', header: 'MCP Servers', width: 14 },
          { key: 'link', header: 'Hub Synchronization', width: 22 },
        ],
        tableRows
      )
    );

  });

/**
 * agentbridge pick / import
 */
program
  .command('pick')
  .alias('import')
  .description('Interactively pick and selectively import skills & MCP servers from any agent')
  .option('--target <dir>', 'Target skills directory (defaults to central hub or ~/.gemini/config/skills)')
  .option('--hub <path>', 'Custom skills hub directory')
  .action(async (options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(' agentbridge pick & import ')));

    const hubPath = getHubSkillsPath(options.hub);
    const agents = await detectInstalledAgents({ customHubPath: hubPath, checkAll: true });
    
    // 1. Discover all skills across all agents
    const allDiscoveredSkills = await import('./core/skill-linker.js').then((m) =>
      m.discoverAllAvailableSkills(agents)
    );

    if (allDiscoveredSkills.length === 0) {
      p.log.warn('No custom skills or commands discovered across any installed agents.');
      p.outro(pc.dim('Done.'));
      return;
    }

    p.log.info(
      `Discovered ${pc.green(String(allDiscoveredSkills.length))} skill(s) across installed agents:`
    );

    const skillChoices = allDiscoveredSkills.map((s) => ({
      value: s.id,
      label: `${s.name} (${pc.cyan(s.agentName)})`,
      hint: s.description ? s.description.slice(0, 60) : undefined,
    }));

    const selectedSkillIds = await p.multiselect({
      message: 'Select which skills you want to import:',
      options: skillChoices,
      required: false,
    });

    if (p.isCancel(selectedSkillIds)) {
      p.cancel('Cancelled.');
      return;
    }

    const selectedSkills = allDiscoveredSkills.filter((s) =>
      (selectedSkillIds as string[]).includes(s.id)
    );

    let anyFailure = false;

    if (selectedSkills.length > 0) {
      const targetDir = options.target || hubPath;
      const s = p.spinner();
      s.start(`Importing ${selectedSkills.length} selected skill(s)...`);

      const { selectivelyImportSkills } = await import('./core/skill-linker.js');
      const importResult = await selectivelyImportSkills(selectedSkills, targetDir);
      s.stop('Skills imported!');

      for (const imported of importResult.importedSkills) {
        p.log.success(`Imported: ${pc.bold(imported)} ${icons.arrow} ${contractHome(targetDir)}`);
      }
      for (const warning of importResult.warnings) {
        p.log.warn(`${pc.bold(warning.name)}: ${warning.message}`);
      }
      for (const failed of importResult.failedSkills) {
        anyFailure = true;
        p.log.error(`Failed ${failed.name}: ${failed.error}`);
      }
    } else {
      p.log.info('No skills selected for import.');
    }

    // 2. Discover MCP servers
    const { collectMcpServers } = await import('./core/mcp-sync.js');
    const { mergedServers, serverSources } = await collectMcpServers(agents);
    const mcpNames = Object.keys(mergedServers);

    if (mcpNames.length > 0) {
      const mcpChoices = mcpNames.map((name) => ({
        value: name,
        label: `${name} ${pc.dim(`(from: ${serverSources[name]?.join(', ') || 'unknown'})`)}`,
      }));

      const selectedMcp = await p.multiselect({
        message: 'Select MCP servers to synchronize across all agent configs:',
        options: mcpChoices,
        required: false,
      });

      if (!p.isCancel(selectedMcp) && (selectedMcp as string[]).length > 0) {
        const s = p.spinner();
        s.start('Synchronizing selected MCP servers...');
        const { syncMcpConfigs } = await import('./core/mcp-sync.js');
        try {
          const mcpSummary = await syncMcpConfigs(agents, { backupExisting: true });
          s.stop('MCP servers synchronized!');
          p.log.success(`Mirrored ${(selectedMcp as string[]).length} MCP server(s) to all agent configs.`);
          for (const res of mcpSummary.results) {
            if (res.configWasInvalid) {
              p.log.warn(
                `${pc.bold(res.agentId)}: Its config had invalid JSON and was reset (original backed up - ` +
                  `restore with ${pc.bold('agentbridge rollback')} if needed)`
              );
            }
          }
        } catch (err: any) {
          anyFailure = true;
          s.stop('MCP synchronization failed.');
          p.log.error(err.message || String(err));
        }
      }
    }

    if (anyFailure) {
      process.exitCode = 1;
      p.outro(pc.red('✖ Selective import finished with errors - see above.'));
    } else {
      p.outro(pc.green('✔ Selective import finished successfully!'));
    }
  });

/**
 * agentbridge link-skills
 */
program
  .command('link-skills')
  .description('Merge and symlink/junction skills directories to central hub')
  .option('--hub <path>', 'Custom skills hub directory')
  .option('-y, --yes', 'Automatically confirm all prompts')
  .option('--dry-run', 'Simulate actions without writing to disk')
  .option('--no-backup', 'Do not backup direct skill folders before linking')
  .action(async (options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(' agentbridge link-skills ')));

    const hubPath = getHubSkillsPath(options.hub);
    const agents = await detectInstalledAgents({ customHubPath: hubPath, checkAll: false });
    const installed = agents.filter((a) => a.isInstalled);

    if (installed.length === 0) {
      p.log.warn('No active AI coding agents detected.');
      p.outro(pc.dim('Done.'));
      return;
    }

    p.log.info(
      `Central Skills Hub: ${pc.cyan(contractHome(hubPath))}`
    );
    p.log.info(
      `Found ${pc.green(String(installed.length))} installed agent(s): ${installed.map((a) => pc.bold(a.name)).join(', ')}`
    );

    if (!options.yes) {
      const confirm = await p.confirm({
        message: `Merge existing skills and link all ${installed.length} agent(s) to central hub?`,
        initialValue: true,
      });

      if (p.isCancel(confirm) || !confirm) {
        p.cancel('Operation cancelled.');
        return;
      }
    }

    const s = p.spinner();
    s.start('Synchronizing skills and creating cross-platform links...');

    let summary;
    try {
      summary = await linkAgentsToHub(installed, hubPath, {
        dryRun: options.dryRun,
        backupExisting: options.backup !== false,
      });
    } catch (err: any) {
      s.stop('Skills synchronization failed.');
      p.log.error(err.message || String(err));
      // mergeSkillsIntoHub() attaches this when it threw partway through a
      // multi-agent loop - without it, a failure on e.g. the 2nd of 4
      // agents looked identical to a total failure, with no indication
      // that an earlier agent's skills may have already been merged into
      // the hub (a real, partial disk mutation) while later agents were
      // never even reached.
      const partial = err.agentbridgePartialMergeContext;
      if (partial) {
        if (partial.succeededAgentNames.length > 0) {
          p.log.warn(
            `Already processed before the failure: ${partial.succeededAgentNames.join(', ')} (their skills may already be merged into the hub).`
          );
        }
        p.log.warn(
          `Failed on: ${pc.bold(partial.failedAgentName)}. Remaining agents were never reached.`
        );
        p.log.info(`Run ${pc.cyan('agentbridge doctor')} to check the current state before retrying.`);
      }
      p.outro(pc.red('✖ Skills synchronization failed - see above.'));
      process.exitCode = 1;
      return;
    }

    s.stop('Skills synchronization complete!');

    if (summary.importedSkills.length > 0) {
      p.log.success(
        `Imported ${summary.importedSkills.length} existing skill(s) into hub: ${summary.importedSkills.join(', ')}`
      );
    }

    for (const collision of summary.collisions) {
      p.log.warn(
        `${pc.bold(collision.skillName)}: ${collision.discardedFrom}'s version differs from ${collision.keptFrom}'s and was NOT merged in - only ${collision.keptFrom}'s content is in the hub. Resolve manually if both versions matter.`
      );
    }

    for (const link of summary.linkedAgents) {
      if (link.success) {
        p.log.success(
          `${pc.bold(link.agentName)}: ${link.actionTaken === 'already_linked' ? 'Already linked' : 'Successfully linked'} ${icons.arrow} ${contractHome(link.linkPath)}`
        );
      } else {
        p.log.error(
          `${pc.bold(link.agentName)}: Failed to link (${link.error})`
        );
      }
    }

    p.outro(
      pc.green(
        `✔ All skills unified in ${contractHome(hubPath)} (${summary.totalSkillsInHub} total skills)`
      )
    );
  });

/**
 * agentbridge sync-mcp
 */
program
  .command('sync-mcp')
  .description('Safely import, merge, and mirror MCP servers across all client configs')
  .option('-o, --output <file>', 'Export merged MCP servers to a standalone JSON file')
  .option('-y, --yes', 'Automatically confirm all prompts')
  .option('--dry-run', 'Simulate actions without writing to disk')
  .action(async (options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(' agentbridge sync-mcp ')));

    const agents = await detectInstalledAgents({ checkAll: false });
    const { mergedServers, serverSources, invalidConfigs } = await collectMcpServers(agents);
    const serverNames = Object.keys(mergedServers);

    for (const bad of invalidConfigs) {
      p.log.warn(
        `${pc.bold(bad.agentName)}: config at ${contractHome(bad.filePath)} has invalid JSON - ` +
          `its existing servers are excluded from this merge, and its file will be reset to only ` +
          `the servers synced below (original backed up; restore with ${pc.bold('agentbridge rollback')} if needed)`
      );
    }

    if (serverNames.length === 0) {
      p.log.warn('No configured MCP servers found across any detected agents.');
      p.outro(pc.dim('Done.'));
      return;
    }

    p.log.info(
      `Discovered ${pc.green(String(serverNames.length))} unique MCP server(s):`
    );
    for (const name of serverNames) {
      const sources = serverSources[name]?.join(', ') || 'unknown';
      p.log.message(`  ${icons.bullet} ${pc.bold(name)} ${pc.dim(`(from: ${sources})`)}`);
    }

    if (!options.yes) {
      const confirm = await p.confirm({
        message: `Mirror these ${serverNames.length} MCP servers to all detected agent configs?`,
        initialValue: true,
      });

      if (p.isCancel(confirm) || !confirm) {
        p.cancel('Operation cancelled.');
        return;
      }
    }

    const s = p.spinner();
    s.start('Merging and updating MCP configuration files...');

    let summary;
    try {
      summary = await syncMcpConfigs(agents, {
        dryRun: options.dryRun,
        outputPath: options.output,
        backupExisting: true,
      });
    } catch (err: any) {
      s.stop('MCP synchronization failed.');
      p.outro(pc.red(`✖ ${err.message || String(err)}`));
      process.exitCode = 1;
      return;
    }

    s.stop('MCP synchronization complete!');

    for (const res of summary.results) {
      if (res.success && res.configWasInvalid) {
        p.log.warn(
          `${pc.bold(res.agentId)}: Config at ${contractHome(res.filePath)} had invalid JSON - ` +
            `reset and rewritten with the synced servers only [Total: ${res.totalServers}]. ` +
            `Original (invalid) file backed up - restore with ${pc.bold('agentbridge rollback')} if needed.`
        );
      } else if (res.success) {
        const added = res.addedServers.length ? ` (+${res.addedServers.length} new)` : '';
        p.log.success(
          `${pc.bold(res.agentId)}: Updated config at ${contractHome(res.filePath)}${pc.green(added)} [Total: ${res.totalServers}]`
        );
      } else {
        p.log.error(`${pc.bold(res.agentId)}: Sync failed (${res.error})`);
      }
    }

    if (options.output) {
      p.log.success(`Exported unified config to ${contractHome(options.output)}`);
    }

    p.outro(pc.green('✔ MCP server configurations successfully synchronized!'));
  });

/**
 * agentbridge sync-rules
 */
program
  .command('sync-rules')
  .description('Synchronize AGENTS.md to CLAUDE.md, GEMINI.md, .cursorrules, and .github/copilot-instructions.md in current project')
  .option('-c, --cwd <dir>', 'Project root directory', process.cwd())
  .option('-m, --mode <mode>', 'Sync mode: symlink or copy', 'copy')
  .option('-y, --yes', 'Automatically confirm all prompts')
  .action(async (options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(' agentbridge sync-rules ')));

    const projectRoot = path.resolve(options.cwd);
    if (!(await pathExists(projectRoot))) {
      // Without this check, a typo'd --cwd silently created an entire new
      // project directory tree (AGENTS.md + every target file) at the
      // wrong path instead of erroring - easy to miss since the command
      // still exits 0, and confusing when the real project never got its
      // rules file.
      p.log.error(`Directory does not exist: ${projectRoot}`);
      p.outro(pc.red('✖ Cannot synchronize rules for a nonexistent directory.'));
      process.exitCode = 1;
      return;
    }
    const { sourceFile, targets } = await inspectProjectRules(projectRoot);

    p.log.info(`Project root: ${pc.cyan(projectRoot)}`);
    if (sourceFile) {
      p.log.info(`Source of truth: ${pc.green(path.basename(sourceFile))}`);
    } else {
      p.log.info(`No rules found. Initializing new ${pc.green('AGENTS.md')}...`);
    }

    for (const target of targets) {
      p.log.message(
        `  ${icons.bullet} ${target.fileName.padEnd(25)} ${pc.dim(`[${target.status}]`)}`
      );
    }

    if (!options.yes) {
      const confirm = await p.confirm({
        message: `Synchronize AGENTS.md rules to all agent targets via ${options.mode}?`,
        initialValue: true,
      });

      if (p.isCancel(confirm) || !confirm) {
        p.cancel('Operation cancelled.');
        return;
      }
    }

    const s = p.spinner();
    s.start('Synchronizing project rule files...');

    let result;
    try {
      result = await syncProjectRules(projectRoot, {
        mode: options.mode as 'symlink' | 'copy',
      });
    } catch (err: any) {
      s.stop('Rule synchronization failed.');
      p.outro(pc.red(`✖ ${err.message || String(err)}`));
      process.exitCode = 1;
      return;
    }

    s.stop('Rule consolidation complete!');

    let anyFailed = false;
    for (const target of result.targets) {
      if (target.action === 'symlinked') {
        p.log.success(`${pc.bold(target.fileName)}: Symlinked to source`);
      } else if (target.action === 'hardlinked') {
        p.log.warn(
          `${pc.bold(target.fileName)}: Hardlinked to source (real symlinks unavailable on this system - ` +
            `enable Windows Developer Mode or run as admin for true symlinks; a hardlink can go stale if ` +
            `AGENTS.md is replaced instead of edited in place)`
        );
      } else if (target.action === 'created') {
        p.log.success(`${pc.bold(target.fileName)}: Mirrored and synchronized`);
      } else if (target.action === 'skipped') {
        p.log.info(`${pc.bold(target.fileName)}: Source file (skipped)`);
      } else {
        anyFailed = true;
        p.log.error(`${pc.bold(target.fileName)}: Failed (${target.error})`);
      }
    }

    if (anyFailed) {
      process.exitCode = 1;
      p.outro(pc.red('✖ Rule synchronization finished with errors - see above.'));
    } else {
      p.outro(pc.green('✔ Project agent rules synchronized!'));
    }
  });

/**
 * agentbridge add-skill <name>
 */
program
  .command('add-skill <name>')
  .description('Scaffold a new standardized skill with YAML frontmatter in central hub')
  .option('-d, --desc <description>', 'Skill description')
  .option('-a, --author <author>', 'Skill author')
  .option('-t, --tags <tags>', 'Comma-separated skill tags')
  .option('--hub <path>', 'Custom skills hub directory')
  .action(async (name, options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(` agentbridge add-skill : ${name} `)));

    let description = options.desc;
    if (!description) {
      const input = await p.text({
        message: 'Enter skill description:',
        placeholder: 'e.g. Specialized workflows and prompt guidelines for database migration',
        validate: (val) => (!val || !val.trim() ? 'Description is required' : undefined),
      });

      if (p.isCancel(input)) {
        p.cancel('Cancelled.');
        return;
      }
      description = input;
    }

    const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : undefined;

    const s = p.spinner();
    s.start(`Creating skill ${name}...`);

    let result;
    try {
      result = await createNewSkill(name, {
        description,
        author: options.author,
        tags,
        hubPath: options.hub,
      });
    } catch (err: any) {
      s.stop('Skill creation failed.');
      p.outro(pc.red(`✖ ${err.message || String(err)}`));
      process.exitCode = 1;
      return;
    }

    s.stop('Skill created!');

    p.log.success(`Scaffolded skill at: ${pc.cyan(contractHome(result.skillPath))}`);
    p.log.message(`File: ${pc.bold('SKILL.md')}`);

    p.outro(
      pc.green(
        `✔ Skill '${name}' is now active and immediately accessible by all linked agents!`
      )
    );
  });

/**
 * agentbridge doctor
 */
program
  .command('doctor')
  .description('Run comprehensive health diagnostics and repair configuration issues')
  .option('--fix', 'Automatically repair fixable issues (broken symlinks, missing folders)')
  .option('--hub <path>', 'Custom skills hub directory')
  .action(async (options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(' agentbridge doctor ')));

    const s = p.spinner();
    s.start('Running system diagnostics...');

    const report = await runDiagnostics({ hubPath: options.hub });
    s.stop('Diagnostics finished!\n');

    console.log(pc.bold('Diagnostic Health Report:'));
    for (const check of report.checks) {
      let icon = icons.success;
      if (check.status === 'warning') icon = icons.warning;
      else if (check.status === 'error') icon = icons.error;
      else if (check.status === 'info') icon = icons.info;

      console.log(`  ${icon} ${pc.bold(check.title)}`);
      console.log(`    ${pc.dim(check.description)}`);
      if (check.details && check.details.length > 0) {
        for (const d of check.details) {
          console.log(`      ${pc.red('•')} ${d}`);
        }
      }
    }

    console.log('');
    console.log(
      `  Checks: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.errors} errors.`
    );

    if (report.summary.fixableCount > 0) {
      if (options.fix) {
        const fixSpinner = p.spinner();
        fixSpinner.start('Repairing fixable issues...');
        const fixRes = await fixDiagnostics(report);
        fixSpinner.stop('Repairs completed!');
        p.log.success(
          `Fixed ${fixRes.fixedCount} issue(s). (${fixRes.failedCount} failed)`
        );
      } else {
        p.log.info(
          `${report.summary.fixableCount} issue(s) can be automatically fixed with ${pc.cyan('agentbridge doctor --fix')}`
        );
      }
    }

    if (report.summary.errors === 0) {
      p.outro(pc.green('✔ System is healthy!'));
    } else {
      p.outro(pc.yellow('⚠ Found issues requiring attention.'));
    }

    // Separate from the message above (unchanged): without --fix, real
    // problems are left exactly as found on disk, so a script relying on
    // the exit code (e.g. `agentbridge doctor && deploy`) shouldn't
    // proceed past them. Broken links, exposed secrets, and skill-name
    // collisions are all reported at `warning` severity (not `errors`),
    // so this checks both - `errors` alone would miss every one of them.
    // --fix having just run its own repair pass keeps this at 0, matching
    // its own success/failure reporting a few lines above.
    if (!options.fix && (report.summary.errors > 0 || report.summary.warnings > 0)) {
      process.exitCode = 1;
    }
  });

/**
 * agentbridge unlink
 */
program
  .command('unlink')
  .description('Safely unlink agents from central hub and restore standalone folders')
  .option('-y, --yes', 'Automatically confirm prompts')
  .option('--no-restore', 'Do not copy hub skills back into standalone folders')
  .action(async (options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(' agentbridge unlink ')));

    const agents = await detectInstalledAgents({ checkAll: false });
    const linked = agents.filter((a) => a.isLinkedToHub);

    if (linked.length === 0) {
      p.log.info('No agents are currently linked to the central hub.');
      p.outro(pc.dim('Done.'));
      return;
    }

    if (!options.yes) {
      const confirm = await p.confirm({
        message: `Unlink ${linked.length} agent(s) from hub and restore standalone folders?`,
        initialValue: true,
      });

      if (p.isCancel(confirm) || !confirm) {
        p.cancel('Operation cancelled.');
        return;
      }
    }

    const s = p.spinner();
    s.start('Unlinking agents and restoring folders...');

    const { unlinkAgentsFromHub } = await import('./core/skill-linker.js');
    const results = await unlinkAgentsFromHub(linked, {
      restoreFiles: options.restore !== false,
    });

    s.stop('Unlink completed!');

    const restored = options.restore !== false;
    for (const r of results) {
      if (r.success) {
        p.log.success(
          restored
            ? `${pc.bold(r.agentName)}: Successfully unlinked and restored.`
            : `${pc.bold(r.agentName)}: Successfully unlinked.`
        );
      } else {
        p.log.error(`${pc.bold(r.agentName)}: Failed (${r.error})`);
      }
    }

    p.outro(pc.green('✔ All requested agents unlinked.'));
  });

/**
 * agentbridge rollback
 */
program
  .command('rollback [snapshotId]')
  .description('List backup snapshots or restore configurations to a previous state')
  .option('-l, --list', 'List all available backup snapshots')
  .action(async (snapshotId, options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(' agentbridge rollback ')));

    const { listBackupSnapshots, restoreBackupSnapshot } = await import('./core/rollback.js');
    const snapshots = await listBackupSnapshots();

    if (snapshots.length === 0) {
      p.log.info('No backup snapshots found in ~/.agentbridge/backups');
      p.outro(pc.dim('Done.'));
      return;
    }

    if (options.list) {
      console.log(pc.bold('Available Backup Snapshots:\n'));
      for (const s of snapshots) {
        console.log(`  ${pc.cyan(s.id)}`);
        console.log(`    ${pc.bold(s.description)}`);
        console.log(`    ${pc.dim(new Date(s.timestamp).toLocaleString())} • ${Object.keys(s.files).length} file(s)`);
      }
      p.outro(pc.green(`Total snapshots: ${snapshots.length}`));
      return;
    }

    let targetId = snapshotId;
    if (!targetId) {
      const choices = snapshots.map((s) => ({
        value: s.id,
        label: `${s.description} (${new Date(s.timestamp).toLocaleString()})`,
        hint: `${Object.keys(s.files).length} file(s)`,
      }));

      const selected = await p.select({
        message: 'Select a backup snapshot to restore:',
        options: choices,
      });

      if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        return;
      }
      targetId = selected as string;
    }

    const s = p.spinner();
    s.start(`Restoring snapshot ${targetId}...`);

    const result = await restoreBackupSnapshot(targetId);
    s.stop(result.success ? 'Rollback finished!' : 'Rollback did not complete.');

    for (const f of result.restoredFiles) {
      p.log.success(`Restored: ${contractHome(f)}`);
    }

    if (result.success) {
      p.outro(pc.green('✔ Successfully rolled back configuration!'));
    } else {
      // restoreBackupSnapshot() sets `error` (a single top-level message)
      // for whole-operation failures - unknown snapshot ID, unreadable/
      // corrupt snapshot file - where `failedFiles` is empty because no
      // individual file restore was ever attempted. Printing only the
      // failedFiles loop in that case showed nothing but a generic
      // "failed or was incomplete", with the actual reason (e.g. "Snapshot
      // not found: <id>") computed correctly but never surfaced.
      if (result.error) {
        p.log.error(result.error);
      }
      for (const failed of result.failedFiles) {
        p.log.error(`Failed to restore ${contractHome(failed.path)}: ${failed.error}`);
      }
      p.outro(pc.red('✖ Rollback failed or was incomplete.'));
      process.exitCode = 1;
    }
  });

/**
 * agentbridge watch
 */
program
  .command('watch')
  .description('Live file-watcher that auto-synchronizes skills and project rules on change')
  .option('-c, --cwd <dir>', 'Project root directory', process.cwd())
  .action(async (options) => {
    printBanner();
    p.intro(pc.bgCyan(pc.black(' agentbridge watch ')));

    p.log.info('Starting file watcher for skills hub and workspace rules...');
    p.log.info(pc.dim('Press Ctrl+C to stop watching.\n'));

    const { startWatcher } = await import('./core/watcher.js');
    const watcher = await startWatcher({
      projectRoot: options.cwd,
      onSkillChange: (event, filename) => {
        p.log.message(`${icons.link} Skill change detected: ${pc.cyan(filename || 'unknown')} (${event})`);
      },
      onRuleChange: (event, filename, result) => {
        // result.targets can carry per-target 'failed' entries (e.g. a
        // target file locked by another concurrently-running agentbridge
        // command) even though syncProjectRules() itself resolved normally -
        // a bare unconditional success message here would claim a clean
        // sync while some or all targets were actually left untouched.
        const failed = result.targets.filter((t) => t.action === 'failed');
        if (failed.length > 0) {
          const succeededNames = result.targets
            .filter((t) => t.action !== 'failed')
            .map((t) => t.fileName);
          p.log.warn(
            `⚠ Partially synchronized ${pc.bold(filename || 'AGENTS.md')}` +
              (succeededNames.length > 0 ? ` (ok: ${succeededNames.join(', ')})` : '') +
              ` - failed: ${failed.map((f) => `${f.fileName} (${f.error})`).join('; ')}`
          );
        } else {
          p.log.success(`✔ Auto-synchronized ${pc.bold(filename || 'AGENTS.md')} to CLAUDE.md / GEMINI.md / .cursorrules`);
        }
      },
      onRuleSyncError: (event, filename, error) => {
        p.log.error(`✖ Failed to synchronize ${pc.bold(filename || 'AGENTS.md')}: ${error}`);
      },
    });

    if (watcher.isWatching) {
      p.log.success('Watching active! Changes will sync automatically.');
    } else {
      p.log.warn('Could not initialize watchers.');
    }
  });

program.parse(process.argv);
