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
  linkedAgents: SkillLinkResult[];
  totalSkillsInHub: number;
}
