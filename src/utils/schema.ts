import { z } from 'zod';
import YAML from 'yaml';
import type { SkillFrontmatter } from '../types/skill.js';
import type { MCPServerConfig, MCPConfigFile } from '../types/mcp.js';

// Universal SKILL Frontmatter Schema
export const SkillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().min(1, 'Skill description is required'),
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  homepage: z.string().url().optional().or(z.literal('')),
  license: z.string().optional(),
  // Claude Code specific fields
  'allowed-tools': z.string().optional(),
  allowedTools: z.string().or(z.array(z.string())).optional(),
  'argument-hint': z.string().optional(),
  argumentHint: z.string().optional(),
}).passthrough();

// MCP Server Config Schema
export const MCPServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  disabled: z.boolean().optional(),
  autoApprove: z.array(z.string()).optional(),
  url: z.string().optional(),
  transport: z.enum(['stdio', 'sse', 'websocket']).optional().or(z.string().optional()),
}).passthrough();

// MCP Config File Schema
export const MCPConfigFileSchema = z.object({
  mcpServers: z.record(MCPServerConfigSchema).optional(),
}).passthrough();

/**
 * Extracts and parses YAML frontmatter from markdown content
 */
export function parseFrontmatter(markdown: string): {
  frontmatter: SkillFrontmatter | null;
  content: string;
  rawYaml: string | null;
  /**
   * True only when a `---`-delimited frontmatter block was actually found
   * but its YAML failed to parse - distinct from a file that simply has no
   * frontmatter block at all (the normal case for a plain markdown note,
   * where `frontmatter: null` carries no error). Callers that would
   * otherwise silently fall back to regenerating a fresh frontmatter block
   * (discarding whatever the malformed one contained beyond name/
   * description) can use this to warn instead of staying silent - see
   * selectivelyImportSkills()'s markdown_file branch in skill-linker.ts.
   */
  hadInvalidFrontmatterBlock: boolean;
} {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    return {
      frontmatter: null,
      content: markdown,
      rawYaml: null,
      hadInvalidFrontmatterBlock: false,
    };
  }

  const rawYaml = match[1];
  const content = match[2];

  try {
    const parsed = YAML.parse(rawYaml);
    return {
      frontmatter: parsed as SkillFrontmatter,
      content,
      rawYaml,
      hadInvalidFrontmatterBlock: false,
    };
  } catch {
    return {
      frontmatter: null,
      content,
      rawYaml,
      hadInvalidFrontmatterBlock: true,
    };
  }
}

/**
 * Normalizes frontmatter to ensure universal compatibility across all 4 agents
 */
export function normalizeSkillFrontmatter(
  frontmatter: Record<string, unknown> | null,
  fallbackName: string,
  fallbackDescription = `Skill for ${fallbackName}`
): SkillFrontmatter {
  const fm = { ...(frontmatter || {}) };

  const name = String(fm.name || fallbackName);
  const description = String(fm.description || fallbackDescription);

  return {
    name,
    description,
    ...fm,
  };
}

/**
 * Serializes frontmatter and content to markdown string
 */
export function stringifyFrontmatter(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  const yamlStr = YAML.stringify(frontmatter).trim();
  const normalizedContent = content.trim();
  return `---\n${yamlStr}\n---\n\n${normalizedContent}\n`;
}

/**
 * Validates skill frontmatter with Zod
 */
export function validateSkillFrontmatter(data: unknown): {
  isValid: boolean;
  errors: string[];
  data?: SkillFrontmatter;
} {
  const result = SkillFrontmatterSchema.safeParse(data);
  if (result.success) {
    return { isValid: true, errors: [], data: result.data as SkillFrontmatter };
  } else {
    return {
      isValid: false,
      errors: result.error.errors.map(
        (e) => `${e.path.join('.') || 'root'}: ${e.message}`
      ),
    };
  }
}

/**
 * Validates MCP server configuration
 */
