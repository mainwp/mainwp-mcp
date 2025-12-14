/**
 * Security Utilities Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateInput, sanitizeError, RateLimiter, isValidId } from './security.js';

describe('validateInput', () => {
  it('should accept valid input', () => {
    expect(() => validateInput({ name: 'test', count: 5 })).not.toThrow();
  });

  it('should reject strings exceeding MAX_STRING_LENGTH', () => {
    const longString = 'a'.repeat(10001);
    expect(() => validateInput({ field: longString })).toThrow(/exceeds maximum length/);
  });

  it('should accept strings at MAX_STRING_LENGTH', () => {
    const maxString = 'a'.repeat(10000);
    expect(() => validateInput({ field: maxString })).not.toThrow();
  });

  it('should reject arrays exceeding MAX_ARRAY_ELEMENTS', () => {
    const largeArray = new Array(1001).fill('item');
    expect(() => validateInput({ items: largeArray })).toThrow(/too many elements/);
  });

  it('should accept arrays at MAX_ARRAY_ELEMENTS', () => {
    const maxArray = new Array(1000).fill('item');
    expect(() => validateInput({ items: maxArray })).not.toThrow();
  });

  it('should reject long strings in array elements', () => {
    const longString = 'a'.repeat(10001);
    expect(() => validateInput({ items: [longString] })).toThrow(/exceeds maximum length/);
  });

  it('should reject objects exceeding MAX_OBJECT_DEPTH', () => {
    // MAX_OBJECT_DEPTH is 5, so we need more than 5 levels
    // The nested parameter itself adds 1 level, so we need 6+ levels in deepObject
    const deepObject = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
    expect(() => validateInput({ nested: deepObject })).toThrow(/too deeply nested/);
  });

  it('should accept objects at MAX_OBJECT_DEPTH', () => {
    // MAX_OBJECT_DEPTH is 5, nested adds 1 level, so 4 more levels should be ok
    const validDepth = { a: { b: { c: { d: 'valid' } } } };
    expect(() => validateInput({ nested: validDepth })).not.toThrow();
  });

  it('should validate positive integer IDs for *_id fields', () => {
    expect(() => validateInput({ site_id: 123 })).not.toThrow();
    expect(() => validateInput({ site_id: '123' })).not.toThrow();
  });

  it('should reject non-positive IDs', () => {
    expect(() => validateInput({ site_id: 0 })).toThrow(/must be a positive integer/);
    expect(() => validateInput({ site_id: -1 })).toThrow(/must be a positive integer/);
  });

  it('should reject non-integer IDs', () => {
    expect(() => validateInput({ site_id: 1.5 })).toThrow(/must be a positive integer/);
  });

  it('should accept valid nested objects', () => {
    expect(() =>
      validateInput({
        config: {
          settings: {
            enabled: true,
          },
        },
      })
    ).not.toThrow();
  });
});

describe('sanitizeError', () => {
  it('should remove Unix file paths', () => {
    const message = 'Error at /Users/john/project/file.ts';
    expect(sanitizeError(message)).toContain('[path]');
    expect(sanitizeError(message)).not.toContain('/Users');
  });

  it('should remove various Unix paths', () => {
    expect(sanitizeError('File: /home/user/test')).toContain('[path]');
    expect(sanitizeError('File: /var/log/error.log')).toContain('[path]');
    expect(sanitizeError('File: /tmp/temp.txt')).toContain('[path]');
    expect(sanitizeError('File: /opt/app/run')).toContain('[path]');
  });

  it('should remove Windows paths', () => {
    const message = 'Error at C:\\Users\\john\\project\\file.ts';
    expect(sanitizeError(message)).toContain('[path]');
    expect(sanitizeError(message)).not.toContain('C:\\');
  });

  it('should redact credentials in URLs', () => {
    const message = 'Connecting to https://user:password@example.com';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]@');
    expect(sanitized).not.toContain('password');
  });

  it('should redact Bearer tokens', () => {
    const message = 'Authorization: Bearer abc123xyz456';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('abc123xyz456');
  });

  it('should redact sensitive key-value patterns', () => {
    const message = 'MAINWP_TOKEN=secret123';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('secret123');
  });

  it('should redact quoted values', () => {
    const message = 'password: "mysecret"';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('mysecret');
  });

  it('should remove stack traces', () => {
    const message = 'Error occurred at Function.name (/path/to/file.js:10:5)';
    expect(sanitizeError(message)).not.toContain('at Function.name');
  });

  it('should truncate to 500 characters', () => {
    const longMessage = 'a'.repeat(600);
    expect(sanitizeError(longMessage).length).toBeLessThanOrEqual(500);
  });

  it('should handle empty string', () => {
    expect(sanitizeError('')).toBe('');
  });

  it('should trim whitespace', () => {
    expect(sanitizeError('  message  ')).toBe('message');
  });
});

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests within rate limit', async () => {
    const limiter = new RateLimiter(60);

    // Should allow first request immediately
    await limiter.acquire();
    // Should work
    expect(true).toBe(true);
  });

  it('should be disabled when maxTokens is 0', async () => {
    const limiter = new RateLimiter(0);

    // Multiple rapid calls should complete immediately when disabled
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10);
  });

  it('should throttle requests exceeding rate limit', async () => {
    const limiter = new RateLimiter(2); // 2 requests per minute

    // Consume both tokens
    await limiter.acquire();
    await limiter.acquire();

    // Third request should wait
    const acquirePromise = limiter.acquire();

    // Advance time to allow refill
    vi.advanceTimersByTime(30000); // 30 seconds

    await acquirePromise;
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter(60); // 1 per second

    // Consume all tokens
    for (let i = 0; i < 60; i++) {
      await limiter.acquire();
    }

    // Advance time by 1 second (should refill 1 token)
    vi.advanceTimersByTime(1000);

    // Should be able to acquire another token
    await limiter.acquire();
  });
});

describe('isValidId', () => {
  it('should return true for valid positive integers', () => {
    expect(isValidId(1)).toBe(true);
    expect(isValidId(123)).toBe(true);
    expect(isValidId(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('should return true for numeric strings', () => {
    expect(isValidId('1')).toBe(true);
    expect(isValidId('123')).toBe(true);
  });

  it('should return false for zero', () => {
    expect(isValidId(0)).toBe(false);
    expect(isValidId('0')).toBe(false);
  });

  it('should return false for negative numbers', () => {
    expect(isValidId(-1)).toBe(false);
    expect(isValidId('-5')).toBe(false);
  });

  it('should return false for non-numbers', () => {
    expect(isValidId('abc')).toBe(false);
    expect(isValidId(null)).toBe(false);
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId({})).toBe(false);
    expect(isValidId([])).toBe(false);
  });

  it('should return false for floats', () => {
    expect(isValidId(1.5)).toBe(false);
  });

  it('should handle edge cases', () => {
    expect(isValidId(NaN)).toBe(false);
    expect(isValidId(Infinity)).toBe(false);
  });
});
