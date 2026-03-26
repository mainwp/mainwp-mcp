/**
 * Structured Logging Utility
 *
 * Provides MCP-compliant logging with severity levels.
 * Uses server.sendLoggingMessage() when connected, falls back to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// RFC 5424 Log Levels
export type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  notice(message: string, data?: Record<string, unknown>): void;
  warning(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  critical(message: string, data?: Record<string, unknown>): void;
}

type LogFn = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

/** Build the 6-method Logger dispatch from a single log function. */
function buildLoggerMethods(log: LogFn): Logger {
  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    notice: (message, data) => log('notice', message, data),
    warning: (message, data) => log('warning', message, data),
    error: (message, data) => log('error', message, data),
    critical: (message, data) => log('critical', message, data),
  };
}

/** Format and write a log line to stderr. */
function logToStderr(
  level: LogLevel,
  loggerName: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.error(`[${timestamp}] [${level.toUpperCase()}] [${loggerName}] ${message}${dataStr}`);
}

/**
 * Create a logger that sends structured messages to MCP clients.
 *
 * @param server - The MCP server instance (requires logging capability)
 * @param loggerName - Name to identify the logging source (default: 'mainwp-mcp')
 */
export function createLogger(server: Server, loggerName = 'mainwp-mcp'): Logger {
  return buildLoggerMethods((level, message, data) => {
    const logData = data ? { message, ...data } : message;

    server
      .sendLoggingMessage({
        level,
        logger: loggerName,
        data: logData,
      })
      .catch(() => {
        logToStderr(level, loggerName, message, data);
      });
  });
}

/**
 * Create a child logger that automatically includes a request correlation ID
 * in every log entry. Useful for tracing a tool call across log entries.
 */
export function withRequestId(logger: Logger, requestId: string): Logger {
  const wrap =
    (fn: (msg: string, data?: Record<string, unknown>) => void) =>
    (message: string, data?: Record<string, unknown>) =>
      fn(message, { ...data, requestId });
  return {
    debug: wrap(logger.debug.bind(logger)),
    info: wrap(logger.info.bind(logger)),
    notice: wrap(logger.notice.bind(logger)),
    warning: wrap(logger.warning.bind(logger)),
    error: wrap(logger.error.bind(logger)),
    critical: wrap(logger.critical.bind(logger)),
  };
}

/**
 * Simple stderr logger for use before MCP server is initialized.
 * Does not require a server instance.
 */
export function createStderrLogger(loggerName = 'mainwp-mcp'): Logger {
  return buildLoggerMethods((level, message, data) =>
    logToStderr(level, loggerName, message, data)
  );
}
