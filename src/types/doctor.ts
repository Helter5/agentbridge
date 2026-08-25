export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'success';

export interface HealthCheckItem {
  id: string;
  category: 'permissions' | 'paths' | 'symlinks' | 'skills' | 'mcp' | 'rules';
  title: string;
  description: string;
  status: DiagnosticSeverity;
  fixable: boolean;
  details?: string[];
  fixAction?: () => Promise<boolean>;
}

export interface DoctorReport {
  timestamp: string;
  osInfo: {
    platform: string;
    release: string;
    arch: string;
    nodeVersion: string;
  };
  checks: HealthCheckItem[];
  summary: {
    total: number;
    passed: number;
    warnings: number;
    errors: number;
    fixableCount: number;
  };
}
