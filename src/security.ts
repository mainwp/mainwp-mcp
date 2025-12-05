/**
 * Security Utilities
 *
 * Shared security functions for input validation, error sanitization,
 * and rate limiting.
 */

import { McpErrorFactory } from './errors.js';

/**
 * Validate input arguments before forwarding to the API.
 * Prevents malicious payloads and enforces reasonable limits.
 * Throws McpError with INVALID_PARAMS code on validation failure.
 */
export function validateInput(args: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(args)) {
    // String length check
    if (typeof value === 'string' && value.length > 10000) {
      throw McpErrorFactory.invalidParams(
        `Parameter "${key}" exceeds maximum length (10000 characters)`,
        { parameter: key, maxLength: 10000 }
      );
    }

    // ID fields: accept number or numeric string, must be positive integer
    if (key.endsWith('_id')) {
      const numValue = typeof value === 'string' ? parseInt(value, 10) : value;
      if (typeof numValue === 'number') {
        if (!Number.isInteger(numValue) || numValue < 1 || numValue > Number.MAX_SAFE_INTEGER) {
          throw McpErrorFactory.invalidParams(
            `Parameter "${key}" must be a positive integer`,
            { parameter: key }
          );
        }
      }
    }

    // Array validation
    if (Array.isArray(value)) {
      if (value.length > 1000) {
        throw McpErrorFactory.invalidParams(
          `Parameter "${key}" has too many elements (max 1000)`,
          { parameter: key, maxElements: 1000, actualElements: value.length }
        );
      }
      // Validate array elements
      for (const item of value) {
        if (typeof item === 'string' && item.length > 10000) {
          throw McpErrorFactory.invalidParams(
            `Element in "${key}" exceeds maximum length (10000 characters)`,
            { parameter: key, maxLength: 10000 }
          );
        }
      }
    }

    // Nested object depth check (prevent deeply nested payloads)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const depth = getObjectDepth(value as Record<string, unknown>);
      if (depth > 5) {
        throw McpErrorFactory.invalidParams(
          `Parameter "${key}" is too deeply nested (max depth: 5)`,
          { parameter: key, maxDepth: 5 }
        );
      }
    }
  }
}

/**
 * Calculate the nesting depth of an object
 */
function getObjectDepth(obj: Record<string, unknown>, current = 0): number {
  if (current > 5) return current; // Short-circuit
  let maxDepth = current;
  for (const val of Object.values(obj)) {
    if (typeof val === 'object' && val !== null) {
      maxDepth = Math.max(maxDepth, getObjectDepth(val as Record<string, unknown>, current + 1));
    }
  }
  return maxDepth;
}

/**
 * Sanitize error messages before returning to clients.
 * Removes potentially sensitive information like file paths, credentials, and stack traces.
 */
export function sanitizeError(message: string): string {
  return message
    // Remove absolute file paths (Unix: /home/..., /var/..., macOS: /Users/...)
    .replace(/\/(Users|home|var|tmp|etc|usr|opt)\/[\w\-./]+/gi, '[path]')
    // Remove Windows paths
    .replace(/[A-Z]:\\[\w\-\\./]+/gi, '[path]')
    // Remove credentials in URLs (user:pass@host)
    .replace(/(https?:\/\/)[^:]+:[^@]+@/g, '$1[redacted]@')
    // Remove stack traces (at Function.name (file:line:col))
    .replace(/\s+at\s+.+\(.+:\d+:\d+\)/g, '')
    // Remove Node.js internal paths
    .replace(/\(node:[\w]+:\d+:\d+\)/g, '')
    // Truncate to reasonable length
    .slice(0, 500)
    .trim();
}

/**
 * Token bucket rate limiter to prevent API abuse.
 * Throttles requests to a configurable rate per minute.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.refillRate = requestsPerMinute / 60000;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a token, waiting if necessary.
   * Returns immediately if rate limiting is disabled (maxTokens = 0).
   */
  async acquire(): Promise<void> {
    if (this.maxTokens === 0) return; // Disabled
    this.refill();
    if (this.tokens < 1) {
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

/**
 * Check if a value is a valid positive integer ID
 */
export function isValidId(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER;
  }
  if (typeof value === 'string') {
    const num = parseInt(value, 10);
    return !isNaN(num) && num >= 1 && num <= Number.MAX_SAFE_INTEGER;
  }
  return false;
}
