export type RuleTargetType =
  | 'claude'
  | 'gemini'
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
    action: 'created' | 'updated' | 'symlinked' | 'skipped' | 'failed';
    error?: string;
  }>;
}
