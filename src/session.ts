/**
 * Session Data Tracking
 *
 * Tracks cumulative response bytes per server session and detects
 * idempotent no-op errors from upstream.
 *
 * Concurrency note: The module-level counter assumes MCP tool executions
 * are processed sequentially (stdio transport handles one request at a time).
 */

import type { Config } from './config.js';
import { McpErrorFactory } from './errors.js';
import type { Logger } from './logging.js';

/**
 * No-op error codes and their human-readable descriptions.
 * Single source of truth: NOOP_ERROR_CODES is derived from this map's keys.
 * When adding new idempotent abilities that return new error codes, add them here.
 */
export const NOOP_DESCRIPTIONS: Record<string, string> = {
  already_active: 'Already active — no action needed',
  already_inactive: 'Already inactive — no action needed',
  already_installed: 'Already installed — no action needed',
  already_connected: 'Already connected — no action needed',
  already_disconnected: 'Already disconnected — no action needed',
  already_suspended: 'Already suspended — no action needed',
  already_unsuspended: 'Already unsuspended — no action needed',
  no_updates_available: 'No updates available',
  nothing_to_update: 'Nothing to update',
};

const NOOP_ERROR_CODES = new Set(Object.keys(NOOP_DESCRIPTIONS));

/**
 * Format byte counts as human-readable strings (e.g., "50.0 MB", "2.5 KB").
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/**
 * Check whether an error represents an idempotent no-op (already in desired state).
 * Only matches 4xx HTTP errors with a recognized no-op error code.
 * @internal
 */
export function isNoOpError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (typeof status !== 'number' || status < 400 || status > 499) return false;
  if (typeof code !== 'string') return false;
  return NOOP_ERROR_CODES.has(code);
}

/**
 * Cumulative session data counter.
 */
let sessionDataBytes = 0;

/**
 * Get the current cumulative session data usage in bytes and the configured limit.
 */
export function getSessionDataUsage(config: Config): { used: number; limit: number } {
  return { used: sessionDataBytes, limit: config.maxSessionData };
}

/**
 * Track response size and enforce the session data limit.
 * Throws McpError with RESOURCE_EXHAUSTED if adding these bytes would exceed the cap.
 */
export function trackSessionData(
  text: string,
  config: Config,
  logger: Logger,
  context: string
): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (sessionDataBytes + bytes > config.maxSessionData) {
    logger.error(`Session data limit exceeded ${context}`, {
      bytes,
      sessionDataBytes,
      maxSessionData: config.maxSessionData,
      wouldBe: sessionDataBytes + bytes,
    });
    throw McpErrorFactory.resourceExhausted(
      `Session data limit reached (${formatBytes(sessionDataBytes + bytes)} of ${formatBytes(config.maxSessionData)}). Start a new session to continue.`
    );
  }
  sessionDataBytes += bytes;
  return bytes;
}

/**
 * Reset the cumulative session data counter to zero.
 */
export function resetSessionData(): void {
  sessionDataBytes = 0;
}