export function validateMCPServerConfig(data: unknown): {
  isValid: boolean;
  errors: string[];
  data?: MCPServerConfig;
} {
  const result = MCPServerConfigSchema.safeParse(data);
  if (result.success) {
    return { isValid: true, errors: [], data: result.data as MCPServerConfig };
  } else {
    return {
      isValid: false,
      errors: result.error.errors.map(
        (e) => `${e.path.join('.') || 'root'}: ${e.message}`
      ),
    };
  }
}

/**
 * Validates MCP configuration file
 */
export function validateMCPConfigFile(data: unknown): {
  isValid: boolean;
  errors: string[];
  data?: MCPConfigFile;
} {
  const result = MCPConfigFileSchema.safeParse(data);
  if (result.success) {
    return { isValid: true, errors: [], data: result.data as MCPConfigFile };
  } else {
    return {
      isValid: false,
      errors: result.error.errors.map(
        (e) => `${e.path.join('.') || 'root'}: ${e.message}`
      ),
    };
  }
}

/**
 * Calculates Shannon entropy of a string (measures randomness/information density)
 */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;

  const frequencies: Record<string, number> = {};
  for (const char of str) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }

  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(frequencies)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Checks if a string is an obvious placeholder, test token, or example string
 */
export function isKnownDummySecret(str: string): boolean {
  if (!str) return false;
  const lower = str.toLowerCase();

  const dummySubstrings = [
    'example',
    'placeholder',
    'dummy',
    'test_token',
    'token123',
    'your_token_here',
    'your-api-key',
    'xxx',
    '1234567890',
    'sk-test-',
    'ghp_test',
    'password123',
    'secret_here',
  ];

  return dummySubstrings.some((dummy) => lower.includes(dummy));
}

/**
 * Detects whether a string contains hardcoded sensitive credentials or tokens
 */
