/**
 * Retry Logic for Transient Errors
 *
 * Provides exponential backoff with jitter for handling transient network
 * failures and server errors (HTTP 5xx, 429, network errors).
 *
 * Key features:
 * - Only retries transient errors (5xx, 429, network errors)
 * - Permanent errors (4xx except 429) fail immediately
 * - Timeout budget ensures total time never exceeds requestTimeout
 * - Exponential backoff with jitter prevents thundering herd
 */

import type { Logger } from './logging.js';

/**
 * Options for retry behavior
 */
export interface RetryOptions {
  /** Maximum retry attempts including initial request */
  maxRetries: number;
  /** Base delay between retries in milliseconds */
  baseDelay: number;
  /** Maximum delay between retries in milliseconds */
  maxDelay: number;
  /** Total time budget in milliseconds for all attempts */
  timeoutBudget: number;
  /** Structured logger for retry attempts */
  logger?: Logger;
}

/**
 * Context passed to retryable operations for timeout budget awareness
 */
export interface RetryContext {
  /** Remaining timeout budget in milliseconds for this attempt */
  remainingBudget: number;
  /** Current attempt number (0-indexed) */
  attempt: number;
}

/**
 * A function that returns a promise and can be retried.
 * Optionally receives retry context with remaining timeout budget.
 */
export type RetryableOperation<T> = (context: RetryContext) => Promise<T>;

/**
 * Extract HTTP status code from an error.
 * Handles various error formats including fetch errors and custom error objects.
 */
function extractStatusCode(error: unknown): number | null {
  // Handle error objects with status property
  if (error && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>;

    // Direct status property (e.g., Response object or custom error)
    if (typeof errorObj.status === 'number') {
      return errorObj.status;
    }

    // Status in cause (chained errors)
    if (errorObj.cause && typeof errorObj.cause === 'object') {
      const cause = errorObj.cause as Record<string, unknown>;
      if (typeof cause.status === 'number') {
        return cause.status;
      }
    }
  }

  // Extract from error message patterns
  if (error instanceof Error) {
    const message = error.message;

    // Match patterns like "Failed to fetch: 503" or "HTTP 503"
    const statusMatch = message.match(/\b([45]\d{2})\b/);
    if (statusMatch) {
      return parseInt(statusMatch[1], 10);
    }
  }

  return null;
}

/**
 * Extract error code from an error (e.g., ECONNRESET, ETIMEDOUT)
 */
function extractErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>;

    // Direct code property (Node.js errors)
    if (typeof errorObj.code === 'string') {
      return errorObj.code;
    }

    // Code in cause (chained errors)
    if (errorObj.cause && typeof errorObj.cause === 'object') {
      const cause = errorObj.cause as Record<string, unknown>;
      if (typeof cause.code === 'string') {
        return cause.code;
      }
    }
  }

  // Extract from error message
  if (error instanceof Error) {
    const message = error.message.toUpperCase();

    // Common network error codes
    const networkCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'];
    for (const code of networkCodes) {
      if (message.includes(code)) {
        return code;
      }
    }
  }

  return null;
}

/**
 * Determine if an error is retryable (transient).
 *
 * Retryable errors:
 * - HTTP 5xx (server errors)
 * - HTTP 429 (rate limited)
 * - Network errors: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND
 *
 * Non-retryable errors:
 * - HTTP 4xx (except 429): client errors, auth failures, validation errors
 * - AbortError: user cancellation
 * - Any other errors (treat as permanent)
 */
export function isRetryableError(error: unknown): boolean {
  // AbortError is never retryable (user cancellation)
  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }

  // Check for HTTP status codes
  const statusCode = extractStatusCode(error);
  if (statusCode !== null) {
    // 5xx server errors are retryable
    if (statusCode >= 500 && statusCode <= 599) {
      return true;
    }

    // 429 rate limited is retryable
    if (statusCode === 429) {
      return true;
    }

    // 4xx client errors (except 429) are NOT retryable
    if (statusCode >= 400 && statusCode <= 499) {
      return false;
    }
  }

  // Check for network error codes
  const errorCode = extractErrorCode(error);
  if (errorCode !== null) {
    const retryableCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'];
    if (retryableCodes.includes(errorCode)) {
      return true;
    }
  }

  // Unknown errors are NOT retried (conservative approach)
  return false;
}

/**
 * Calculate exponential backoff delay with jitter.
 *
 * Formula: min(maxDelay, baseDelay * 2^attempt + random(0, baseDelay))
 *
 * @param attempt - 0-indexed attempt number (0 for first retry, 1 for second, etc.)
 * @param baseDelay - Base delay in milliseconds
 * @param maxDelay - Maximum delay in milliseconds
 * @returns Delay in milliseconds
 */
export function calculateBackoff(attempt: number, baseDelay: number, maxDelay: number): number {
  // Exponential: baseDelay * 2^attempt
  const exponentialDelay = baseDelay * Math.pow(2, attempt);

  // Jitter: random value between 0 and baseDelay
  const jitter = Math.random() * baseDelay;

  // Total delay with jitter
  const totalDelay = exponentialDelay + jitter;

  // Cap at maxDelay
  return Math.min(totalDelay, maxDelay);
}

/**
 * Execute an operation with retry logic.
 *
 * @param operation - The async operation to execute
 * @param options - Retry configuration
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted or a non-retryable error occurs
 */
export async function withRetry<T>(
  operation: RetryableOperation<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, baseDelay, maxDelay, timeoutBudget, logger } = options;
  const startTime = Date.now();

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Calculate remaining budget before each attempt
    const elapsed = Date.now() - startTime;
    const remainingBudget = timeoutBudget - elapsed;

    // Check if budget is already exhausted before attempting
    if (remainingBudget <= 0) {
      const budgetError = new Error(
        `Retry timeout budget exhausted: ${Math.round(elapsed)}ms elapsed, budget was ${timeoutBudget}ms`
      );
      if (lastError) {
        (budgetError as Error & { cause?: Error }).cause = lastError;
      }
      throw budgetError;
    }

    try {
      // Pass context with remaining budget so operation can enforce timeout
      return await operation({ remainingBudget, attempt });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (!isRetryableError(error)) {
        throw lastError;
      }

      // Check if this was the last attempt
      if (attempt >= maxRetries - 1) {
        throw lastError;
      }

      // Calculate backoff delay
      const backoffDelay = calculateBackoff(attempt, baseDelay, maxDelay);

      // Re-calculate remaining budget after operation completed
      const elapsedAfterOp = Date.now() - startTime;
      const remainingBudgetAfterOp = timeoutBudget - elapsedAfterOp;

      if (backoffDelay > remainingBudgetAfterOp) {
        // Don't wait for a retry that would exceed the budget
        const budgetError = new Error(
          `Retry timeout budget exceeded: would need ${Math.round(backoffDelay)}ms but only ${Math.round(remainingBudgetAfterOp)}ms remaining`
        );
        // Preserve the original error as the cause
        (budgetError as Error & { cause?: Error }).cause = lastError;
        throw budgetError;
      }

      // Log the retry attempt
      if (logger) {
        logger.warning('Retrying request after transient error', {
          attempt: attempt + 1,
          delay: Math.round(backoffDelay),
          error: lastError.message,
          remainingBudget: Math.round(remainingBudgetAfterOp),
        });
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }

  // Should never reach here, but TypeScript doesn't know that
  throw lastError || new Error('Retry exhausted with no error captured');
}
