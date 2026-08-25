import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  validateSkillFrontmatter,
  validateMCPServerConfig,
  validateMCPConfigFile,
  detectPotentialSecrets,
  interpolateEnvString,
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
