/**
 * MainWP Abilities Discovery and Management
 *
 * Fetches and caches ability definitions from the MainWP Dashboard's
 * Abilities API REST endpoints.
 */

import { Config, getAbilitiesApiUrl } from './config.js';
import { McpErrorFactory } from './errors.js';
import { RateLimiter, sanitizeError } from './security.js';
import { withRetry, type RetryContext } from './retry.js';
import {
  createFetch,
  readLimitedBody,
  paginateApi,
  MAX_ERROR_BODY_BYTES,
  MAX_URL_LENGTH,
} from './http-client.js';
import type { Logger } from './logging.js';

/** Maximum age of stale cache before hard-failing (30 minutes) */
const MAX_STALE_AGE_MS = 30 * 60 * 1000;

/** Strict format for ability names — prevents path traversal in URL construction */
const ABILITY_NAME_RE = /^[a-z0-9]+\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Rate limiter instance (initialized via initRateLimiter)
 */
let rateLimiter: RateLimiter | null = null;

/**
 * Initialize the rate limiter with the configured requests per minute.
 * Called once at startup from index.ts.
 */
export function initRateLimiter(requestsPerMinute: number): void {
  rateLimiter = new RateLimiter(requestsPerMinute);
}

/**
 * Ability annotation metadata
 */
export interface AbilityAnnotations {
  instructions?: string;
  readonly: boolean;
  destructive: boolean;
  idempotent: boolean;
}

/**
 * Ability definition from the REST API
 */
export interface Ability {
  name: string;
  label: string;
  description: string;
  category: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  meta?: {
    show_in_rest?: boolean;
    annotations?: AbilityAnnotations;
  };
}

/**
 * Category definition from the REST API
 */
export interface Category {
  slug: string;
  label: string;
  description: string;
}

/**
 * Cached abilities data
 */
