/**
 * MainWP Abilities Discovery and Management
 *
 * Fetches and caches ability definitions from the MainWP Dashboard's
 * Abilities API REST endpoints.
 */

import { Config, getAbilitiesApiUrl, getAuthHeaders } from './config.js';
import { McpErrorFactory } from './errors.js';
import { RateLimiter, sanitizeError } from './security.js';
import { abilityNameToToolName } from './naming.js';
import { withRetry, type RetryContext } from './retry.js';
import type { Logger } from './logging.js';
import https from 'https';

/** Maximum size for error response bodies (64KB) — prevents transient memory spikes */
const MAX_ERROR_BODY_BYTES = 65536;

/** Maximum URL length for GET/DELETE requests — most HTTP servers reject URLs > 8KB */
const MAX_URL_LENGTH = 8000;

/** Maximum number of pages to fetch during pagination — prevents unbounded requests */
const MAX_PAGES = 50;

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
let sharedAgent: https.Agent | undefined;

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
 * Create a fetch function that handles SSL verification, request timeout, and response size limits.
 * Wraps any caller-provided AbortSignal to enforce timeout while preserving external cancellation.
 *
 * @param config - Server configuration
 * @param perCallTimeout - Optional per-call timeout override (for retry budget enforcement)
 */
function createFetch(config: Config, perCallTimeout?: number) {
  if (config.skipSslVerify && !sharedAgent) {
    sharedAgent = new https.Agent({ rejectUnauthorized: false });
  }
  const agent = config.skipSslVerify ? sharedAgent : undefined;
  const effectiveTimeout = perCallTimeout ?? config.requestTimeout;

  return async (url: string, options: RequestInit = {}): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    // Forward external signal abort to our controller (preserves caller cancellation)
    const externalSignal = options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    try {
      const fetchOptions: RequestInit & { agent?: https.Agent } = {
        ...options,
        signal: controller.signal,
        headers: {
          ...getAuthHeaders(config),
          ...options.headers,
        },
      };

      // For Node.js fetch with custom agent
      if (agent) {
        (fetchOptions as unknown as { agent: https.Agent }).agent = agent;
      }

      // Use native fetch (Node 18+) with agent support
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

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

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        // Create timeout error with ETIMEDOUT code for retry detection
        const timeoutError = new Error(`Request timeout after ${effectiveTimeout}ms: ${url}`);
        (timeoutError as Error & { code: string }).code = 'ETIMEDOUT';
        throw timeoutError;
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
      reader.cancel();
      throw new Error(`Response body exceeds ${maxBytes} bytes limit`);
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
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
    // Paginate through all abilities
    let page = 1;
    const allAbilities: Ability[] = [];

    while (true) {
      const response = await customFetch(`${baseUrl}/abilities?per_page=100&page=${page}`);

      if (!response.ok) {
        const errorText = await readLimitedBody(response, MAX_ERROR_BODY_BYTES);
        throw new Error(
          `Failed to fetch abilities: ${response.status} ${response.statusText} - ${sanitizeError(errorText)}`
        );
      }

      const body = await readLimitedBody(response, config.maxResponseSize);
      const batch = JSON.parse(body) as Ability[];
      allAbilities.push(...batch);

      const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1', 10);
      if (page >= totalPages || page >= MAX_PAGES) break;
      page++;
    }

    if (page >= MAX_PAGES) {
      logger?.warning(
        `Pagination capped at ${MAX_PAGES} pages (fetched ${allAbilities.length} abilities) — some may be missing`
      );
    } else if (page > 1) {
      logger?.info(`Fetched ${allAbilities.length} abilities across ${page} pages`);
    }

    // Filter abilities to only MainWP namespace
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
    // If we have cached data, return it even if expired
    if (cachedAbilities) {
      const cacheAgeMinutes = Math.round((Date.now() - abilitiesCacheTimestamp) / 60000);
      logger?.warning('Failed to refresh abilities, using cached data', {
        error: String(error),
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
    // Paginate through all categories
    let page = 1;
    const allCategories: Category[] = [];

    while (true) {
      const response = await customFetch(`${baseUrl}/categories?per_page=100&page=${page}`);

      if (!response.ok) {
        const errorText = await readLimitedBody(response, MAX_ERROR_BODY_BYTES);
        throw new Error(
          `Failed to fetch categories: ${response.status} ${response.statusText} - ${sanitizeError(errorText)}`
        );
      }

      const body = await readLimitedBody(response, config.maxResponseSize);
      const batch = JSON.parse(body) as Category[];
      allCategories.push(...batch);

      const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1', 10);
      if (page >= totalPages || page >= MAX_PAGES) break;
      page++;
    }

    if (page >= MAX_PAGES) {
      logger?.warning(
        `Pagination capped at ${MAX_PAGES} pages (fetched ${allCategories.length} categories) — some may be missing`
      );
    }

    // Filter categories to only MainWP namespace
    cachedCategories = allCategories.filter(c => c.slug.startsWith(CATEGORY_FILTER));
    categoriesCacheTimestamp = Date.now();

    return cachedCategories;
  } catch (error) {
    if (cachedCategories) {
      const cacheAgeMinutes = Math.round((Date.now() - categoriesCacheTimestamp) / 60000);
      logger?.warning('Failed to refresh categories, using cached data', {
        error: String(error),
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
 */
export async function executeAbility(
  config: Config,
  abilityName: string,
  input?: Record<string, unknown>,
  logger?: Logger
): Promise<unknown> {
  // Apply rate limiting BEFORE retry logic
  // This ensures retries bypass the rate limiter to avoid deadlocks
  if (rateLimiter) {
    await rateLimiter.acquire();
  }

  const baseUrl = getAbilitiesApiUrl(config);

  // Get ability to check if it's readonly
  const ability = await getAbility(config, abilityName, logger);
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

    let response: Response;
    if (isReadonly) {
      // GET request for read-only abilities, with optional params as query string
      const queryString = hasInput ? serializeToPhpQueryString(input) : '';
      const fullUrl = url + queryString;
      if (fullUrl.length > MAX_URL_LENGTH) {
        throw new Error(
          `Request URL exceeds ${MAX_URL_LENGTH} characters (${fullUrl.length}); reduce input parameters`
        );
      }
      response = await customFetch(fullUrl, { method: 'GET' });
    } else if (isDestructive && isIdempotent) {
      // DELETE request for destructive + idempotent abilities
      // Uses query string parameters like GET - WP Abilities API doesn't parse DELETE bodies
      const queryString = hasInput ? serializeToPhpQueryString(input) : '';
      const fullUrl = url + queryString;
      if (fullUrl.length > MAX_URL_LENGTH) {
        throw new Error(
          `Request URL exceeds ${MAX_URL_LENGTH} characters (${fullUrl.length}); reduce input parameters`
        );
      }
      response = await customFetch(fullUrl, { method: 'DELETE' });
    } else {
      // POST request for non-destructive write operations
      response = await customFetch(url, {
        method: 'POST',
        body: JSON.stringify({ input: input ?? {} }),
      });
    }

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

      throw createHttpError(response.status, errorCode, sanitizeError(errorMsg));
    }

    // Read response body with streaming size enforcement
    const responseBody = await readLimitedBody(response, config.maxResponseSize);
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

// =============================================================================
// Help Documentation Generation
// =============================================================================

/**
 * Help documentation for a single tool
 */
export interface ToolHelp {
  toolName: string;
  abilityName: string;
  label: string;
  description: string;
  category: string;
  annotations: {
    readonly: boolean;
    destructive: boolean;
    idempotent: boolean;
    instructions?: string;
  };
  safetyFeatures: {
    supportsDryRun: boolean;
    requiresConfirm: boolean;
  };
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
  }>;
}

/**
 * Complete help document structure
 */
export interface HelpDocument {
  version: string;
  generated: string;
  overview: {
    totalTools: number;
    categories: string[];
    safetyConventions: Record<string, string>;
  };
  destructiveTools: string[];
  toolsWithDryRun: string[];
  toolsRequiringConfirm: string[];
  toolsByCategory: Record<string, ToolHelp[]>;
}

/**
 * Generate help documentation for a single ability
 */
export function generateToolHelp(ability: Ability): ToolHelp {
  const toolName = abilityNameToToolName(ability.name);
  const props = (ability.input_schema?.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (ability.input_schema?.required as string[]) || [];

  const parameters = Object.entries(props).map(([name, prop]) => ({
    name,
    type: String(prop.type || 'unknown'),
    required: required.includes(name),
    description: prop.description as string | undefined,
  }));

  return {
    toolName,
    abilityName: ability.name,
    label: ability.label,
    description: ability.description,
    category: ability.category,
    annotations: {
      readonly: ability.meta?.annotations?.readonly ?? false,
      destructive: ability.meta?.annotations?.destructive ?? true,
      idempotent: ability.meta?.annotations?.idempotent ?? true,
      instructions: ability.meta?.annotations?.instructions,
    },
    safetyFeatures: {
      supportsDryRun: 'dry_run' in props,
      requiresConfirm: 'confirm' in props,
    },
    parameters,
  };
}

/**
 * Generate complete help document from all abilities
 */
export function generateHelpDocument(abilities: Ability[]): HelpDocument {
  const toolHelps = abilities.map(generateToolHelp);
  // Use normalized categories matching toolsByCategory grouping logic
  const categories = [
    ...new Set(toolHelps.map(h => (h.category && h.category.trim()) || 'uncategorized')),
  ].sort();

  const toolsByCategory: Record<string, ToolHelp[]> = {};
  for (const help of toolHelps) {
    // Handle empty string, null, undefined as 'uncategorized'
    const cat = (help.category && help.category.trim()) || 'uncategorized';
    if (!toolsByCategory[cat]) toolsByCategory[cat] = [];
    toolsByCategory[cat].push(help);
  }

  return {
    version: '1.0',
    generated: new Date().toISOString(),
    overview: {
      totalTools: abilities.length,
      categories,
      safetyConventions: {
        dryRun: 'Pass dry_run: true to preview the operation without making changes',
        confirm: 'Pass confirm: true to execute destructive operations',
        destructive: 'These tools can permanently delete or modify data',
        readonly: 'These tools only read data and never modify anything',
      },
    },
    destructiveTools: toolHelps.filter(h => h.annotations.destructive).map(h => h.toolName),
    toolsWithDryRun: toolHelps.filter(h => h.safetyFeatures.supportsDryRun).map(h => h.toolName),
    toolsRequiringConfirm: toolHelps
      .filter(h => h.safetyFeatures.requiresConfirm)
      .map(h => h.toolName),
    toolsByCategory,
  };
}
