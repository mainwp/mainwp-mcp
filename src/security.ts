/**
 * Security Utilities
 *
 * Shared security functions for input validation, error sanitization,
 * and rate limiting.
 */

import { McpErrorFactory } from './errors.js';

// Input validation limits
const MAX_STRING_LENGTH = 10000;
const MAX_ARRAY_ELEMENTS = 1000;
const MAX_OBJECT_DEPTH = 5;

/**
 * Validate input arguments before forwarding to the API.
 * Prevents malicious payloads and enforces reasonable limits.
 * Recurses into nested objects and arrays to enforce string length and ID range checks.
 * Throws McpError with INVALID_PARAMS code on validation failure.
 */
export function validateInput(args: Record<string, unknown>, depth = 0): void {
  if (depth > MAX_OBJECT_DEPTH) {
    throw McpErrorFactory.invalidParams(
      `Input exceeds maximum nesting depth (${MAX_OBJECT_DEPTH})`,
      { maxDepth: MAX_OBJECT_DEPTH }
    );
  }

  for (const [key, value] of Object.entries(args)) {
    // String length check
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      throw McpErrorFactory.invalidParams(
        `Parameter "${key}" exceeds maximum length (${MAX_STRING_LENGTH} characters)`,
        { parameter: key, maxLength: MAX_STRING_LENGTH }
      );
    }

    // ID fields: accept number or numeric string, must be positive integer
    if (key.endsWith('_id')) {
      const numValue = typeof value === 'string' ? parseInt(value, 10) : value;
      if (typeof numValue === 'number') {
        if (!Number.isInteger(numValue) || numValue < 1 || numValue > Number.MAX_SAFE_INTEGER) {
          throw McpErrorFactory.invalidParams(`Parameter "${key}" must be a positive integer`, {
            parameter: key,
          });
        }
      }
    }

    // Plural ID fields (e.g., site_ids): validate each element is a valid positive integer
    if (key.endsWith('_ids') && Array.isArray(value)) {
      for (const item of value) {
        const numItem = typeof item === 'string' ? parseInt(item, 10) : item;
        if (typeof numItem === 'number') {
          if (!Number.isInteger(numItem) || numItem < 1 || numItem > Number.MAX_SAFE_INTEGER) {
            throw McpErrorFactory.invalidParams(`Element in "${key}" must be a positive integer`, {
              parameter: key,
            });
          }
        }
      }
    }

    // Array validation
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ELEMENTS) {
        throw McpErrorFactory.invalidParams(
          `Parameter "${key}" has too many elements (max ${MAX_ARRAY_ELEMENTS})`,
          { parameter: key, maxElements: MAX_ARRAY_ELEMENTS, actualElements: value.length }
        );
      }
      // Validate array elements (strings and nested objects)
      for (const item of value) {
        if (typeof item === 'string' && item.length > MAX_STRING_LENGTH) {
          throw McpErrorFactory.invalidParams(
            `Element in "${key}" exceeds maximum length (${MAX_STRING_LENGTH} characters)`,
            { parameter: key, maxLength: MAX_STRING_LENGTH }
          );
        }
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          validateInput(item as Record<string, unknown>, depth + 1);
        }
      }
    }

    // Nested object: recurse to validate contents (string lengths, ID ranges, depth)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      validateInput(value as Record<string, unknown>, depth + 1);
    }
  }
}

/**
 * Sanitize error messages before returning to clients.
 * Removes potentially sensitive information like file paths, credentials, and stack traces.
 */
export function sanitizeError(message: string): string {
  return (
    message
      // Remove absolute file paths (Unix: /home/..., /var/..., macOS: /Users/...)
      .replace(/\/(Users|home|var|tmp|etc|usr|opt)\/[\w\-./]+/gi, '[path]')
      // Remove Windows paths
      .replace(/[A-Z]:\\[\w\-\\./]+/gi, '[path]')
      // Remove credentials in URLs (user:pass@host)
      .replace(/(https?:\/\/)[^:]+:[^@]+@/g, '$1[redacted]@')
      // Remove Bearer tokens (Authorization: Bearer xxx)
      .replace(/Bearer\s+[\w\-._~+/]+=*/gi, 'Bearer [redacted]')
      // Remove potential tokens/keys in key=value patterns (handles quoted values with spaces)
      // Matches: TOKEN=xxx, _TOKEN=xxx, MAINWP_TOKEN=xxx, password: "xxx", etc.
      .replace(
        /\b(\w*(?:token|password|secret|key|auth|credential))[=:]\s*"[^"]*"/gi,
        '$1=[redacted]'
      )
      .replace(
        /\b(\w*(?:token|password|secret|key|auth|credential))[=:]\s*'[^']*'/gi,
        '$1=[redacted]'
      )
      .replace(
        /\b(\w*(?:token|password|secret|key|auth|credential))[=:]\s*[\w\-._~+/]+=*/gi,
        '$1=[redacted]'
      )
      // Remove stack traces (at Function.name (file:line:col))
      .replace(/\s+at\s+.+\(.+:\d+:\d+\)/g, '')
      // Remove Node.js internal paths
      .replace(/\(node:[\w]+:\d+:\d+\)/g, '')
      // Truncate to reasonable length
      .slice(0, 500)
      .trim()
  );
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
   * @param signal - Optional AbortSignal to cancel the wait
   * @param maxWaitMs - Maximum time to wait for a token (default: 30000ms).
   *   Prevents indefinite blocking when the rate limit is very low.
   */
  async acquire(signal?: AbortSignal, maxWaitMs = 30000): Promise<void> {
    if (this.maxTokens === 0) return; // Disabled
    this.refill();
    if (this.tokens < 1) {
      if (signal?.aborted) {
        throw new Error('Rate limiter acquire aborted');
      }
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
      if (waitTime > maxWaitMs) {
        throw new Error(`Rate limit wait time (${waitTime}ms) exceeds maximum (${maxWaitMs}ms)`);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, waitTime);
        const onAbort = () => {
          clearTimeout(timer);
          cleanup();
          reject(new Error('Rate limiter acquire aborted'));
        };
        const cleanup = () => {
          signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
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
