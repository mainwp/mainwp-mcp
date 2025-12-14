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

/**
 * Create a logger that sends structured messages to MCP clients.
 *
 * @param server - The MCP server instance (requires logging capability)
 * @param loggerName - Name to identify the logging source (default: 'mainwp-mcp')
 */
export function createLogger(server: Server, loggerName = 'mainwp-mcp'): Logger {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    // Build the log data payload
    const logData = data ? { message, ...data } : message;

    // Try to send via MCP protocol
    server
      .sendLoggingMessage({
        level,
        logger: loggerName,
        data: logData,
      })
      .catch(() => {
        // Fall back to stderr if server not connected or logging not enabled
        const timestamp = new Date().toISOString();
        const dataStr = data ? ` ${JSON.stringify(data)}` : '';
        console.error(
          `[${timestamp}] [${level.toUpperCase()}] [${loggerName}] ${message}${dataStr}`
        );
      });
  };

  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    notice: (message, data) => log('notice', message, data),
    warning: (message, data) => log('warning', message, data),
    error: (message, data) => log('error', message, data),
    critical: (message, data) => log('critical', message, data),
  };
}

/**
 * Simple stderr logger for use before MCP server is initialized.
 * Does not require a server instance.
 */
export function createStderrLogger(loggerName = 'mainwp-mcp'): Logger {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    console.error(`[${timestamp}] [${level.toUpperCase()}] [${loggerName}] ${message}${dataStr}`);
  };

  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    notice: (message, data) => log('notice', message, data),
    warning: (message, data) => log('warning', message, data),
    error: (message, data) => log('error', message, data),
    critical: (message, data) => log('critical', message, data),
  };
}
