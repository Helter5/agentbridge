import { describe, it, expect } from 'vitest';
import {
  renderTable,
  badge,
  formatStatusLine,
  icons,
  printBanner,
} from '../src/utils/ui.js';

describe('UI and Formatting Utilities', () => {
  it('renders ASCII tables correctly', () => {
    const columns = [
      { key: 'name', header: 'Name' },
      { key: 'role', header: 'Role' },
    ];
    const data = [
      { name: 'Antigravity', role: 'IDE' },
      { name: 'Claude Code', role: 'CLI' },
    ];

    const table = renderTable(columns, data);
    expect(table).toContain('Name');
    expect(table).toContain('Role');
    expect(table).toContain('Antigravity');
    expect(table).toContain('Claude Code');
  });

  it('formats status lines with proper styling', () => {
    const line = formatStatusLine('Status', 'Active', 'ok');
    expect(line).toContain('Status');
    expect(line).toContain('Active');
  });

  it('renders badges', () => {
    const successBadge = badge('READY', 'success');
    expect(successBadge).toContain('READY');

    const warnBadge = badge('WARN', 'warning');
    expect(warnBadge).toContain('WARN');

    const errBadge = badge('FAIL', 'error');
    expect(errBadge).toContain('FAIL');
  });

  it('provides status icons', () => {
    expect(icons.success).toBeDefined();
    expect(icons.error).toBeDefined();
    expect(icons.warning).toBeDefined();
    expect(icons.info).toBeDefined();
  });
});
