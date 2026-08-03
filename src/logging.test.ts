/**
 * Logging Utility Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createLogger, createStderrLogger, withRequestId } from './logging.js';

describe('createLogger', () => {
  let mockServer: {
    sendLoggingMessage: ReturnType<typeof vi.fn>;
  };
  // createLogger only calls sendLoggingMessage, so the stub narrows to that
  const asServer = () => mockServer as unknown as Server;

  beforeEach(() => {
    mockServer = {
      sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should send logs via MCP server', async () => {
    const logger = createLogger(asServer());

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
    const logger = createLogger(asServer());

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
    const logger = createLogger(asServer(), 'custom-logger');

    logger.debug('Test');

    await vi.waitFor(() => {
      expect(mockServer.sendLoggingMessage).toHaveBeenCalled();
    });

    expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ logger: 'custom-logger' })
    );
  });

  it('should support all log levels', async () => {
    const logger = createLogger(asServer());

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

    const logger = createLogger(asServer());
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

describe('logToStderr control-character neutralization', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('strips ANSI/CSI escape sequences so a remote message cannot recolor the terminal', () => {
    const logger = createStderrLogger();

    logger.error('remote said \x1b[31mHACKED\x1b[0m');

    const line = consoleError.mock.calls[0][0] as string;
    expect(line).not.toContain('\x1b');
    // ESC removed; the now-inert "[31m" survives only as harmless literal text.
    expect(line).toContain('remote said [31mHACKED[0m');
  });

  it('strips newlines and carriage returns so a message cannot forge a second log line', () => {
    const logger = createStderrLogger();

    logger.error('line one\n[2026-01-01T00:00:00.000Z] [ERROR] [mainwp-mcp] FORGED\r');

    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = consoleError.mock.calls[0][0] as string;
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line).toContain('FORGED');
  });

  it('strips DEL and C1 control characters from the message', () => {
    const logger = createStderrLogger();

    logger.error('a\x7fb\x9bc');

    const line = consoleError.mock.calls[0][0] as string;
    expect(line).not.toMatch(/[\x7f-\x9f]/);
    expect(line).toContain('abc');
  });

  it('strips control bytes from JSON-encoded data that survive JSON.stringify (DEL/C1)', () => {
    const logger = createStderrLogger();

    logger.info('msg', { field: 'x\x7f\x9by' });

    const line = consoleError.mock.calls[0][0] as string;
    expect(line).not.toMatch(/[\x7f-\x9f]/);
  });

  it('neutralizes a JSON.parse SyntaxError body that retained raw ESC bytes (exploit path)', () => {
    // Reproduce the objection's exploit: a 200-OK invalid-JSON response body
    // that embeds an ANSI sequence. Node's SyntaxError message retains the raw
    // ESC byte; that error propagates paginateApi -> validateCredentials
    // (credential-check.ts:92 re-wrap) -> index.ts fatal handler ->
    // startupLogger.error -> this stderr sink.
    let syntaxMessage = '';
    try {
      JSON.parse('\x1b[31mHACKED\x1b[0m');
    } catch (err) {
      syntaxMessage = (err as Error).message;
    }
    // Precondition: the raw ESC byte is present in the unsanitized message.
    expect(syntaxMessage).toContain('\x1b');

    const logger = createStderrLogger();
    logger.error(`Fatal error: Credential validation failed: ${syntaxMessage}`);

    const line = consoleError.mock.calls[0][0] as string;
    expect(line).not.toContain('\x1b');
    expect(line).not.toContain('\n');
  });

  it('leaves a control-char-free message unchanged', () => {
    const logger = createStderrLogger('mainwp-mcp');
    const msg = 'Connected! Found 42 abilities';

    logger.info(msg);

    const line = consoleError.mock.calls[0][0] as string;
    // Timestamp is dynamic; the stable tail must be byte-identical (no stripping
    // applied to control-char-free text).
    expect(line.endsWith(`[INFO] [mainwp-mcp] ${msg}`)).toBe(true);
  });
});

describe('withRequestId', () => {
  it('should add requestId to all log calls', () => {
    const inner = {
      debug: vi.fn(),
      info: vi.fn(),
      notice: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      critical: vi.fn(),
    };

    const wrapped = withRequestId(inner, 'abc-123');

    wrapped.debug('d');
    wrapped.info('i', { extra: 1 });
    wrapped.notice('n');
    wrapped.warning('w');
    wrapped.error('e');
    wrapped.critical('c');

    expect(inner.debug).toHaveBeenCalledWith('d', { requestId: 'abc-123' });
    expect(inner.info).toHaveBeenCalledWith('i', { extra: 1, requestId: 'abc-123' });
    expect(inner.notice).toHaveBeenCalledWith('n', { requestId: 'abc-123' });
    expect(inner.warning).toHaveBeenCalledWith('w', { requestId: 'abc-123' });
    expect(inner.error).toHaveBeenCalledWith('e', { requestId: 'abc-123' });
    expect(inner.critical).toHaveBeenCalledWith('c', { requestId: 'abc-123' });
  });
});
