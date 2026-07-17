/**
 * MainWP Abilities Discovery and Management
 *
 * Fetches and caches ability definitions from the MainWP Dashboard's
 * Abilities API REST endpoints.
 */

import crypto from 'crypto';
import { Config, getAbilitiesApiUrl } from './config.js';
import { McpErrorFactory, createHttpError, getErrorMessage } from './errors.js';
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
import { abilityNameToToolName } from './naming.js';

/** Maximum age of stale cache before hard-failing (30 minutes) */
const MAX_STALE_AGE_MS = 30 * 60 * 1000;

/**
 * Strict format for ability names — prevents path traversal in URL construction.
 * The namespace portion allows internal hyphens so hyphenated namespaces like
 * `acme-corp` round-trip cleanly between config and execute, but forbids
 * leading/trailing hyphens (same shape as the slug portion). Both portions
 * forbid `_` so the `__` namespace/slug separator stays unambiguous in tool
 * names. Must stay in sync with ABILITY_NAMESPACE_RE in config.ts.
 */
const ABILITY_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

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
 * Cache slot: one TTL/signature-guarded cache with in-flight de-duplication.
 * Shared by the abilities and categories caches via getCachedOrRefresh.
 */
interface CacheSlot<T> {
  data: T | null;
  timestamp: number;
  /** Cache signature (dashboard + namespaces + auth identity) the cached data was built for */
  signature: string;
  /**
   * Bumped on every successful commit. Lets a failing refresh detect that a
   * concurrent refresh committed newer data, so the failure path never
   * discards a write it did not observe at its own start.
   */
  generation: number;
  /** In-flight refresh, shared by concurrent same-signature callers */
  inFlight: { promise: Promise<T>; signature: string } | null;
}

function emptySlot<T>(): CacheSlot<T> {
  return { data: null, timestamp: 0, signature: '', generation: 0, inFlight: null };
}

const abilitiesCache: CacheSlot<Ability[]> = emptySlot();
const categoriesCache: CacheSlot<Category[]> = emptySlot();

/**
 * Derived lookup indexes, keyed by the exact abilities array they were built
 * from. WeakMap (not module-level variables) so a caller that awaited one
 * fetch can never read indexes committed by a concurrent fetch for a
 * different config — the array reference it holds always resolves to its own
 * matching indexes. Entries are garbage-collected with their arrays.
 */
interface AbilityIndexes {
  byName: Map<string, Ability>;
  byToolName: Map<string, Ability>;
}
const abilityIndexes = new WeakMap<Ability[], AbilityIndexes>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build a stable signature of the response-affecting config (dashboard URL +
 * namespace allowlist + authentication identity) so a config change forces a
 * cache refresh instead of serving data fetched from another dashboard,
 * filtered for other namespaces, or fetched as a different user — WordPress
 * can expose different ability catalogs per user, and multiple
 * createServer(config) instances may share this module-level cache in one
 * process. The identity is a one-way hash so credentials never appear in the
 * signature itself. Also keys in-flight de-duplication: callers may only join
 * a running fetch for the same dashboard, allowlist, and identity.
 * Transport-security settings are part of the identity too: an instance with
 * strict TLS or a smaller body cap must not reuse data fetched by a laxer one.
 */
function cacheSignature(config: Config): string {
  const authIdentity = crypto
    .createHash('sha256')
    .update(JSON.stringify([config.authType, config.username, config.appPassword, config.apiToken]))
    .digest('hex');
  return JSON.stringify([
    config.dashboardUrl,
    config.abilityNamespaces,
    authIdentity,
    config.skipSslVerify,
    config.maxResponseSize,
  ]);
}

/**
 * Returns true if the ability's namespace is in the allowlist.
 */
function isAllowedNamespace(abilityName: string, namespaces: string[]): boolean {
  const slashIndex = abilityName.indexOf('/');
  if (slashIndex === -1) return false;
  const namespace = abilityName.slice(0, slashIndex);
  return namespaces.includes(namespace);
}

/**
 * Returns true if the category slug starts with any configured namespace's
 * `{ns}-` prefix.
 *
 * Known limitation: category metadata from the WP Abilities API does not
 * carry an explicit namespace field, so when the upstream server registers
 * both `acme` and `acme-corp` and the user configures only `['acme']`, a
 * slug like `acme-corp-things` (which belongs to `acme-corp`) still passes
 * this filter and shows up in the `mainwp://categories` resource as an
 * empty category — none of its abilities pass `isAllowedNamespace`, so no
 * ability misrouting occurs. The effect is cosmetic. If both prefix-related
 * namespaces are listed in the allowlist, all categories surface correctly.
 */
