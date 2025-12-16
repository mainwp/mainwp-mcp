/**
 * Tests for retry logic module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, isRetryableError, calculateBackoff, type RetryContext } from './retry.js';
import type { Logger } from './logging.js';

describe('isRetryableError', () => {
  describe('HTTP status codes', () => {
    it('returns true for HTTP 500', () => {
      const error = new Error('HTTP 500 Internal Server Error');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for HTTP 502', () => {
      const error = new Error('Failed to fetch: 502 Bad Gateway');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for HTTP 503', () => {
      const error = new Error('HTTP 503 Service Unavailable');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for HTTP 504', () => {
      const error = new Error('Gateway Timeout: 504');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for HTTP 429', () => {
      const error = new Error('Rate limited: 429 Too Many Requests');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns false for HTTP 400', () => {
      const error = new Error('Bad Request: 400');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for HTTP 401', () => {
      const error = new Error('Unauthorized: 401');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for HTTP 403', () => {
      const error = new Error('Forbidden: 403');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for HTTP 404', () => {
      const error = new Error('Not Found: 404');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for HTTP 422', () => {
      const error = new Error('Unprocessable Entity: 422');
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('network error codes', () => {
    it('returns true for ECONNRESET', () => {
      const error = new Error('Connection reset: ECONNRESET');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for ECONNREFUSED', () => {
      const error = new Error('ECONNREFUSED: Connection refused');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for ETIMEDOUT', () => {
      const error = new Error('Request timed out: ETIMEDOUT');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for ENOTFOUND', () => {
      const error = new Error('DNS lookup failed: ENOTFOUND');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for error object with code property', () => {
      const error = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for timeout error with ETIMEDOUT code (from createFetch)', () => {
      // This simulates the error created by createFetch when AbortController times out
      const error = Object.assign(new Error('Request timeout after 30000ms: https://example.com'), {
        code: 'ETIMEDOUT',
      });
      expect(isRetryableError(error)).toBe(true);
    });
  });

  describe('abort errors', () => {
    it('returns false for AbortError', () => {
      const error = new DOMException('The operation was aborted', 'AbortError');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for error with AbortError name', () => {
      const error = new Error('Operation aborted');
      error.name = 'AbortError';
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('error objects with status property', () => {
    it('returns true for object with status 503', () => {
      const error = { status: 503, message: 'Service Unavailable' };
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns false for object with status 404', () => {
      const error = { status: 404, message: 'Not Found' };
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('unknown errors', () => {
    it('returns false for generic error without status', () => {
      const error = new Error('Something went wrong');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isRetryableError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isRetryableError(undefined)).toBe(false);
    });

    it('returns false for string', () => {
      expect(isRetryableError('error string')).toBe(false);
    });
  });
});

describe('calculateBackoff', () => {
  it('returns value between baseDelay and baseDelay*2 for first retry (attempt 0)', () => {
    const baseDelay = 1000;
    const maxDelay = 10000;

    // Run multiple times to verify jitter adds randomness
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const result = calculateBackoff(0, baseDelay, maxDelay);
      results.add(Math.round(result));

      // First retry: baseDelay * 2^0 + jitter = baseDelay + jitter
      // Result should be between baseDelay and baseDelay * 2
      expect(result).toBeGreaterThanOrEqual(baseDelay);
      expect(result).toBeLessThanOrEqual(baseDelay * 2);
    }

    // Verify jitter adds randomness (should have multiple distinct values)
    expect(results.size).toBeGreaterThan(1);
  });

  it('returns value between baseDelay*2 and baseDelay*4 for second retry (attempt 1)', () => {
    const baseDelay = 1000;
    const maxDelay = 10000;

    for (let i = 0; i < 10; i++) {
      const result = calculateBackoff(1, baseDelay, maxDelay);

      // Second retry: baseDelay * 2^1 + jitter = baseDelay * 2 + jitter
      // Result should be between baseDelay * 2 and baseDelay * 3
      expect(result).toBeGreaterThanOrEqual(baseDelay * 2);
      expect(result).toBeLessThanOrEqual(baseDelay * 3);
    }
  });

  it('caps delay at maxDelay', () => {
    const baseDelay = 1000;
    const maxDelay = 2000;

    // For attempt 5: baseDelay * 2^5 = 32000, which exceeds maxDelay
    for (let i = 0; i < 10; i++) {
      const result = calculateBackoff(5, baseDelay, maxDelay);
      expect(result).toBeLessThanOrEqual(maxDelay);
    }
  });

  it('handles very small delays', () => {
    const result = calculateBackoff(0, 10, 100);
    expect(result).toBeGreaterThanOrEqual(10);
    expect(result).toBeLessThanOrEqual(20);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result immediately on first success', async () => {
    const operation = vi.fn((_ctx: RetryContext) => Promise.resolve('success'));

    const result = await withRetry(operation, {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 2000,
      timeoutBudget: 10000,
    });

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
    // Verify context was passed
    expect(operation).toHaveBeenCalledWith(
      expect.objectContaining({
        remainingBudget: expect.any(Number),
        attempt: 0,
      })
    );
  });

  it('retries on retryable error and succeeds', async () => {
    let attempts = 0;
    const operation = vi.fn(async (_ctx: RetryContext) => {
      attempts++;
      if (attempts < 2) {
        throw new Error('HTTP 503 Service Unavailable');
      }
      return 'success';
    });

    const mockLogger = {
      warning: vi.fn(),
    } as unknown as Logger;

    // Run the retry operation while advancing timers
    let result: string | undefined;
    const promise = withRetry(operation, {
      maxRetries: 3,
      baseDelay: 100, // Use shorter delays for testing
      maxDelay: 200,
      timeoutBudget: 10000,
      logger: mockLogger,
    }).then(r => {
      result = r;
    });

    // Advance time and run pending tasks
    await vi.runAllTimersAsync();
    await promise;

    expect(result).toBe('success');
    expect(attempts).toBe(2);
    expect(mockLogger.warning).toHaveBeenCalledTimes(1);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Retrying request after transient error',
      expect.objectContaining({
        attempt: 1,
        error: 'HTTP 503 Service Unavailable',
      })
    );
  });

  it('throws immediately on non-retryable error', async () => {
    const operation = vi.fn((_ctx: RetryContext) =>
      Promise.reject(new Error('HTTP 404 Not Found'))
    );

    await expect(
      withRetry(operation, {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 2000,
        timeoutBudget: 10000,
      })
    ).rejects.toThrow('HTTP 404 Not Found');

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    const operation = vi.fn((_ctx: RetryContext) =>
      Promise.reject(new Error('HTTP 503 Service Unavailable'))
    );

    const promise = withRetry(operation, {
      maxRetries: 2,
      baseDelay: 100,
      maxDelay: 200,
      timeoutBudget: 10000,
    });

    // Attach rejection handler immediately to prevent unhandled rejection warning
    const errorCapture = promise.catch((e: Error) => e);

    // Run all timers and pending tasks
    await vi.runAllTimersAsync();

    const error = (await errorCapture) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('HTTP 503 Service Unavailable');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('throws when timeout budget would be exceeded', async () => {
    // First call will fail, then backoff would exceed remaining budget
    const operation = vi.fn((_ctx: RetryContext) =>
      Promise.reject(new Error('HTTP 503 Service Unavailable'))
    );

    // Use a very short timeout budget
    const promise = withRetry(operation, {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 2000,
      timeoutBudget: 500, // Very short budget
    });

    // Attach rejection handler immediately to prevent unhandled rejection warning
    const errorCapture = promise.catch((e: Error) => e);

    // Run all timers - should throw because backoff (1000ms+) exceeds remaining budget (500ms)
    await vi.runAllTimersAsync();

    const error = (await errorCapture) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/budget exceeded/i);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on AbortError without retry', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    const operation = vi.fn((_ctx: RetryContext) => Promise.reject(abortError));

    await expect(
      withRetry(operation, {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 2000,
        timeoutBudget: 10000,
      })
    ).rejects.toThrow();

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('logs retry attempts with correct metadata', async () => {
    let attempts = 0;
    const operation = vi.fn(async (_ctx: RetryContext) => {
      attempts++;
      if (attempts < 3) {
        throw new Error('HTTP 500 Internal Server Error');
      }
      return 'success';
    });

    const mockLogger = {
      warning: vi.fn(),
    } as unknown as Logger;

    const promise = withRetry(operation, {
      maxRetries: 5,
      baseDelay: 100,
      maxDelay: 200,
      timeoutBudget: 10000,
      logger: mockLogger,
    });

    // Run all timers
    await vi.runAllTimersAsync();

    await promise;

    expect(mockLogger.warning).toHaveBeenCalledTimes(2);

    // Check first retry log
    expect(mockLogger.warning).toHaveBeenNthCalledWith(
      1,
      'Retrying request after transient error',
      expect.objectContaining({
        attempt: 1,
        error: 'HTTP 500 Internal Server Error',
      })
    );

    // Check second retry log
    expect(mockLogger.warning).toHaveBeenNthCalledWith(
      2,
      'Retrying request after transient error',
      expect.objectContaining({
        attempt: 2,
        error: 'HTTP 500 Internal Server Error',
      })
    );
  });

  it('works without a logger', async () => {
    let attempts = 0;
    const operation = vi.fn(async (_ctx: RetryContext) => {
      attempts++;
      if (attempts < 2) {
        throw new Error('HTTP 503 Service Unavailable');
      }
      return 'success';
    });

    const promise = withRetry(operation, {
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 200,
      timeoutBudget: 10000,
      // No logger provided
    });

    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('handles maxRetries of 1 (no retries)', async () => {
    const operation = vi.fn((_ctx: RetryContext) =>
      Promise.reject(new Error('HTTP 503 Service Unavailable'))
    );

    await expect(
      withRetry(operation, {
        maxRetries: 1,
        baseDelay: 1000,
        maxDelay: 2000,
        timeoutBudget: 10000,
      })
    ).rejects.toThrow('HTTP 503 Service Unavailable');

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('preserves error cause when timeout budget exceeded', async () => {
    const originalError = new Error('HTTP 503 Service Unavailable');
    const operation = vi.fn((_ctx: RetryContext) => Promise.reject(originalError));

    const promise = withRetry(operation, {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 2000,
      timeoutBudget: 100, // Very short
    });

    try {
      await promise;
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/budget exceeded/i);
      expect((error as Error & { cause?: Error }).cause).toBe(originalError);
    }
  });

  it('passes decreasing remaining budget on each attempt', async () => {
    const receivedBudgets: number[] = [];
    let attempts = 0;

    const operation = vi.fn(async (ctx: RetryContext) => {
      receivedBudgets.push(ctx.remainingBudget);
      attempts++;
      if (attempts < 3) {
        throw new Error('HTTP 503 Service Unavailable');
      }
      return 'success';
    });

    const promise = withRetry(operation, {
      maxRetries: 5,
      baseDelay: 100,
      maxDelay: 200,
      timeoutBudget: 10000,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Each subsequent attempt should have a lower remaining budget
    expect(receivedBudgets.length).toBe(3);
    expect(receivedBudgets[0]).toBeGreaterThan(receivedBudgets[1]);
    expect(receivedBudgets[1]).toBeGreaterThan(receivedBudgets[2]);
  });

  it('retries on error with status property set to 503', async () => {
    let attempts = 0;
    const operation = vi.fn(async (_ctx: RetryContext) => {
      attempts++;
      if (attempts < 2) {
        const error = new Error('Service Unavailable');
        (error as Error & { status: number }).status = 503;
        throw error;
      }
      return 'success';
    });

    const promise = withRetry(operation, {
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 200,
      timeoutBudget: 10000,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('retries on error with status property set to 429', async () => {
    let attempts = 0;
    const operation = vi.fn(async (_ctx: RetryContext) => {
      attempts++;
      if (attempts < 2) {
        const error = new Error('Too Many Requests');
        (error as Error & { status: number }).status = 429;
        throw error;
      }
      return 'success';
    });

    const promise = withRetry(operation, {
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 200,
      timeoutBudget: 10000,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });
});