let cachedAbilities: Ability[] | null = null;
let abilitiesIndex: Map<string, Ability> | null = null;
let cachedCategories: Category[] | null = null;
let abilitiesCacheTimestamp: number = 0;
let categoriesCacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Hardcoded namespace filter for MainWP abilities.
 * This server only supports MainWP abilities (mainwp/* namespace).
 */
const NAMESPACE_FILTER = 'mainwp/';
const CATEGORY_FILTER = 'mainwp-';

/**
 * Cache refresh callbacks
 */
type CacheRefreshCallback = () => void;
const cacheRefreshCallbacks: CacheRefreshCallback[] = [];

/**
 * Register a callback to be called when the abilities cache is refreshed
 */
export function onCacheRefresh(callback: CacheRefreshCallback): void {
  cacheRefreshCallbacks.push(callback);
}

/**
 * Notify all registered callbacks that the cache was refreshed
 */
function notifyCacheRefresh(): void {
  for (const callback of cacheRefreshCallbacks) {
    try {
      callback();
    } catch {
      // Ignore callback errors
    }
  }
}

/**
 * Fetch all abilities from the MainWP Dashboard
 */
export async function fetchAbilities(
  config: Config,
  forceRefresh = false,
  logger?: Logger
): Promise<Ability[]> {
  // Return cached data if still valid
  if (!forceRefresh && cachedAbilities && Date.now() - abilitiesCacheTimestamp < CACHE_TTL_MS) {
    return cachedAbilities;
  }

  const baseUrl = getAbilitiesApiUrl(config);
  const customFetch = createFetch(config);

  try {
    const allAbilities = await paginateApi<Ability>(
      customFetch,
      `${baseUrl}/abilities`,
      'abilities',
      config.maxResponseSize,
      logger
    );

    const newAbilities = allAbilities.filter(a => a.name.startsWith(NAMESPACE_FILTER));

    // Check if abilities have changed (compare names)
    const oldNames =
      cachedAbilities
        ?.map(a => a.name)
        .sort()
        .join(',') ?? '';
    const newNames = newAbilities
      .map(a => a.name)
      .sort()
      .join(',');
    const hasChanged = oldNames !== newNames;

    cachedAbilities = newAbilities;
    abilitiesIndex = new Map<string, Ability>();
    for (const ability of newAbilities) {
      abilitiesIndex.set(ability.name, ability);
    }
    abilitiesCacheTimestamp = Date.now();

    // Notify callbacks if abilities changed
    if (hasChanged && oldNames !== '') {
      notifyCacheRefresh();
    }

    return cachedAbilities;
  } catch (error) {
    // Serve stale cache on transient failures, but only up to MAX_STALE_AGE_MS.
    // Beyond that, the cache may be dangerously outdated (e.g., poisoned abilities).
    if (cachedAbilities) {
      const cacheAgeMs = Date.now() - abilitiesCacheTimestamp;
      const cacheAgeMinutes = Math.round(cacheAgeMs / 60000);
      if (cacheAgeMs > MAX_STALE_AGE_MS) {
        logger?.error('Stale cache exceeded max age, discarding', {
          cacheAgeMinutes,
          maxStaleMinutes: MAX_STALE_AGE_MS / 60000,
        });
        cachedAbilities = null;
        abilitiesIndex = null;
        throw error;
      }
      logger?.warning('Failed to refresh abilities, using cached data', {
        error: sanitizeError(String(error)),
        cacheAgeMinutes,
      });
      return cachedAbilities;
    }
    throw error;
  }
}

/**
 * Fetch all categories from the MainWP Dashboard
 */
export async function fetchCategories(
  config: Config,
  forceRefresh = false,
  logger?: Logger
): Promise<Category[]> {
  // Return cached data if still valid
  if (!forceRefresh && cachedCategories && Date.now() - categoriesCacheTimestamp < CACHE_TTL_MS) {
    return cachedCategories;
  }

  const baseUrl = getAbilitiesApiUrl(config);
  const customFetch = createFetch(config);

  try {
    const allCategories = await paginateApi<Category>(
      customFetch,
      `${baseUrl}/categories`,
      'categories',
      config.maxResponseSize,
      logger
    );

    // Filter categories to only MainWP namespace
    cachedCategories = allCategories.filter(c => c.slug.startsWith(CATEGORY_FILTER));
    categoriesCacheTimestamp = Date.now();

    return cachedCategories;
  } catch (error) {
    if (cachedCategories) {
      const cacheAgeMs = Date.now() - categoriesCacheTimestamp;
      const cacheAgeMinutes = Math.round(cacheAgeMs / 60000);
      if (cacheAgeMs > MAX_STALE_AGE_MS) {
        logger?.error('Stale categories cache exceeded max age, discarding', {
          cacheAgeMinutes,
          maxStaleMinutes: MAX_STALE_AGE_MS / 60000,
        });
        cachedCategories = null;
        throw error;
      }
      logger?.warning('Failed to refresh categories, using cached data', {
        error: sanitizeError(String(error)),
        cacheAgeMinutes,
      });
      return cachedCategories;
    }
    throw error;
  }
}

/**
 * Get a specific ability by name
 */
export async function getAbility(
  config: Config,
  name: string,
  logger?: Logger
): Promise<Ability | undefined> {
  await fetchAbilities(config, false, logger);
  return abilitiesIndex?.get(name);
}

/**
 * Serialize input to PHP-style query string for GET requests.
 * WordPress REST API parses PHP array notation: input[key][]=value
 */
function serializeToPhpQueryString(input: Record<string, unknown>): string {
  const params: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      // Arrays: input[key][]=val1&input[key][]=val2
      for (const item of value) {
        params.push(`input[${encodeURIComponent(key)}][]=${encodeURIComponent(String(item))}`);
      }
    } else if (typeof value === 'object' && value !== null) {
      // Nested objects: input[key][subkey]=val
      for (const [subKey, subVal] of Object.entries(value)) {
        params.push(
          `input[${encodeURIComponent(key)}][${encodeURIComponent(subKey)}]=${encodeURIComponent(String(subVal))}`
        );
      }
    } else if (value !== undefined && value !== null) {
      // Scalars: input[key]=val
      params.push(`input[${encodeURIComponent(key)}]=${encodeURIComponent(String(value))}`);
    }
  }

  return params.length > 0 ? '?' + params.join('&') : '';
}

/**
 * Create an HTTP error with status code for retry detection.
 * The status is embedded in the error object and message for isRetryableError() to detect.
 *
 * @param status - HTTP status code
 * @param errorCode - Error code (from JSON response or status string)
 * @param message - Error message
 */
function createHttpError(status: number, errorCode: string, message: string): Error {
  const error = new Error(`Ability execution failed: ${errorCode} - ${message}`);
  const httpError = error as Error & { status: number; code: string };
  httpError.status = status;
  httpError.code = errorCode;
  return error;
}

/**
 * Execute an ability via the REST API
 *
 * @param config - Server configuration
 * @param abilityName - Name of the ability to execute
 * @param input - Optional input parameters
 * @param logger - Optional logger for retry logging
 * @param prefetchedAbility - Pre-fetched ability metadata to avoid redundant lookup
 * @param signal - Optional AbortSignal for caller-initiated cancellation
 */
