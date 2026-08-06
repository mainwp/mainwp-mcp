/**
 * Structured Logging Utility
 *
 * Provides MCP-compliant logging with severity levels.
 * Uses server.sendLoggingMessage() when connected, falls back to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { redactStringsDeep } from './security.js';

// RFC 5424 log levels, minus 'alert'/'emergency' — the Logger interface
// implements exactly these six, so the type carries no unreachable members
export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  notice(message: string, data?: Record<string, unknown>): void;
  warning(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  critical(message: string, data?: Record<string, unknown>): void;
}

type LogFn = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

/**
 * C0 control characters (U+0000–U+001F: includes ESC, newline, CR, tab), DEL
 * (U+007F), and C1 control characters (U+0080–U+009F).
 *
 * Remote-derived text can reach the operator's stderr terminal at startup — a
 * hostile Dashboard error body, or a JSON.parse SyntaxError whose message
 * retained raw response bytes — carrying ANSI/CSI/OSC escape sequences and
 * newlines that recolor/reposition the terminal or spoof additional log lines.
 * The class is a single bounded character range (linear scan, no backtracking),
 * so it stays ReDoS-safe even on the largest size-capped bodies.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Strip control/escape bytes so a formatted log line cannot manipulate the
 * terminal or forge a second log entry. Ordinary text (including multibyte
 * Unicode above U+009F) is left byte-for-byte unchanged.
 */
function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

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
  // Strip control/escape bytes at the single stderr sink: this line is the only
  // console write in this module, and both createStderrLogger and the
  // createLogger fallback route through it, so remote-derived text reaching the
  // operator's terminal is neutralized here regardless of which caller produced
  // it. JSON.stringify escapes C0 bytes in `data` but not DEL/C1, so the whole
  // formatted line is stripped rather than only `message`.
  console.error(
    stripControlChars(
      `[${timestamp}] [${level.toUpperCase()}] [${loggerName}] ${message}${dataStr}`
    )
  );
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
 * Wrap a logger so a caller-supplied redactor runs over every message and
 * every structured field before the entry reaches the real logger.
 *
 * For values a call knows are secret but the process-wide registry does not
 * hold: first-run setup validates a submitted password against a
 * model-supplied Dashboard, and the code that logs during that fetch cannot
 * know the value. One wrapper at the logger boundary covers every log site
 * inside the call, sanitized or not.
 */
export function withSecretRedaction(logger: Logger, redact: (text: string) => string): Logger {
  const wrap =
    (fn: (msg: string, data?: Record<string, unknown>) => void) =>
    (message: string, data?: Record<string, unknown>) =>
      fn(
        redact(message),
        data ? (redactStringsDeep(data, redact) as Record<string, unknown>) : data
      );
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
