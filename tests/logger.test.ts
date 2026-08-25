import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../src/utils/logger.js';

describe('Logger Utility', () => {
  it('logs messages when not silent', () => {
    const logger = new Logger({ silent: false, verbose: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('info msg');
    logger.success('success msg');
    logger.debug('debug msg');
    logger.log('plain msg');

    expect(spy).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });

  it('respects silent mode', () => {
    const logger = new Logger({ silent: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('should not appear');
    logger.success('should not appear');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
