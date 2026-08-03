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

// Upper bound on the string sanitizeError runs its regexes over. Error bodies
// forwarded here are untrusted and can be up to MAX_ERROR_BODY_BYTES (64KB);
// capping the working string first keeps every replace() linear-bounded and
// prevents a hostile body from stalling the event loop. It is a generous
// multiple of the final 500-char output cap, so redaction of any realistic
// message is byte-identical — only pathological, far-oversized bodies are
// clipped, and clipping can only remove content, never expose a secret.
const MAX_SANITIZE_INPUT_LENGTH = 2000;

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
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw McpErrorFactory.invalidParams(
          `Parameter "${key}" must be a string or number, got ${typeof value}`,
          { parameter: key }
        );
      }
      if (!isValidId(value)) {
        throw McpErrorFactory.invalidParams(`Parameter "${key}" must be a positive integer`, {
          parameter: key,
        });
      }
    }

    // Plural ID fields (e.g., site_ids): must be an array of valid positive integers
    if (key.endsWith('_ids')) {
      if (!Array.isArray(value)) {
        throw McpErrorFactory.invalidParams(`"${key}" must be an array`, { parameter: key });
      }
      for (const item of value) {
        if (typeof item !== 'string' && typeof item !== 'number') {
          throw McpErrorFactory.invalidParams(
            `Element in "${key}" must be a string or number, got ${typeof item}`,
            { parameter: key }
          );
        }
        if (!isValidId(item)) {
          throw McpErrorFactory.invalidParams(`Element in "${key}" must be a positive integer`, {
            parameter: key,
          });
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
  // Bound the working string before any regex runs. The input can be a 64KB
  // remote error body; without this cap the stack-trace pattern below (and the
  // other backtracking-capable patterns) could be driven into pathological,
  // event-loop-blocking backtracking by a hostile body.
  const bounded =
    message.length > MAX_SANITIZE_INPUT_LENGTH
      ? message.slice(0, MAX_SANITIZE_INPUT_LENGTH)
      : message;
  return (
    bounded
      // Remove absolute file paths (Unix: /home/..., /var/..., macOS: /Users/...)
      .replace(/\/(Users|home|var|tmp|etc|usr|opt)\/[\w\-./]+/gi, '[path]')
      // Remove Windows paths
      .replace(/[A-Z]:\\[\w\-\\./]+/gi, '[path]')
      // Remove credentials in URLs (user:pass@host)
      .replace(/(https?:\/\/)[^:]+:[^@]+@/g, '$1[redacted]@')
      // Remove Bearer tokens (Authorization: Bearer xxx)
      .replace(/Bearer\s+[\w\-._~+/]+=*/gi, 'Bearer [redacted]')
      // Remove HTTP Basic credentials (Authorization: Basic base64(user:appPassword)).
      // This is the scheme the server itself sends by default (see getAuthHeaders in
      // config.ts). The base64 blob never contains spaces, so a bounded base64 class
      // covers the whole credential; the {16,} floor keeps ordinary "Basic <word>"
      // prose (e.g. "Basic authentication") out of the match while every real
      // credential (base64 of user:app-password) is far longer.
      .replace(/\bBasic\s+[A-Za-z0-9+/=]{16,}/gi, 'Basic [redacted]')
      // Redact any Authorization header value to end-of-line. Covers dumped headers
      // where the scheme token varies or the raw value carries internal spaces, e.g.
      // "Authorization: Basic xxx", "Proxy-Authorization: ...", and PHP $_SERVER dumps
      // like "HTTP_AUTHORIZATION => Basic xxx". Redacting to EOL (not to the first
      // space) prevents leaking a spaced WordPress application password.
      // The optional quote after the name (and before the value) keeps JSON bodies
      // like {"Authorization":"Digest ..."} inside the match; remote errors are
      // commonly JSON and the closing quote would otherwise split name from ':'.
      .replace(
        /\b((?:HTTP_)?(?:Proxy-)?Authorization)\b["']?\s*(?::|=>|=)\s*["']?\S[^\r\n]*/gi,
        '$1: [redacted]'
      )
      // Remove potential tokens/keys in key=value patterns (handles quoted values with spaces)
      // Matches: TOKEN=xxx, MAINWP_TOKEN=xxx, password: "xxx", and JSON forms like
      // "appPassword":"xxx" - the optional quote between key and separator is what
      // keeps quoted JSON keys from dodging every rule in this group.
      .replace(
        /\b(\w*(?:token|password|secret|key|auth|credential))["']?\s*[=:]\s*"[^"]*"/gi,
        '$1=[redacted]'
      )
      .replace(
        /\b(\w*(?:token|password|secret|key|auth|credential))["']?\s*[=:]\s*'[^']*'/gi,
        '$1=[redacted]'
      )
      // Known secret key followed by an unquoted WordPress application-password value
      // (displayed as six space-separated groups of 4). The repetition is 1-5 groups
      // and the last group tolerates 1-3 chars because the input cap above can cut
      // the value mid-group; an exact six-group form would leak the surviving tail.
      // Over-redacting a following short word is accepted. Must run before the
      // generic unquoted rule below, which stops at the first space.
      .replace(
        /\b(\w*(?:token|password|secret|key|auth|credential))["']?\s*[=:]\s*[A-Za-z0-9]{4}(?:\s[A-Za-z0-9]{1,4}){1,5}/gi,
        '$1=[redacted]'
      )
      .replace(
        /\b(\w*(?:token|password|secret|key|auth|credential))["']?\s*[=:]\s*[\w\-._~+/]+=*/gi,
        '$1=[redacted]'
      )
      // Remove stack traces (at Function.name (file:line:col)).
      // Character classes that exclude '(' , ')' and newline replace the two
      // adjacent greedy `.+` groups, so the '(' delimiter splits the match
      // deterministically and the pattern runs in linear time (no quadratic
      // backtracking on inputs full of '(').
      .replace(/\s+at\s+[^()\n]+\([^()\n]*:\d+:\d+\)/g, '')
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
    // Decimal digits only — Number() alone would also accept "1e3", "0x10",
    // "+7", and " 8 ", where local validation and upstream interpretation of
    // the raw forwarded string can disagree.
    if (!/^\d+$/.test(value)) {
      return false;
    }
    const num = Number(value);
    return Number.isSafeInteger(num) && num >= 1;
  }
  return false;
}
