import pc from 'picocolors';

/**
 * Renders the AgentSync banner
 */
export function printBanner(): void {
  const logo = `
   ___                    __  _____                  
  / _ | ___ ____ ___  ___/ /_/ __/_ _____  ____ ___ 
 / __ |/ _ \`/ -_) _ \\/ __/ __/\\ \\/ // / _ \\/ __/ -_)
/_/ |_|\\_, /\\__/_//_/\\__/\\__/___/\\_, /_//_/\\__/\\__/ 
      /___/                     /___/               `;

  console.log(pc.cyan(logo));
  console.log(
    pc.dim('  Universal Skill & MCP Sync Engine for AI Coding Agents') + '\n'
  );
}

/**
 * Formats a key-value status line
 */
export function formatStatusLine(label: string, value: string, status?: 'ok' | 'warn' | 'error' | 'dim'): string {
  let colorVal = value;
  if (status === 'ok') colorVal = pc.green(value);
  else if (status === 'warn') colorVal = pc.yellow(value);
  else if (status === 'error') colorVal = pc.red(value);
  else if (status === 'dim') colorVal = pc.dim(value);

  return `  ${pc.bold(label.padEnd(20))}: ${colorVal}`;
}

export interface TableColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
}

/**
 * Simple, beautiful ASCII table generator
 */
export function renderTable<T extends Record<string, any>>(
  columns: TableColumn[],
  rows: T[]
): string {
  // Compute column widths
  const widths = columns.map((col) => {
    const headerLen = col.header.length;
    const maxDataLen = rows.reduce((max, row) => {
      const val = row[col.key] != null ? String(row[col.key]) : '';
      // Strip ANSI escape codes for length computation
      const cleanVal = val.replace(/\u001b\[\d+m/g, '');
      return Math.max(max, cleanVal.length);
    }, 0);
    return Math.max(col.width || 0, headerLen, maxDataLen);
  });

  const sep = '│';
  const topSep = '─';

  // Build header
  const headerRow = columns
    .map((col, i) => pc.bold(col.header.padEnd(widths[i])))
    .join(` ${pc.dim(sep)} `);

  const divider = widths
    .map((w) => topSep.repeat(w))
    .join(`${topSep}┼${topSep}`);

  const dataRows = rows.map((row) => {
    return columns
      .map((col, i) => {
        const val = row[col.key] != null ? String(row[col.key]) : '';
        const cleanLen = val.replace(/\u001b\[\d+m/g, '').length;
        const padding = Math.max(0, widths[i] - cleanLen);
        if (col.align === 'right') {
          return ' '.repeat(padding) + val;
        }
        return val + ' '.repeat(padding);
      })
      .join(` ${pc.dim(sep)} `);
  });

  return [
    `  ${headerRow}`,
    `  ${pc.dim(divider)}`,
    ...dataRows.map((r) => `  ${r}`),
  ].join('\n');
}

/**
 * Formats a badge
 */
export function badge(text: string, type: 'success' | 'warning' | 'error' | 'info' | 'dim'): string {
  switch (type) {
    case 'success':
      return pc.bgGreen(pc.black(` ${text} `));
    case 'warning':
      return pc.bgYellow(pc.black(` ${text} `));
    case 'error':
      return pc.bgRed(pc.white(` ${text} `));
    case 'info':
      return pc.bgCyan(pc.black(` ${text} `));
    case 'dim':
    default:
      return pc.bgBlack(pc.white(` ${text} `));
  }
}

/**
 * Status icons
 */
export const icons = {
  success: pc.green('✔'),
  error: pc.red('✖'),
  warning: pc.yellow('!'),
  info: pc.cyan('i'),
  arrow: pc.dim('->'),
  bullet: pc.dim('•'),
  link: pc.cyan('>'),
};
