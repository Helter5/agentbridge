import { stringifyFrontmatter } from '../utils/schema.js';
import type { SkillFrontmatter } from '../types/skill.js';

export interface CreateSkillTemplateOptions {
  name: string;
  description: string;
  author?: string;
  tags?: string[];
  version?: string;
  instructions?: string;
}

export function generateSkillMarkdown(options: CreateSkillTemplateOptions): string {
  const frontmatter: SkillFrontmatter = {
    name: options.name,
    description: options.description,
    version: options.version || '0.1.0',
    ...(options.author ? { author: options.author } : {}),
    tags: options.tags || ['custom', 'agent-skill'],
  };

  const defaultContent = options.instructions || `# ${options.name}

${options.description}

## When to Use
- Trigger when performing tasks related to ${options.name}.
- Use as reference guidelines or execution recipes.

## Instructions
1. Follow standard best practices for ${options.name}.
2. Ensure proper validation and error handling.
3. Keep execution steps reproducible and atomic.

## Examples
\`\`\`bash
# Example invocation or command
# $ <command>
\`\`\`
`;

  return stringifyFrontmatter(frontmatter, defaultContent);
}
