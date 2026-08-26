export type RuleTargetType =
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'cursor'
  | 'copilot';

export interface RuleTarget {
  type: RuleTargetType;
  fileName: string;
  filePath: string;
  exists: boolean;
  isSymlink: boolean;
  status: 'synced' | 'out_of_sync' | 'missing' | 'symlinked';
}

export interface RuleSyncResult {
  sourcePath: string;
  targets: Array<{
    fileName: string;
    filePath: string;
    action: 'created' | 'updated' | 'symlinked' | 'hardlinked' | 'skipped' | 'failed';
    error?: string;
  }>;
}
