/**
 * HTTP Client Infrastructure
 *
 * Fetch wrapper with timeout, TLS bypass, response size enforcement,
 * and WP REST API pagination. Transport-level utilities with no domain knowledge.
 */

import { Agent as UndiciAgent } from 'undici';
import { Config, getAuthHeaders } from './config.js';
import { createHttpError } from './errors.js';
import { sanitizeError } from './security.js';
import type { Logger } from './logging.js';

/** Maximum size for error response bodies (64KB) — prevents transient memory spikes */
export const MAX_ERROR_BODY_BYTES = 65536;

/** Maximum URL length for GET/DELETE requests — most HTTP servers reject URLs > 8KB */
export const MAX_URL_LENGTH = 8000;

/** Maximum number of pages to fetch during pagination — prevents unbounded requests */
const MAX_PAGES = 50;

interface ResponseDeadline {
  timeoutId?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  effectiveTimeout: number;
  url: string;
  externalSignal?: AbortSignal;
  externalAbortHandler?: () => void;
}

const responseDeadlines = new WeakMap<Response, ResponseDeadline>();

function clearResponseDeadline(deadline: ResponseDeadline): void {
  if (deadline.timeoutId) {
    clearTimeout(deadline.timeoutId);
  }
  if (deadline.externalSignal && deadline.externalAbortHandler) {
    deadline.externalSignal.removeEventListener('abort', deadline.externalAbortHandler);
  }
}

function createTimeoutError(deadline: Pick<ResponseDeadline, 'effectiveTimeout' | 'url'>): Error {
  const error = new Error(`Request timeout after ${deadline.effectiveTimeout}ms: ${deadline.url}`);
  (error as Error & { code: string }).code = 'ETIMEDOUT';
  return error;
}

/**
 * Per-request undici dispatcher that skips TLS certificate verification.
 * Created lazily on first use — avoids process-global NODE_TLS_REJECT_UNAUTHORIZED.
 */
let unsafeDispatcher: UndiciAgent | null = null;

function getUnsafeDispatcher(): UndiciAgent {
  if (!unsafeDispatcher) {
    unsafeDispatcher = new UndiciAgent({
      connect: { rejectUnauthorized: false },
    });
  }
  return unsafeDispatcher;
}

/**
 * Create a fetch function that handles SSL verification, request timeout, and response size limits.
 * Wraps any caller-provided AbortSignal to enforce timeout while preserving external cancellation.
 *
 * @param config - Server configuration
 * @param perCallTimeout - Optional per-call timeout override (for retry budget enforcement)
 */
export function createFetch(config: Config, perCallTimeout?: number) {
  const effectiveTimeout = perCallTimeout ?? config.requestTimeout;

  return async (url: string, options: RequestInit = {}): Promise<Response> => {
    const controller = new AbortController();
    const deadline: ResponseDeadline = {
      timedOut: false,
      effectiveTimeout,
      url,
    };
    deadline.timeoutId = setTimeout(() => {
      deadline.timedOut = true;
      controller.abort();
    }, effectiveTimeout);

    // Forward external signal abort to our controller (preserves caller cancellation)
    const externalSignal = options.signal;
    if (externalSignal) {
      deadline.externalSignal = externalSignal;
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        deadline.externalAbortHandler = () => controller.abort();
        externalSignal.addEventListener('abort', deadline.externalAbortHandler, { once: true });
      }
    }

    try {
      const fetchOptions: Record<string, unknown> = {
        ...options,
        signal: controller.signal,
        headers: {
          ...getAuthHeaders(config),
          ...options.headers,
        },
      };

      // Per-request TLS bypass via undici dispatcher — avoids process-global
      // NODE_TLS_REJECT_UNAUTHORIZED which would disable TLS for all connections
      if (config.skipSslVerify) {
        fetchOptions.dispatcher = getUnsafeDispatcher();
      }

      const response = await fetch(url, fetchOptions as RequestInit);

      // Check response size before parsing (if content-length is provided)
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (size > config.maxResponseSize) {
          throw new Error(
            `Response size ${size} bytes exceeds maximum allowed ${config.maxResponseSize} bytes`
          );
        }
      }

      responseDeadlines.set(response, deadline);
      return response;
    } catch (error) {
      clearResponseDeadline(deadline);
      if ((error as Error).name === 'AbortError' && deadline.timedOut) {
        throw createTimeoutError(deadline);
      }
      throw error;
    }
  };
}

/**
 * Read a response body with streaming size enforcement.
 * Prevents unbounded memory consumption from chunked responses without Content-Length.
 *
 * The fallback path (no ReadableStream) buffers the full body before checking size.
 * In production Node.js 18+, fetch responses always have a ReadableStream body,
 * so the fallback only executes in test mocks with minimal Response objects.
 *
 * @internal Exported for testing
 * @param response - The HTTP response to read
 * @param maxBytes - Maximum allowed body size in bytes
 * @returns The response body as a string
 */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const deadline = responseDeadlines.get(response);
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      // Fallback for test mocks without ReadableStream body
      let text: string;
      if (typeof response.text === 'function') {
        text = await response.text();
      } else {
        // Last resort: json() + stringify (handles minimal mock objects)
        text = JSON.stringify(await response.json());
      }
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error(`Response body exceeds ${maxBytes} bytes limit`);
      }
      return text;
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // Fire-and-forget: a rejected cancel() must not race the throw below
        void reader.cancel().catch(() => {});
        throw new Error(`Response body exceeds ${maxBytes} bytes limit`);
      }
      chunks.push(value);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch (error) {
    if (deadline?.timedOut) {
      throw createTimeoutError(deadline);
    }
    throw error;
  } finally {
    if (deadline) {
      clearResponseDeadline(deadline);
      responseDeadlines.delete(response);
    }
  }
}

/**
 * Paginate through a WP REST API collection endpoint.
 * Fetches pages sequentially until X-WP-TotalPages is reached or MAX_PAGES cap hit.
 */
export async function paginateApi<T>(
  customFetch: (url: string, options?: RequestInit) => Promise<Response>,
  endpoint: string,
  label: string,
  maxResponseSize: number,
  logger?: Logger
): Promise<T[]> {
  let page = 1;
  let capped = false;
  const allItems: T[] = [];

  while (true) {
    const response = await customFetch(`${endpoint}?per_page=100&page=${page}`);

    if (!response.ok) {
      const errorText = await readLimitedBody(response, MAX_ERROR_BODY_BYTES);
      throw createHttpError(
        response.status,
        String(response.status),
        `Failed to fetch ${label}: ${response.status} ${response.statusText} - ${sanitizeError(errorText)}`
      );
    }

    const body = await readLimitedBody(response, maxResponseSize);
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Expected JSON array from ${label} endpoint (page ${page}), got ${typeof parsed}`
      );
    }
    const batch = parsed as T[];
    allItems.push(...batch);

    const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1', 10);
    if (page >= totalPages) break;
    if (page >= MAX_PAGES) {
      capped = true;
      break;
    }
    page++;
  }

  if (capped) {
    logger?.warning(
      `Pagination capped at ${MAX_PAGES} pages (fetched ${allItems.length} ${label}) — some may be missing`
    );
  } else if (page > 1) {
    logger?.info(`Fetched ${allItems.length} ${label} across ${page} pages`);
  }

  return allItems;
}