function isAllowedCategory(slug: string, namespaces: string[]): boolean {
  return namespaces.some(ns => slug.startsWith(`${ns}-`));
}

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
function notifyCacheRefresh(logger?: Logger): void {
  for (const callback of cacheRefreshCallbacks) {
    try {
      callback();
    } catch (error) {
      // Fail soft — a broken listener must not poison the cache refresh —
      // but leave a trace instead of swallowing silently
      logger?.debug('Cache refresh callback failed', {
        error: sanitizeError(getErrorMessage(error)),
      });
    }
  }
}

/**
 * Return cached data or refresh it — the shared engine behind the abilities
 * and categories caches. Owns, in order:
 *
 * 1. Fresh-cache check: serve only if the TTL hasn't expired AND the
 *    namespace allowlist hasn't changed since the cache was populated.
 * 2. In-flight de-duplication: concurrent same-signature callers await the
 *    running refresh instead of issuing duplicate upstream fetches.
 * 3. Refresh: fetch, process, then commit data + timestamp + signature (and
 *    any derived state via `commit`) together.
 * 4. Failure fallback: serve stale cache on transient failures up to
 *    MAX_STALE_AGE_MS, but only when the cached data was built for the same
 *    namespace allowlist — a signature mismatch means the user changed
 *    config, and falling back would silently return the wrong data set.
 *
 * A `process` throw (e.g. tool-name collision) is treated exactly like a
 * fetch failure: the existing cache is preserved and the stale-serving
 * decision tree applies.
 *
 * @param slot - The cache slot to read/write
 * @param signature - Namespace signature for the requesting config
 * @param label - Data label for log messages ('abilities', 'categories')
 * @param process - Convert raw fetch results into cacheable data; may return
 *   a `commit` callback that is invoked synchronously with the cache write
 *   to update derived state atomically (w.r.t. the event loop)
 */
