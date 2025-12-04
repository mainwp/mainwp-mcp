/**
 * MainWP Abilities Discovery and Management
 *
 * Fetches and caches ability definitions from the MainWP Dashboard's
 * Abilities API REST endpoints.
 */

import { Config, getAbilitiesApiUrl, getAuthHeaders } from './config.js';
import { RateLimiter, sanitizeError } from './security.js';
import https from 'https';

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
let cachedCategories: Category[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
 * Create a fetch function that handles SSL verification
 */
function createFetch(config: Config) {
  const agent = config.skipSslVerify
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  return async (url: string, options: RequestInit = {}): Promise<Response> => {
    const fetchOptions: RequestInit & { agent?: https.Agent } = {
      ...options,
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
    return response;
  };
}

/**
 * Fetch all abilities from the MainWP Dashboard
 */
export async function fetchAbilities(config: Config, forceRefresh = false): Promise<Ability[]> {
  // Return cached data if still valid
  if (!forceRefresh && cachedAbilities && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedAbilities;
  }

  const baseUrl = getAbilitiesApiUrl(config);
  const customFetch = createFetch(config);

  try {
    // Fetch all abilities (paginated - get up to 100)
    const response = await customFetch(`${baseUrl}/abilities?per_page=100`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch abilities: ${response.status} ${response.statusText} - ${sanitizeError(errorText)}`);
    }

    const abilities = await response.json() as Ability[];

    // Filter to only MainWP abilities (mainwp/* namespace)
    const newAbilities = abilities.filter(a => a.name.startsWith('mainwp/'));

    // Check if abilities have changed (compare names)
    const oldNames = cachedAbilities?.map(a => a.name).sort().join(',') ?? '';
    const newNames = newAbilities.map(a => a.name).sort().join(',');
    const hasChanged = oldNames !== newNames;

    cachedAbilities = newAbilities;
    cacheTimestamp = Date.now();

    // Notify callbacks if abilities changed
    if (hasChanged && oldNames !== '') {
      notifyCacheRefresh();
    }

    return cachedAbilities;
  } catch (error) {
    // If we have cached data, return it even if expired
    if (cachedAbilities) {
      console.error('Failed to refresh abilities, using cached data:', error);
      return cachedAbilities;
    }
    throw error;
  }
}

/**
 * Fetch all categories from the MainWP Dashboard
 */
export async function fetchCategories(config: Config, forceRefresh = false): Promise<Category[]> {
  // Return cached data if still valid
  if (!forceRefresh && cachedCategories && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCategories;
  }

  const baseUrl = getAbilitiesApiUrl(config);
  const customFetch = createFetch(config);

  try {
    const response = await customFetch(`${baseUrl}/categories?per_page=100`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch categories: ${response.status} ${response.statusText} - ${sanitizeError(errorText)}`);
    }

    const categories = await response.json() as Category[];

    // Filter to only MainWP categories
    cachedCategories = categories.filter(c => c.slug.startsWith('mainwp-'));
    cacheTimestamp = Date.now();

    return cachedCategories;
  } catch (error) {
    if (cachedCategories) {
      console.error('Failed to refresh categories, using cached data:', error);
      return cachedCategories;
    }
    throw error;
  }
}

/**
 * Get a specific ability by name
 */
export async function getAbility(config: Config, name: string): Promise<Ability | undefined> {
  const abilities = await fetchAbilities(config);
  return abilities.find(a => a.name === name);
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
        params.push(`input[${encodeURIComponent(key)}][${encodeURIComponent(subKey)}]=${encodeURIComponent(String(subVal))}`);
      }
    } else if (value !== undefined && value !== null) {
      // Scalars: input[key]=val
      params.push(`input[${encodeURIComponent(key)}]=${encodeURIComponent(String(value))}`);
    }
  }

  return params.length > 0 ? '?' + params.join('&') : '';
}

/**
 * Execute an ability via the REST API
 */
export async function executeAbility(
  config: Config,
  abilityName: string,
  input?: Record<string, unknown>
): Promise<unknown> {
  // Apply rate limiting
  if (rateLimiter) {
    await rateLimiter.acquire();
  }

  const baseUrl = getAbilitiesApiUrl(config);
  const customFetch = createFetch(config);

  // Get ability to check if it's readonly
  const ability = await getAbility(config, abilityName);
  if (!ability) {
    throw new Error(`Ability not found: ${abilityName}`);
  }

  const isReadonly = ability.meta?.annotations?.readonly ?? false;
  const url = `${baseUrl}/abilities/${abilityName}/run`;
  const hasInput = input && Object.keys(input).length > 0;

  let response: Response;

  if (isReadonly) {
    // GET request for read-only abilities, with optional params as query string
    const queryString = hasInput ? serializeToPhpQueryString(input) : '';
    response = await customFetch(url + queryString, { method: 'GET' });
  } else {
    // POST request for non-readonly abilities
    response = await customFetch(url, {
      method: 'POST',
      body: JSON.stringify({ input: input ?? {} }),
    });
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    const errorCode = (errorData as { code?: string }).code || String(response.status);
    const errorMsg = (errorData as { message?: string }).message || response.statusText;
    throw new Error(
      `Ability execution failed: ${errorCode} - ${sanitizeError(errorMsg)}`
    );
  }

  return response.json();
}

/**
 * Clear the abilities cache
 */
export function clearCache(): void {
  cachedAbilities = null;
  cachedCategories = null;
  cacheTimestamp = 0;
}