export function detectPotentialSecrets(
  value: string,
  options: { ignoreList?: string[]; fieldName?: string } = {}
): {
  hasSecret: boolean;
  reason?: string;
} {
  if (!value || typeof value !== 'string') return { hasSecret: false };

  // Explicit ignore list or marker
  if (value.includes('agentbridge-ignore-secret') || value.includes('// ignore-secret')) {
    return { hasSecret: false };
  }

  if (options.ignoreList && options.ignoreList.some((ignored) => value.includes(ignored))) {
    return { hasSecret: false };
  }

  // Filter out obvious placeholders and test fixtures
  if (isKnownDummySecret(value)) {
    return { hasSecret: false };
  }

  // A 40/64-char hex string in a field clearly labeled as a commit/hash is a
  // git SHA, not a secret - skip it regardless of which check below would
  // otherwise match it (e.g. a bare 40-hex GitHub classic token look-alike).
  const isLabeledHash =
    !!options.fieldName &&
    /commit|\bsha\b|hash/i.test(options.fieldName) &&
    /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(value.trim());
  if (isLabeledHash) {
    return { hasSecret: false };
  }

  // 1. Common token prefixes
  if (/ghp_[a-zA-Z0-9]{30,}/.test(value)) return { hasSecret: true, reason: 'GitHub Personal Access Token (ghp_...)' };
  if (/gho_[a-zA-Z0-9]{30,}/.test(value)) return { hasSecret: true, reason: 'GitHub OAuth Token (gho_...)' };
  if (/sk-[a-zA-Z0-9]{32,}/.test(value)) return { hasSecret: true, reason: 'OpenAI Secret Key (sk-...)' };
  if (/sk-ant-[a-zA-Z0-9]{32,}/.test(value)) return { hasSecret: true, reason: 'Anthropic API Key (sk-ant-...)' };
  if (/bearer\s+[a-zA-Z0-9_.\-~+/=]{20,}/i.test(value)) return { hasSecret: true, reason: 'Bearer Authentication Token' };
  if (/AKIA[0-9A-Z]{16}/.test(value)) return { hasSecret: true, reason: 'AWS Access Key ID (AKIA...)' };
  if (/AIza[0-9A-Za-z\-_]{35}/.test(value)) return { hasSecret: true, reason: 'Google API Key (AIza...)' };
  if (/xox[bp]-[a-zA-Z0-9-]{10,}/.test(value)) return { hasSecret: true, reason: 'Slack Token (xoxb-/xoxp-...)' };
  if (/eyJ[a-zA-Z0-9_-]{5,}\.eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}/.test(value)) return { hasSecret: true, reason: 'JWT Token' };
  if (/npm_[a-zA-Z0-9]{36}/.test(value)) return { hasSecret: true, reason: 'npm Access Token (npm_...)' };

  // Bare 40-char hex string not labeled as a commit/hash: could be an
  // old-style GitHub classic personal access token (they predate the
  // ghp_ prefix and are indistinguishable from a git SHA by format
  // alone - the fieldName-based exclusion above is the only way to tell
  // them apart).
  if (!options.fieldName || !/commit|\bsha\b|hash/i.test(options.fieldName)) {
    if (/^[0-9a-f]{40}$/i.test(value.trim())) {
      return { hasSecret: true, reason: 'Possible GitHub Classic Token or bare hex secret (40-char hex)' };
    }
  }

  // 2. High-entropy generic API keys / tokens (length > 28, entropy > 4.5)
  const tokenCandidate = value.match(/[a-zA-Z0-9_.\-~+/=]{30,}/);
  if (tokenCandidate) {
    const candidate = tokenCandidate[0];
    if (!isKnownDummySecret(candidate)) {
      const entropy = calculateShannonEntropy(candidate);
      if (entropy >= 4.5 && !candidate.startsWith('http') && !candidate.includes('/')) {
        return { hasSecret: true, reason: `High-entropy secret token (entropy: ${entropy.toFixed(2)})` };
      }
    }
  }

  // 3. Password embedded in database connection strings (e.g. postgres://user:password@host)
  if (/(?:postgres|mysql|mongodb|redis):\/\/[^:]+:([^@]+)@/i.test(value)) {
    const match = value.match(/(?:postgres|mysql|mongodb|redis):\/\/[^:]+:([^@]+)@/i);
    if (
      match &&
      match[1] &&
      !match[1].startsWith('$') &&
      !match[1].startsWith('{') &&
      !isKnownDummySecret(match[1])
    ) {
      return { hasSecret: true, reason: 'Database Connection String with embedded plain-text password' };
    }
  }

  return { hasSecret: false };
}

/**
 * Interpolates environment variable references in string (${VAR} or $VAR)
 */
export function interpolateEnvString(str: string): string {
  if (!str || typeof str !== 'string') return str;

  return str.replace(/\$\{([a-zA-Z0-9_]+)\}|\$([a-zA-Z0-9_]+)/g, (_, braced, unbraced) => {
    const varName = braced || unbraced;
    return process.env[varName] !== undefined ? process.env[varName]! : `\${${varName}}`;
  });
}

/**
 * Checks whether a string is already an env-var placeholder (${VAR} or $VAR)
 */
function isEnvPlaceholder(value: string): boolean {
  return /^\$\{[a-zA-Z0-9_]+\}$|^\$[a-zA-Z0-9_]+$/.test(value);
}

/**
 * Inverse of interpolateEnvString: replaces a resolved value back with its
 * ${VAR} placeholder when it exactly matches the current process.env value
 * for the given var name. Used before persisting MCP env config to disk so
 * resolved secrets never hit the filesystem in plaintext - only the
 * placeholder is written, and the real value resolves again at runtime.
 * Values that don't match a known env var (or are already a placeholder)
 * are returned unchanged.
 */
export function redactEnvValue(varName: string, value: string): string {
  if (!value || typeof value !== 'string') return value;
  if (isEnvPlaceholder(value)) return value;
  if (process.env[varName] !== undefined && process.env[varName] === value) {
    return `\${${varName}}`;
  }
  return value;
}

/**
 * Applies redactEnvValue() to every entry of an env record.
 */
export function redactEnvRecord(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) return env;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = redactEnvValue(key, value);
  }
  return result;
}