async function getCachedOrRefresh<R, T>(opts: {
  slot: CacheSlot<T>;
  signature: string;
  label: string;
  forceRefresh: boolean;
  logger?: Logger;
  fetchFn: () => Promise<R>;
  process: (raw: R) => { data: T; commit?: () => void };
}): Promise<T> {
  const { slot, signature, label, forceRefresh, logger } = opts;

  if (
    !forceRefresh &&
    slot.data !== null &&
    slot.signature === signature &&
    Date.now() - slot.timestamp < CACHE_TTL_MS
  ) {
    return slot.data;
  }

  // A same-signature refresh is already running; its result is by definition
  // fresher than the TTL, so even forceRefresh callers can join it.
  if (slot.inFlight && slot.inFlight.signature === signature) {
    return slot.inFlight.promise;
  }

  const refresh = (async (): Promise<T> => {
    // Snapshot the generation BEFORE fetching. If a concurrent refresh (for a
    // different signature — same-signature callers join us) commits while we
    // are in flight, the generation moves past this snapshot and our failure
    // path below knows the slot no longer holds the data we started with.
    const startGeneration = slot.generation;
    try {
      const raw = await opts.fetchFn();
      const { data, commit } = opts.process(raw);
      slot.data = data;
      slot.timestamp = Date.now();
      slot.signature = signature;
      slot.generation++;
      commit?.();
      return data;
    } catch (error) {
      // Serve stale same-signature cache on transient failures, up to
      // MAX_STALE_AGE_MS.
      if (slot.data !== null && slot.signature === signature) {
        const cacheAgeMs = Date.now() - slot.timestamp;
        const cacheAgeMinutes = Math.round(cacheAgeMs / 60000);
        if (cacheAgeMs > MAX_STALE_AGE_MS) {
          logger?.error(`Stale ${label} cache exceeded max age, discarding`, {
            cacheAgeMinutes,
            maxStaleMinutes: MAX_STALE_AGE_MS / 60000,
          });
          slot.data = null;
          throw error;
        }
        logger?.warning(`Failed to refresh ${label}, using cached data`, {
          error: sanitizeError(getErrorMessage(error)),
          cacheAgeMinutes,
        });
        return slot.data;
      }

      // The slot holds data for a DIFFERENT signature (or nothing). Discard
      // it only if it's the same snapshot we observed when this refresh
      // started — data committed by a concurrent refresh AFTER our start
      // (generation moved) is newer than us and must survive our failure.
      // Either way, surface the error: we can't return wrong-config data,
      // and we won't lie about a fetch that failed.
      if (slot.data !== null && slot.generation === startGeneration) {
        logger?.warning(`Discarding ${label} cache: config changed and refresh failed`, {
          cachedSignature: slot.signature,
          requestedSignature: signature,
          error: sanitizeError(getErrorMessage(error)),
        });
        slot.data = null;
      }
      throw error;
    }
  })();

  slot.inFlight = { promise: refresh, signature };
  try {
    return await refresh;
  } finally {
    // Only clear our own registration — a different-signature refresh may
    // have replaced it while we were awaiting.
    if (slot.inFlight?.promise === refresh) {
      slot.inFlight = null;
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
  const namespaces = config.abilityNamespaces;
  const baseUrl = getAbilitiesApiUrl(config);

  return getCachedOrRefresh({
    slot: abilitiesCache,
    signature: cacheSignature(config),
    label: 'abilities',
    forceRefresh,
    logger,
    fetchFn: () =>
      paginateApi<Ability>(
        createFetch(config),
        `${baseUrl}/abilities`,
        'abilities',
        config.maxResponseSize,
        logger
      ),
    process: allAbilities => {
      const newAbilities = allAbilities.filter(a => {
        // Hostile-input guard: a null entry or non-string name would throw
        // below and poison the whole catalog refresh instead of being skipped.
        if (
          a === null ||
          typeof a !== 'object' ||
          typeof (a as { name?: unknown }).name !== 'string'
        ) {
          logger?.warning('Skipping malformed ability entry', { entryType: typeof a });
          return false;
        }
        if (!isAllowedNamespace(a.name, namespaces)) return false;
        // Defense in depth: drop abilities whose names fail the strict format
        // check before they reach the tool index. A malformed name (extra
        // slash, bad charset) would otherwise surface as an invalid MCP tool
        // name in ListTools and only fail at execute time.
        if (!ABILITY_NAME_RE.test(a.name)) {
          logger?.warning('Skipping ability with malformed name', { name: sanitizeError(a.name) });
          return false;
        }
        return true;
      });

      // A misconfigured namespace allowlist boots a server that advertises
      // zero tools with no other symptom — warn loudly so the cause is in the
      // logs instead of leaving a silently empty server. An empty upstream is
      // a different problem, so it gets its own message.
      if (allAbilities.length === 0) {
        logger?.warning('Dashboard returned no abilities', { namespaces });
      } else if (newAbilities.length === 0) {
        logger?.warning('No abilities matched the configured namespaces', {
          namespaces,
          fetchedCount: allAbilities.length,
        });
      }

      // Detect changes to every field that affects MCP tool conversion, not
      // only names, so clients refresh schemas and safety annotations too.
      const fingerprint = (abilities: Ability[] | null): string =>
        JSON.stringify(
          (abilities ?? [])
            .map(ability => ({
              name: ability.name,
              label: ability.label,
              category: ability.category,
              description: ability.description,
              input_schema: ability.input_schema,
              output_schema: ability.output_schema,
              annotations: ability.meta?.annotations,
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
        );
      const oldFingerprint = fingerprint(abilitiesCache.data);
      const newFingerprint = fingerprint(newAbilities);
      const hasChanged = oldFingerprint !== newFingerprint;
      const hadCachedAbilities = abilitiesCache.data !== null;

      // Build indices into local variables first; they're committed together
      // with the cache write. If the collision throw fires mid-loop the
      // existing cache and indexes stay untouched rather than serving a
      // partially built tool-name index that would make some tools silently
      // unresolvable.
      const newAbilitiesIndex = new Map<string, Ability>();
      const newToolNameIndex = new Map<string, Ability>();
      const primary = namespaces[0];
      for (const ability of newAbilities) {
        newAbilitiesIndex.set(ability.name, ability);

        const toolName = abilityNameToToolName(ability.name, primary);
        // Tool name collisions are rare but possible: ABILITY_NAME_RE forbids
        // `_` in names and `__` is the namespace/slug separator for non-primary
        // namespaces, but a double hyphen in a slug also maps to `__` (e.g.
        // primary `mainwp/foo--bar` and non-primary `foo/bar` both produce
        // `foo__bar`), and upstream could return duplicate names. Fail loud
        // rather than silently shadowing one ability under the other's tool
        // name.
        const existing = newToolNameIndex.get(toolName);
        if (existing) {
          throw new Error(
            `Tool name collision: "${toolName}" produced by both "${existing.name}" and "${ability.name}". ` +
              `This indicates a violation of the namespace/slug invariants in abilities.ts.`
          );
        }
        newToolNameIndex.set(toolName, ability);
      }

      return {
        data: newAbilities,
        commit: () => {
          abilityIndexes.set(newAbilities, {
            byName: newAbilitiesIndex,
            byToolName: newToolNameIndex,
          });
          // Notify callbacks if abilities changed
          if (hasChanged && hadCachedAbilities) {
            notifyCacheRefresh(logger);
          }
        },
      };
    },
  });
}

/**
 * Fetch all categories from the MainWP Dashboard
 */
export async function fetchCategories(
  config: Config,
  forceRefresh = false,
  logger?: Logger
): Promise<Category[]> {
  const namespaces = config.abilityNamespaces;
  const baseUrl = getAbilitiesApiUrl(config);

  return getCachedOrRefresh({
    slot: categoriesCache,
    signature: cacheSignature(config),
    label: 'categories',
    forceRefresh,
    logger,
    fetchFn: () =>
      paginateApi<Category>(
        createFetch(config),
        `${baseUrl}/categories`,
        'categories',
        config.maxResponseSize,
        logger
      ),
    // Filter categories to configured namespaces (allowlist of `{ns}-` prefixes)
    process: allCategories => ({
      data: allCategories.filter(c => isAllowedCategory(c.slug, namespaces)),
    }),
  });
}

/**
 * Get a specific ability by name
 */
export async function getAbility(
  config: Config,
  name: string,
  logger?: Logger
): Promise<Ability | undefined> {
  // Look up via the indexes built for the exact array this call received —
  // never via shared mutable state a concurrent fetch could have replaced.
  const abilities = await fetchAbilities(config, false, logger);
  return abilityIndexes.get(abilities)?.byName.get(name);
}

/**
 * Resolve an MCP tool name to its underlying ability via the cache index.
 * Tool names are not uniquely decodable back to ability names — hyphens in
 * the ability slug map to underscores, and the same shape can in principle
 * collide across namespaces — so reverse lookup goes through the map built
 * during `fetchAbilities`. The build loop throws on any collision rather
 * than guessing; see `fetchAbilities` for the invariant rationale.
 */
export async function getAbilityByToolName(
  config: Config,
  toolName: string,
  logger?: Logger
): Promise<Ability | undefined> {
  const abilities = await fetchAbilities(config, false, logger);
  return abilityIndexes.get(abilities)?.byToolName.get(toolName);
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
        if (item !== null && typeof item === 'object') {
          throw McpErrorFactory.invalidParams(
            `Unsupported nested query parameter at "${key}": arrays may contain only scalar values`
          );
        }
        params.push(`input[${encodeURIComponent(key)}][]=${encodeURIComponent(String(item))}`);
      }
    } else if (typeof value === 'object' && value !== null) {
      // Nested objects: input[key][subkey]=val
      for (const [subKey, subVal] of Object.entries(value)) {
        if (subVal !== null && typeof subVal === 'object') {
          throw McpErrorFactory.invalidParams(
            `Unsupported nested query parameter at "${key}": objects may be only one level deep`
          );
        }
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

      throw createHttpError(
        response.status,
        errorCode,
        `Ability execution failed: ${errorCode} - ${sanitizeError(errorMsg)}`
      );
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
  let result: unknown;
  if (config.retryEnabled && isReadonly) {
    result = await withRetry(fetchAndValidate, {
      maxRetries: config.maxRetries,
      baseDelay: config.retryBaseDelay,
      maxDelay: config.retryMaxDelay,
      timeoutBudget: config.requestTimeout,
      logger,
    });
  } else {
    // No retry: execute directly with synthetic context
    result = await fetchAndValidate({
      remainingBudget: config.requestTimeout,
      attempt: 0,
    });
  }

  if (isDestructive) {
    const action = input?.dry_run === true ? 'previewed' : 'executed';
    logger?.info(`AUDIT: destructive operation ${action}`, { abilityName });
  }

  return result;
}

/**
 * Clear the abilities cache
 */
export function clearCache(): void {
  // A refresh in flight at clear time will still commit when it resolves
  // (same semantics as before the slot refactor); clearing the inFlight
  // registration just stops new callers from joining the pre-clear fetch.
  // Derived indexes live in a WeakMap keyed by the discarded arrays, so
  // they're garbage-collected with them — nothing to clear here. The
  // generation stays monotonic (bumped, not reset) so any refresh that
  // snapshotted it before this clear can never mistake later data for its
  // own start state.
  Object.assign(abilitiesCache, emptySlot<Ability[]>(), {
    generation: abilitiesCache.generation + 1,
  });
  Object.assign(categoriesCache, emptySlot<Category[]>(), {
    generation: categoriesCache.generation + 1,
  });
}
