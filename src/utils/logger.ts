import pc from 'picocolors';

export interface LoggerOptions {
  verbose?: boolean;
  silent?: boolean;
}

export class Logger {
  private verbose: boolean;
  private silent: boolean;

  constructor(options: LoggerOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.silent = options.silent ?? false;
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  info(msg: string): void {
    if (this.silent) return;
    console.log(pc.cyan('ℹ ') + msg);
  }

  success(msg: string): void {
    if (this.silent) return;
    console.log(pc.green('✔ ') + msg);
  }

  warn(msg: string): void {
    if (this.silent) return;
    console.warn(pc.yellow('⚠ ') + pc.yellow(msg));
  }

  error(msg: string): void {
    if (this.silent) return;
    console.error(pc.red('✖ ') + pc.red(msg));
  }

  debug(msg: string): void {
    if (this.silent || !this.verbose) return;
    console.log(pc.dim(`🔍 [debug] ${msg}`));
  }

  log(msg: string): void {
    if (this.silent) return;
    console.log(msg);
  }
}

export const logger = new Logger();
