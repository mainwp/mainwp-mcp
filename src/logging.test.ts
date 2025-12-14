/**
 * Logging Utility Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, createStderrLogger } from './logging.js';

describe('createLogger', () => {
  let mockServer: {
    sendLoggingMessage: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockServer = {
      sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should send logs via MCP server', async () => {
    const logger = createLogger(mockServer as any);

    logger.info('Test message');

    // Wait for async operation
    await vi.waitFor(() => {
      expect(mockServer.sendLoggingMessage).toHaveBeenCalled();
    });

    expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
      level: 'info',
      logger: 'mainwp-mcp',
      data: 'Test message',
    });
  });

  it('should include data in log messages', async () => {
    const logger = createLogger(mockServer as any);

    logger.info('Test message', { key: 'value' });

    await vi.waitFor(() => {
      expect(mockServer.sendLoggingMessage).toHaveBeenCalled();
    });

    expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
      level: 'info',
      logger: 'mainwp-mcp',
      data: { message: 'Test message', key: 'value' },
    });
  });

  it('should use custom logger name', async () => {
    const logger = createLogger(mockServer as any, 'custom-logger');

    logger.debug('Test');

    await vi.waitFor(() => {
      expect(mockServer.sendLoggingMessage).toHaveBeenCalled();
    });

    expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ logger: 'custom-logger' })
    );
  });

  it('should support all log levels', async () => {
    const logger = createLogger(mockServer as any);

    logger.debug('debug');
    logger.info('info');
    logger.notice('notice');
    logger.warning('warning');
    logger.error('error');
    logger.critical('critical');

    await vi.waitFor(() => {
      expect(mockServer.sendLoggingMessage).toHaveBeenCalledTimes(6);
    });

    const calls = mockServer.sendLoggingMessage.mock.calls;
    expect(calls.map(c => c[0].level)).toEqual([
      'debug',
      'info',
      'notice',
      'warning',
      'error',
      'critical',
    ]);
  });

  it('should fallback to stderr on server error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockServer.sendLoggingMessage.mockRejectedValue(new Error('Server not connected'));

    const logger = createLogger(mockServer as any);
    logger.info('Test message');

    // Wait for the promise to reject and fallback to stderr
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalled();
    });

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[INFO]'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Test message'));

    consoleError.mockRestore();
  });
});

describe('createStderrLogger', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('should write to stderr with timestamp', () => {
    const logger = createStderrLogger();

    logger.info('Test message');

    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/\[\d{4}-\d{2}-\d{2}T/));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Test message'));
  });

  it('should format log level in uppercase', () => {
    const logger = createStderrLogger();

    logger.warning('Warning message');

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[WARNING]'));
  });

  it('should include logger name in messages', () => {
    const logger = createStderrLogger('my-logger');

    logger.error('Error');

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[my-logger]'));
  });

  it('should format data as JSON', () => {
    const logger = createStderrLogger();

    logger.info('Message', { count: 5, status: 'ok' });

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"count":5'));
  });

  it('should support all log levels', () => {
    const logger = createStderrLogger();

    logger.debug('debug');
    logger.info('info');
    logger.notice('notice');
    logger.warning('warning');
    logger.error('error');
    logger.critical('critical');

    expect(consoleError).toHaveBeenCalledTimes(6);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[INFO]'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[NOTICE]'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[WARNING]'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[CRITICAL]'));
  });
});
