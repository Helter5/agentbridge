import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  validateSkillFrontmatter,
  validateMCPServerConfig,
  validateMCPConfigFile,
  detectPotentialSecrets,
  interpolateEnvString,
  redactEnvValue,
  calculateShannonEntropy,
} from '../src/utils/schema.js';

describe('Schema & Frontmatter Utilities', () => {
  it('parses valid YAML frontmatter and markdown body', () => {
    const md = `---
name: web-search
description: Search the web using Perplexity API
version: 1.0.0
tags:
  - search
  - api
---

# Web Search Instructions

Follow these steps...`;

    const { frontmatter, content } = parseFrontmatter(md);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.name).toBe('web-search');
    expect(frontmatter?.description).toBe('Search the web using Perplexity API');
    expect(frontmatter?.tags).toEqual(['search', 'api']);
    expect(content.trim()).toContain('# Web Search Instructions');
  });

  it('handles markdown without frontmatter gracefully', () => {
    const md = `# Just Plain Markdown\n\nNo frontmatter here.`;
    const { frontmatter, content } = parseFrontmatter(md);
    expect(frontmatter).toBeNull();
    expect(content).toBe(md);
  });

  it('serializes frontmatter and content to markdown', () => {
    const frontmatter = {
      name: 'test-skill',
      description: 'A test skill description',
    };
    const content = '# Test Content';
    const output = stringifyFrontmatter(frontmatter, content);

    expect(output).toContain('---');
    expect(output).toContain('name: test-skill');
    expect(output).toContain('description: A test skill description');
    expect(output).toContain('# Test Content');
  });

  it('validates skill frontmatter with Zod', () => {
    const valid = validateSkillFrontmatter({
      name: 'my-skill',
      description: 'Does something useful',
    });
    expect(valid.isValid).toBe(true);

    const invalid = validateSkillFrontmatter({
      name: 'only-name-without-description',
      description: '',
    });
    expect(invalid.isValid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  it('detects potential sensitive secrets in strings', () => {
    expect(detectPotentialSecrets('ghp_A9b8C7d6E5f4G3h2I1j0K9l8M7n6O5p4').hasSecret).toBe(true);
    expect(detectPotentialSecrets('sk-A9b8C7d6E5f4G3h2I1j0K9l8M7n6O5p4Q3r2').hasSecret).toBe(true);
    expect(detectPotentialSecrets('postgres://ais_admin:P@ssw0rd987@localhost:5432/db').hasSecret).toBe(true);
    expect(detectPotentialSecrets('npx -y @modelcontextprotocol/server-postgres').hasSecret).toBe(false);
    expect(detectPotentialSecrets('ghp_test_placeholder_key').hasSecret).toBe(false);
  });

  it('detects additional known secret token formats', () => {
    expect(detectPotentialSecrets('AKIAABCDEFGHIJKLMNOP').hasSecret).toBe(true); // AWS access key
    expect(detectPotentialSecrets('AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q').hasSecret).toBe(true); // Google API key
    expect(detectPotentialSecrets('xoxb-111222333-abcdefghijklmnopqrst').hasSecret).toBe(true); // Slack bot token
    expect(
      detectPotentialSecrets(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      ).hasSecret
    ).toBe(true); // JWT
    expect(detectPotentialSecrets('npm_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6').hasSecret).toBe(true); // npm token
  });

  it('treats a bare 40-hex string as a possible secret, unless the field is a commit/sha/hash', () => {
    const hex40 = 'f'.repeat(40);
    expect(hex40.length).toBe(40);

    expect(detectPotentialSecrets(hex40).hasSecret).toBe(true);
    expect(detectPotentialSecrets(hex40, { fieldName: 'apiKey' }).hasSecret).toBe(true);

    expect(detectPotentialSecrets(hex40, { fieldName: 'commitSha' }).hasSecret).toBe(false);
    expect(detectPotentialSecrets(hex40, { fieldName: 'commit_hash' }).hasSecret).toBe(false);
    expect(detectPotentialSecrets(hex40, { fieldName: 'sha' }).hasSecret).toBe(false);
  });

  it('calculates Shannon entropy for boundary-case strings', () => {
    expect(calculateShannonEntropy('')).toBe(0);
    expect(calculateShannonEntropy('aaaaaaaaaa')).toBe(0); // zero entropy: single repeated char

    // Short strings: entropy is defined and finite, but detectPotentialSecrets
    // never reaches the entropy check for them anyway (its candidate regex
    // requires 30+ chars), so a short string can't false-positive via entropy.
    const shortEntropy = calculateShannonEntropy('abc123');
    expect(shortEntropy).toBeGreaterThan(0);
    expect(detectPotentialSecrets('abc123').hasSecret).toBe(false);

    // A standard v4 UUID (36 chars incl. hyphens, 16 possible hex symbols
    // plus the fixed hyphens) is not a secret and should not be flagged.
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(detectPotentialSecrets(uuid).hasSecret).toBe(false);

    // A hex-only string (16 possible symbols) caps out at log2(16) = 4 bits,
    // always below the 4.5 high-entropy threshold used by detectPotentialSecrets.
    const hexEntropy = calculateShannonEntropy('0123456789abcdef0123456789abcdef');
    expect(hexEntropy).toBeLessThan(4.5);
    // A random-looking mixed-case alphanumeric secret should exceed the threshold.
    const secretEntropy = calculateShannonEntropy('xT9$mQ2vL7pR4wZ8kN1bY6cF3hJ5gD0a');
    expect(secretEntropy).toBeGreaterThan(4.5);
  });

  it('round-trips ${VAR} through interpolateEnvString and back via redactEnvValue', () => {
    const varName = 'AGENTSYNC_SCHEMA_TEST_VAR';
    const original = process.env[varName];
    process.env[varName] = 'resolved-secret-value';

    try {
      const placeholder = `\${${varName}}`;
      const resolved = interpolateEnvString(placeholder);
      expect(resolved).toBe('resolved-secret-value');

      const backToPlaceholder = redactEnvValue(varName, resolved);
      expect(backToPlaceholder).toBe(placeholder);

      // A value that doesn't match the env var is left untouched.
      expect(redactEnvValue(varName, 'unrelated-value')).toBe('unrelated-value');

      // An already-placeholder value passes through unchanged.
      expect(redactEnvValue(varName, placeholder)).toBe(placeholder);
    } finally {
      if (original === undefined) delete process.env[varName];
      else process.env[varName] = original;
    }
  });

  it('leaves interpolateEnvString references unresolved when the env var is unset', () => {
    const varName = 'AGENTSYNC_SCHEMA_TEST_UNSET_VAR';
    delete process.env[varName];
    expect(interpolateEnvString(`\${${varName}}`)).toBe(`\${${varName}}`);
  });

  it('validates MCP server config schema', () => {
    const valid = validateMCPServerConfig({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: { DEBUG: '1' },
    });
    expect(valid.isValid).toBe(true);

    const validUrl = validateMCPServerConfig({
      url: 'http://localhost:8000/sse',
      transport: 'sse',
    });
    expect(validUrl.isValid).toBe(true);
  });

  it('validates full MCP config file schema', () => {
    const valid = validateMCPConfigFile({
      mcpServers: {
        memory: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
        },
      },
      customProperty: 'persisted',
    });
    expect(valid.isValid).toBe(true);
  });
});
