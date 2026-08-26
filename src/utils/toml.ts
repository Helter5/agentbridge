import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { ensureDir, chmodBestEffort } from './fs.js';
import type { MCPConfigFile } from '../types/mcp.js';

/**
 * Codex's config.toml stores MCP servers under the snake_case table
 * `mcp_servers`, matching the rest of Codex's own TOML field naming
 * (see also `startup_timeout_ms` etc. in Codex's own docs) - every other
 * agent this tool supports uses JSON's camelCase `mcpServers`. Centralizing
 * the key name here means the in-memory MCPConfigFile shape (mcpServers)
 * stays uniform across json and toml agents; only these two functions know
 * the on-disk key differs.
 */
const TOML_MCP_SERVERS_KEY = 'mcp_servers';

/**
 * Reads a TOML config file (e.g. Codex's ~/.codex/config.toml), exposing its
 * `mcp_servers` table under the same `mcpServers` key the rest of the
 * codebase already expects from JSON configs - and preserving every other
 * top-level section (Codex's own `[projects.*]` / `[windows]` etc.) in
 * `raw` so a write-back doesn't clobber settings this tool doesn't own.
 *
 * Mirrors readJsonFileWithDiagnostics's missing-vs-corrupt distinction
 * (mcp-sync.ts): a file that exists but fails to parse must never be
 * silently treated as empty - that would drop the user's existing
 * `[projects.*]` trust settings on the next write.
 */
export async function readTomlFileWithDiagnostics(
  filePath: string
): Promise<{ data: MCPConfigFile | null; raw: Record<string, unknown> | null; invalid: boolean }> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch {
    return { data: null, raw: null, invalid: false };
  }
  try {
    const raw = parseToml(content) as Record<string, unknown>;
    const rawServers = raw[TOML_MCP_SERVERS_KEY];
    const mcpServers =
      rawServers && typeof rawServers === 'object'
        ? (rawServers as MCPConfigFile['mcpServers'])
        : undefined;
    return { data: { ...raw, mcpServers }, raw, invalid: false };
  } catch {
    return { data: null, raw: null, invalid: true };
  }
}

/**
 * Writes `mcpServers` back into a TOML config file under Codex's
 * `mcp_servers` table name, preserving every other top-level section from
 * `existingRaw` (the same object readTomlFileWithDiagnostics returned) -
 * e.g. Codex's own `[projects.*]` trust levels and `[windows]` sandbox
 * setting must survive an `agentbridge sync-mcp` run untouched.
 *
 * Same 0o600 owner-only restriction as safeWriteJson (utils/fs.ts): these
 * servers can carry credentials in `env`.
 */
export async function writeTomlMcpConfig(
  filePath: string,
  existingRaw: Record<string, unknown> | null,
  mcpServers: MCPConfigFile['mcpServers']
): Promise<void> {
  const doc: Record<string, unknown> = { ...(existingRaw || {}) };
  doc[TOML_MCP_SERVERS_KEY] = mcpServers || {};
  await ensureDir(path.dirname(filePath));
  const content = stringifyToml(doc) + '\n';
  await fsp.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  await chmodBestEffort(filePath, 0o600);
}

/**
 * True when `filePath`'s extension marks it as a TOML config (currently
 * just Codex's config.toml) rather than the JSON every other supported
 * agent uses.
 */
export function isTomlConfigFile(filePath: string | undefined): boolean {
  return !!filePath && path.extname(filePath).toLowerCase() === '.toml';
}