export async function executeAbility(
  config: Config,
  abilityName: string,
  input?: Record<string, unknown>,
  logger?: Logger,
  prefetchedAbility?: Ability,
  signal?: AbortSignal
): Promise<unknown> {
  if (rateLimiter) {
    await rateLimiter.acquire(signal);
  }

  // Validate ability name format to prevent path traversal in URL construction.
  // A compromised dashboard could return names like "mainwp/../../admin" which
  // pass the namespace filter but create traversal URLs.
  if (!ABILITY_NAME_RE.test(abilityName)) {
    throw McpErrorFactory.invalidParams(
      `Invalid ability name format: ${sanitizeError(abilityName)}`
    );
  }

  const baseUrl = getAbilitiesApiUrl(config);

  const ability = prefetchedAbility ?? (await getAbility(config, abilityName, logger));
  if (!ability) {
    throw McpErrorFactory.abilityNotFound(abilityName);
  }

  const isReadonly = ability.meta?.annotations?.readonly ?? false;
  const isDestructive = ability.meta?.annotations?.destructive ?? true;
  const isIdempotent = ability.meta?.annotations?.idempotent ?? false;
  const url = `${baseUrl}/abilities/${abilityName}/run`;
  const hasInput = input && Object.keys(input).length > 0;

  // Audit log for destructive operations - logs operation name only, no sensitive parameters
  if (isDestructive) {
    logger?.info('AUDIT: Destructive operation requested', { abilityName });
  }

  /**
   * Fetch and validate response in a single operation.
   * This ensures HTTP errors (5xx, 429) are thrown and can be retried.
   *
   * @param context - Retry context with remaining timeout budget
   */
  const fetchAndValidate = async (context: RetryContext): Promise<unknown> => {
    // Use remaining budget as timeout
    const timeout = Math.max(1, context.remainingBudget);
    const customFetch = createFetch(config, timeout);
    const fetchStart = performance.now();

    let response: Response;
    if (isReadonly || (isDestructive && isIdempotent)) {
      // GET or DELETE — both use query string params (WP Abilities API doesn't parse DELETE bodies)
      const method = isReadonly ? 'GET' : 'DELETE';
      const queryString = hasInput ? serializeToPhpQueryString(input) : '';
      const fullUrl = url + queryString;
      if (fullUrl.length > MAX_URL_LENGTH) {
        throw new Error(
          `Request URL exceeds ${MAX_URL_LENGTH} characters (${fullUrl.length}); reduce input parameters`
        );
      }
      response = await customFetch(fullUrl, { method, signal });
    } else {
      // POST request for non-destructive write operations
      response = await customFetch(url, {
        method: 'POST',
        body: JSON.stringify({ input: input ?? {} }),
        signal,
      });
    }

    const upstreamLatencyMs = Math.round(performance.now() - fetchStart);

    // Validate response - throw HTTP error for non-ok status
    // This allows isRetryableError() to detect 5xx/429 and trigger retries
    if (!response.ok) {
      // Read body with size limit to prevent transient memory spikes from large error responses
      const bodyText = await readLimitedBody(response, MAX_ERROR_BODY_BYTES);
      let errorCode = String(response.status);
      let errorMsg = response.statusText;

      // Only try to parse as JSON if the body looks like JSON
      if (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[')) {
        try {
          const errorData = JSON.parse(bodyText);
          errorCode = (errorData as { code?: string }).code || errorCode;
          errorMsg = (errorData as { message?: string }).message || errorMsg;
        } catch {
          // JSON parse failed - use raw text as message
          errorMsg = bodyText || response.statusText;
        }
      } else if (bodyText) {
        // Non-JSON response body - use as error message
        errorMsg = bodyText;
      }

      logger?.warning('Upstream request failed', {
        abilityName,
        httpStatus: response.status,
        upstreamLatencyMs,
      });

      throw createHttpError(response.status, errorCode, sanitizeError(errorMsg));
    }

    // Read response body with streaming size enforcement
    const responseBody = await readLimitedBody(response, config.maxResponseSize);

    logger?.debug('Upstream request succeeded', {
      abilityName,
      httpStatus: response.status,
      upstreamLatencyMs,
    });

    return JSON.parse(responseBody);
  };

  // Apply retry logic only for read-only operations when enabled
  if (config.retryEnabled && isReadonly) {
    return await withRetry(fetchAndValidate, {
      maxRetries: config.maxRetries,
      baseDelay: config.retryBaseDelay,
      maxDelay: config.retryMaxDelay,
      timeoutBudget: config.requestTimeout,
      logger,
    });
  } else {
    // No retry: execute directly with synthetic context
    return await fetchAndValidate({
      remainingBudget: config.requestTimeout,
      attempt: 0,
    });
  }
}

/**
 * Clear the abilities cache
 */
export function clearCache(): void {
  cachedAbilities = null;
  abilitiesIndex = null;
  cachedCategories = null;
  abilitiesCacheTimestamp = 0;
  categoriesCacheTimestamp = 0;
}
