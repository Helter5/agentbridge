export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  homepage?: string;
  license?: string;
  [key: string]: unknown;
}

export interface SkillManifest {
  name: string;
  dirName: string;
  path: string;
  skillFilePath: string;
  frontmatter: SkillFrontmatter;
  content: string;
  isValid: boolean;
  validationErrors?: string[];
  filesCount: number;
}

export interface DiscoveredSkill {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  description: string;
  sourcePath: string;
  type: 'directory' | 'markdown_file';
  frontmatter?: SkillFrontmatter;
}

export interface SelectiveImportResult {
  importedSkills: string[];
  failedSkills: Array<{ name: string; error: string }>;
  targetPath: string;
  /**
   * Skills that imported successfully but needed a caveat: currently, a
   * markdown_file skill whose SKILL.md had a `---`-delimited frontmatter
   * block that failed to parse as YAML. The import still succeeds (a
   * fresh, valid frontmatter block is generated from the already-known
   * name/description, and the body content is preserved), but any other
   * fields the original frontmatter had (version, tags, custom fields...)
   * are lost in the process - distinct from a plain success.
   */
  warnings: Array<{ name: string; message: string }>;
}

export interface SkillLinkResult {
  agentId: string;
  agentName: string;
  targetPath: string;
  linkPath: string;
  success: boolean;
  actionTaken: 'created_link' | 'already_linked' | 'backed_up_and_linked' | 'failed';
  error?: string;
}

export interface SkillSyncSummary {
  hubPath: string;
  importedSkills: string[];
  /**
   * Two different agents had a skill folder with the same name but
   * different SKILL.md content - the merge kept whichever agent's copy got
   * there first and discarded the other, per file. See MergeSkillsResult
   * in skill-linker.ts for the full reasoning.
   */
  collisions: Array<{ skillName: string; keptFrom: string; discardedFrom: string }>;
  linkedAgents: SkillLinkResult[];
  totalSkillsInHub: number;
}
