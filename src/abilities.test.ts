/**
 * Abilities Module Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchAbilities,
  fetchCategories,
  getAbility,
  getAbilityByToolName,
  executeAbility,
  clearCache,
  onCacheRefresh,
  initRateLimiter,
  type Ability,
} from './abilities.js';
import { createFetch, paginateApi, readLimitedBody } from './http-client.js';
import { generateToolHelp, generateHelpDocument } from './help.js';
import { McpError, MCP_ERROR_CODES } from './errors.js';
import { type Config } from './config.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockLogger = makeMockLogger();

// Sample abilities for testing
const sampleAbilities: Ability[] = [
  {
    name: 'mainwp/list-sites-v1',
    label: 'List Sites',
    description: 'Get all managed sites',
    category: 'mainwp-sites',
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Page number' },
      },
    },
    meta: {
      annotations: {
        readonly: true,
        destructive: false,
        idempotent: true,
      },
    },
  },
  {
    name: 'mainwp/delete-site-v1',
    label: 'Delete Site',
    description: 'Delete a site',
    category: 'mainwp-sites',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'integer', description: 'Site ID' },
        confirm: { type: 'boolean', description: 'Confirm deletion' },
        dry_run: { type: 'boolean', description: 'Preview mode' },
      },
      required: ['site_id'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: true,
        idempotent: true, // DELETE: destructive + idempotent
      },
    },
  },
  {
    name: 'mainwp/delete-client-v1',
    label: 'Delete Client',
    description: 'Delete a client',
    category: 'mainwp-clients',
    input_schema: {
      type: 'object',
      properties: {
        client_id_or_email: { type: ['integer', 'string'], description: 'Client ID or email' },
        confirm: { type: 'boolean', description: 'Confirm deletion' },
        dry_run: { type: 'boolean', description: 'Preview mode' },
      },
      required: ['client_id_or_email'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: true,
        idempotent: true, // DELETE: destructive + idempotent
      },
    },
  },
  {
    name: 'mainwp/delete-tag-v1',
    label: 'Delete Tag',
    description: 'Delete a tag',
    category: 'mainwp-tags',
    input_schema: {
      type: 'object',
      properties: {
        tag_id: { type: 'integer', description: 'Tag ID' },
        confirm: { type: 'boolean', description: 'Confirm deletion' },
        dry_run: { type: 'boolean', description: 'Preview mode' },
      },
      required: ['tag_id'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: true,
        idempotent: true, // DELETE: destructive + idempotent
      },
    },
  },
  {
    name: 'mainwp/delete-site-plugins-v1',
    label: 'Delete Site Plugins',
    description: 'Delete plugins from a site',
    category: 'mainwp-sites',
    input_schema: {
      type: 'object',
      properties: {
        site_id_or_domain: { type: ['integer', 'string'], description: 'Site ID or domain' },
        plugins: { type: 'array', items: { type: 'string' }, description: 'Plugin slugs' },
        confirm: { type: 'boolean', description: 'Confirm deletion' },
        dry_run: { type: 'boolean', description: 'Preview mode' },
      },
      required: ['site_id_or_domain', 'plugins'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: true,
        idempotent: true, // DELETE: destructive + idempotent
      },
    },
  },
  {
    name: 'mainwp/delete-site-themes-v1',
    label: 'Delete Site Themes',
    description: 'Delete themes from a site',
    category: 'mainwp-sites',
    input_schema: {
      type: 'object',
      properties: {
        site_id_or_domain: { type: ['integer', 'string'], description: 'Site ID or domain' },
        themes: { type: 'array', items: { type: 'string' }, description: 'Theme slugs' },
        confirm: { type: 'boolean', description: 'Confirm deletion' },
        dry_run: { type: 'boolean', description: 'Preview mode' },
      },
      required: ['site_id_or_domain', 'themes'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: true,
        idempotent: true, // DELETE: destructive + idempotent
      },
    },
  },
  {
    name: 'mainwp/update-site-v1',
    label: 'Update Site',
    description: 'Update site settings',
    category: 'mainwp-sites',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'integer', description: 'Site ID' },
        name: { type: 'string', description: 'New site name' },
      },
      required: ['site_id'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: false, // POST: not destructive
        idempotent: true,
      },
    },
  },
];

const sampleCategories = [{ slug: 'mainwp-sites', label: 'Sites', description: 'Site management' }];

const baseConfig = makeBaseConfig();

describe('fetchAbilities', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    initRateLimiter(0); // Disable rate limiting
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch and cache abilities', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig);

    expect(abilities).toHaveLength(7);
    expect(abilities[0].name).toBe('mainwp/list-sites-v1');
  });

  it('should return cached data within TTL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // First call fetches
    await fetchAbilities(baseConfig);

    // Second call should use cache
    await fetchAbilities(baseConfig);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('skips malformed ability entries instead of failing the whole refresh', async () => {
    const hostileAbilities = [
      null,
      'junk',
      { name: 42, label: 'Numeric name' },
      { label: 'No name at all' },
      ...sampleAbilities,
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => hostileAbilities,
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig);

    expect(abilities).toHaveLength(7);
    expect(abilities.every(a => typeof a.name === 'string')).toBe(true);
  });

  it('does not share cache across configs that differ in transport-security settings', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await fetchAbilities(baseConfig);
    // Same dashboard and identity, but TLS verification disabled: a strict
    // instance must not serve data fetched by a lax one (or vice versa).
    await fetchAbilities({ ...baseConfig, skipSslVerify: !baseConfig.skipSslVerify });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should force refresh when requested', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await fetchAbilities(baseConfig);
    await fetchAbilities(baseConfig, true); // Force refresh

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should filter by namespace (default: mainwp only)', async () => {
    const mixedAbilities = [
      ...sampleAbilities,
      { name: 'other/some-ability', label: 'Other', description: 'Other', category: 'other' },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mixedAbilities,
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig);

    expect(abilities).toHaveLength(7);
    expect(abilities.every(a => a.name.startsWith('mainwp/'))).toBe(true);
  });

  it('keeps abilities from any configured namespace', async () => {
    const mixedAbilities = [
      ...sampleAbilities,
      { name: 'acme/do-thing-v1', label: 'Acme Do', description: 'Acme', category: 'acme-misc' },
      { name: 'other/skip-me-v1', label: 'Other', description: 'Skip', category: 'other-misc' },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mixedAbilities,
      headers: new Headers(),
    });

    const multiNsConfig: Config = { ...baseConfig, abilityNamespaces: ['mainwp', 'acme'] };
    const abilities = await fetchAbilities(multiNsConfig);

    expect(abilities.map(a => a.name)).toContain('acme/do-thing-v1');
    expect(abilities.map(a => a.name)).not.toContain('other/skip-me-v1');
  });

  it('warns when the namespace filter leaves zero abilities', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const acmeOnlyConfig: Config = { ...baseConfig, abilityNamespaces: ['acme'] };
    const abilities = await fetchAbilities(acmeOnlyConfig, false, mockLogger);

    expect(abilities).toHaveLength(0);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'No abilities matched the configured namespaces',
      expect.objectContaining({
        namespaces: ['acme'],
        fetchedCount: sampleAbilities.length,
      })
    );
  });

  it('warns with a distinct message when the upstream returns no abilities', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig, false, mockLogger);

    expect(abilities).toHaveLength(0);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Dashboard returned no abilities',
      expect.objectContaining({ namespaces: ['mainwp'] })
    );
    expect(mockLogger.warning).not.toHaveBeenCalledWith(
      'No abilities matched the configured namespaces',
      expect.anything()
    );
  });

  it('does not warn about empty namespace match when abilities are found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig, false, mockLogger);

    expect(abilities.length).toBeGreaterThan(0);
    expect(mockLogger.warning).not.toHaveBeenCalledWith(
      'No abilities matched the configured namespaces',
      expect.anything()
    );
  });

  it('refreshes cache when abilityNamespaces changes between calls', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        ...sampleAbilities,
        { name: 'acme/do-thing-v1', label: 'Acme', description: 'Acme', category: 'acme-misc' },
      ],
      headers: new Headers(),
    });

    await fetchAbilities(baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Different namespace allowlist must invalidate the cache despite fresh TTL.
    await fetchAbilities({ ...baseConfig, abilityNamespaces: ['mainwp', 'acme'] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('drops abilities with malformed names before they reach the tool index', async () => {
    const payload = [
      ...sampleAbilities,
      {
        name: 'mainwp/sub/path-name',
        label: 'Malformed',
        description: 'Extra slash should be filtered out',
        category: 'mainwp-misc',
        meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
      },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => payload,
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig, true, mockLogger);

    expect(abilities.map(a => a.name)).not.toContain('mainwp/sub/path-name');
    expect(abilities.length).toBe(sampleAbilities.length);
    expect(await getAbilityByToolName(baseConfig, 'sub/path_name')).toBeUndefined();
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Skipping ability with malformed name',
      expect.objectContaining({ name: expect.stringContaining('sub/path-name') })
    );
  });

  it('keeps the existing index intact when a refresh hits the collision throw', async () => {
    // Warm cache with a clean ability set.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig);

    // Force a refresh that returns malformed data — two abilities with the
    // same name produce the same tool name and trip the collision check.
    // The failed refresh must leave the cached abilities array and its
    // abilityIndexes entry intact, so a tool-name lookup for any ability
    // from the first fetch still resolves.
    const dupedPayload = [sampleAbilities[0], sampleAbilities[0]];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => dupedPayload,
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig, true, mockLogger);

    const delAbility = await getAbilityByToolName(baseConfig, 'delete_site_v1');
    expect(delAbility?.name).toBe('mainwp/delete-site-v1');
  });

  it('discards cache and re-throws when signature mismatches and refresh fails', async () => {
    // Populate cache for ['mainwp'] successfully.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Now request ['mainwp','acme'] but the refresh fails. The catch block must
    // NOT serve the cache built for the wrong namespace; it must surface the error.
    mockFetch.mockRejectedValueOnce(new Error('Network blip'));
    await expect(
      fetchAbilities({ ...baseConfig, abilityNamespaces: ['mainwp', 'acme'] })
    ).rejects.toThrow(/Network blip/);

    // Emptying the cache slot dropped the abilities array and with it the
    // WeakMap-keyed lookup indexes, so a tool-name lookup must trigger a
    // fresh fetch rather than returning stale data.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    const ability = await getAbilityByToolName(baseConfig, 'list_sites_v1');
    expect(ability?.name).toBe('mainwp/list-sites-v1');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not share cached abilities across authentication identities', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Same dashboard and namespaces but a different user: WordPress can
    // expose a different ability catalog per user, so this must refetch
    // instead of serving the first user's cached list.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [sampleAbilities[0]],
      headers: new Headers(),
    });
    const otherUserAbilities = await fetchAbilities({ ...baseConfig, username: 'bob' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(otherUserAbilities).toHaveLength(1);
  });

  it('should handle fetch errors with cached fallback', async () => {
    // First successful fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await fetchAbilities(baseConfig);
    clearCache(); // Clear to simulate TTL expiry

    // Re-add to cache for fallback test
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig);

    // Now simulate error
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // Should return cached data
    const abilities = await fetchAbilities(baseConfig, true);

    expect(abilities).toHaveLength(7);
  });

  it('should log warning via logger when using cached fallback', async () => {
    vi.resetAllMocks();

    // Warm cache
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig);

    // Force refresh that fails — should use cache and call logger.warning
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const abilities = await fetchAbilities(baseConfig, true, mockLogger);

    expect(abilities).toHaveLength(7);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to refresh abilities, using cached data',
      expect.objectContaining({
        error: expect.stringContaining('Network error'),
        cacheAgeMinutes: expect.any(Number),
      })
    );
  });

  it('should throw when no cache and fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(fetchAbilities(baseConfig)).rejects.toThrow('Network error');
  });

  it('should handle HTTP error responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid credentials',
      headers: new Headers(),
    });

    await expect(fetchAbilities(baseConfig)).rejects.toThrow(/401/);
  });

  it('should share one upstream fetch across concurrent callers', async () => {
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        })
    );

    const first = fetchAbilities(baseConfig);
    const second = fetchAbilities(baseConfig);

    resolveFetch({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const [a, b] = await Promise.all([first, second]);

    expect(a).toHaveLength(7);
    expect(b).toBe(a);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should attach a structured status to HTTP error responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid credentials',
      headers: new Headers(),
    });

    await expect(fetchAbilities(baseConfig)).rejects.toMatchObject({ status: 401 });
  });

  it('should not share an in-flight fetch across different dashboards', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    mockFetch.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvers.push(resolve);
        })
    );

    const first = fetchAbilities(baseConfig);
    const second = fetchAbilities({ ...baseConfig, dashboardUrl: 'https://other.local' });

    // Different dashboard must NOT join the first request
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1][0])).toContain('other.local');

    for (const resolve of resolvers) {
      resolve({ ok: true, json: async () => sampleAbilities, headers: new Headers() });
    }
    await Promise.all([first, second]);
  });

  it('should not discard a newer cache committed while a failing refresh was in flight', async () => {
    let rejectFirst!: (e: Error) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject;
        })
    );
    const failing = fetchAbilities(baseConfig);

    // A different config commits successfully while the first is in flight
    const otherConfig = { ...baseConfig, dashboardUrl: 'https://other.local' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    await fetchAbilities(otherConfig);

    rejectFirst(new Error('Network error'));
    await expect(failing).rejects.toThrow('Network error');

    // The newer cache must survive the older refresh's failure — this call
    // is served from cache, not a third upstream fetch
    await fetchAbilities(otherConfig);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should paginate when X-WP-TotalPages > 1', async () => {
    vi.resetAllMocks();

    // Page 1: returns 3 abilities with 2 pages total
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities.slice(0, 3),
      headers: new Headers({ 'X-WP-TotalPages': '2' }),
    });

    // Page 2: returns remaining abilities
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities.slice(3),
      headers: new Headers({ 'X-WP-TotalPages': '2' }),
    });

    const abilities = await fetchAbilities(baseConfig, false, mockLogger);

    // All abilities should be fetched across both pages
    expect(abilities).toHaveLength(7);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fetched 7 abilities across 2 pages')
    );
  });

  it('should NOT set NODE_TLS_REJECT_UNAUTHORIZED when skipSslVerify is true (uses per-request dispatcher)', async () => {
    const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await fetchAbilities(baseConfig, true);

    // Per-request undici dispatcher handles TLS — process env must remain unchanged
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(original);
  });
});

describe('fetchCategories', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch and cache categories', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleCategories,
      headers: new Headers(),
    });

    const categories = await fetchCategories(baseConfig);

    expect(categories).toHaveLength(1);
    expect(categories[0].slug).toBe('mainwp-sites');
  });

  it('should filter categories by namespace', async () => {
    const mixedCategories = [
      ...sampleCategories,
      { slug: 'other-category', label: 'Other', description: 'Other' },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mixedCategories,
      headers: new Headers(),
    });

    const categories = await fetchCategories(baseConfig);

    expect(categories).toHaveLength(1);
    expect(categories[0].slug).toBe('mainwp-sites');
  });

  it('includes categories from any configured namespace', async () => {
    const mixedCategories = [
      ...sampleCategories,
      { slug: 'acme-things', label: 'Acme', description: 'Acme stuff' },
      { slug: 'other-skip', label: 'Other', description: 'Should be skipped' },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mixedCategories,
      headers: new Headers(),
    });

    const config: Config = { ...baseConfig, abilityNamespaces: ['mainwp', 'acme'] };
    const categories = await fetchCategories(config);

    expect(categories.map(c => c.slug).sort()).toEqual(['acme-things', 'mainwp-sites']);
  });

  it('surfaces categories for prefix-related namespaces (acme vs acme-corp)', async () => {
    const mixedCategories = [
      { slug: 'acme-foo', label: 'Acme Foo', description: 'Acme category' },
      { slug: 'acme-corp-bar', label: 'Acme Corp Bar', description: 'Acme Corp category' },
      { slug: 'other-skip', label: 'Other', description: 'Should be skipped' },
    ];

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => mixedCategories,
      headers: new Headers(),
    });

    // Both prefix-related namespaces configured: both categories surface.
    const both: Config = { ...baseConfig, abilityNamespaces: ['acme', 'acme-corp'] };
    const categories = await fetchCategories(both);
    expect(categories.map(c => c.slug).sort()).toEqual(['acme-corp-bar', 'acme-foo']);

    // Known limitation (see isAllowedCategory): with only 'acme' configured,
    // 'acme-corp-bar' still passes the prefix filter because category slugs
    // carry no explicit namespace field. Pinned here so a future change to
    // this behavior is a conscious one.
    const acmeOnly: Config = { ...baseConfig, abilityNamespaces: ['acme'] };
    const acmeCategories = await fetchCategories(acmeOnly);
    expect(acmeCategories.map(c => c.slug).sort()).toEqual(['acme-corp-bar', 'acme-foo']);
  });

  it('refreshes cache when abilityNamespaces changes between calls', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        ...sampleCategories,
        { slug: 'acme-things', label: 'Acme', description: 'Acme stuff' },
      ],
      headers: new Headers(),
    });

    await fetchCategories(baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Different namespace allowlist must invalidate the cache despite fresh
    // TTL, matching the equivalent fetchAbilities behavior.
    await fetchCategories({ ...baseConfig, abilityNamespaces: ['mainwp', 'acme'] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should paginate when X-WP-TotalPages > 1', async () => {
    vi.resetAllMocks();

    const extraCategories = [
      { slug: 'mainwp-clients', label: 'Clients', description: 'Client management' },
    ];

    // Page 1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleCategories,
      headers: new Headers({ 'X-WP-TotalPages': '2' }),
    });

    // Page 2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => extraCategories,
      headers: new Headers({ 'X-WP-TotalPages': '2' }),
    });

    const categories = await fetchCategories(baseConfig, false, mockLogger);

    expect(categories).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should log warning via logger when using cached fallback', async () => {
    vi.resetAllMocks();

    // Warm cache
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleCategories,
      headers: new Headers(),
    });
    await fetchCategories(baseConfig);

    // Force refresh that fails — should use cache and call logger.warning
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const categories = await fetchCategories(baseConfig, true, mockLogger);

    expect(categories).toHaveLength(1);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to refresh categories, using cached data',
      expect.objectContaining({
        error: expect.stringContaining('Network error'),
        cacheAgeMinutes: expect.any(Number),
      })
    );
  });
});

describe('getAbility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
  });

  it('should find ability by name', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const ability = await getAbility(baseConfig, 'mainwp/list-sites-v1');

    expect(ability).toBeDefined();
    expect(ability?.label).toBe('List Sites');
  });

  it('should return undefined for unknown ability', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const ability = await getAbility(baseConfig, 'mainwp/unknown');

    expect(ability).toBeUndefined();
  });

  it('should use index Map for O(1) lookup after cache is warm', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // First call warms cache and index
    const ability1 = await getAbility(baseConfig, 'mainwp/list-sites-v1');
    expect(ability1).toBeDefined();

    // Second call should use cached index, no new fetch
    const ability2 = await getAbility(baseConfig, 'mainwp/list-sites-v1');
    expect(ability2).toBeDefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('getAbilityByToolName', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves primary-namespace tool name (unprefixed)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const ability = await getAbilityByToolName(baseConfig, 'list_sites_v1');
    expect(ability?.name).toBe('mainwp/list-sites-v1');
  });

  it('resolves non-primary namespace tool name ({ns}__ prefix)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        ...sampleAbilities,
        {
          name: 'acme/do-thing-v1',
          label: 'Acme Do',
          description: 'Acme',
          category: 'acme-misc',
          meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
        },
      ],
      headers: new Headers(),
    });

    const config: Config = { ...baseConfig, abilityNamespaces: ['mainwp', 'acme'] };
    const ability = await getAbilityByToolName(config, 'acme__do_thing_v1');
    expect(ability?.name).toBe('acme/do-thing-v1');
  });

  it('returns undefined for unknown tool name', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const ability = await getAbilityByToolName(baseConfig, 'totally_unknown_tool');
    expect(ability).toBeUndefined();
  });
});

describe('executeAbility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // HTTP Method Selection Tests
  // Rules: GET (readonly), DELETE (destructive + idempotent), POST (everything else)

  it('should use GET for readonly abilities', async () => {
    // First mock for fetchAbilities
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // Second mock for executeAbility
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
      headers: new Headers(),
    });

    await executeAbility(baseConfig, 'mainwp/list-sites-v1', {});

    // Check the second call was GET
    const calls = mockFetch.mock.calls;
    expect(calls[1][1].method).toBe('GET');
  });

  it.each([
    ['mainwp/delete-site-v1', { site_id: 1, confirm: true }],
    ['mainwp/delete-client-v1', { client_id_or_email: 1, confirm: true }],
    ['mainwp/delete-tag-v1', { tag_id: 1, confirm: true }],
    [
      'mainwp/delete-site-plugins-v1',
      { site_id_or_domain: 1, plugins: ['test-plugin/test-plugin.php'], confirm: true },
    ],
    [
      'mainwp/delete-site-themes-v1',
      { site_id_or_domain: 1, themes: ['twentytwentyfour'], confirm: true },
    ],
  ])(
    'should use DELETE for destructive + idempotent abilities (%s)',
    async (abilityName, input) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleAbilities,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ deleted: true }),
        headers: new Headers(),
      });

      await executeAbility(baseConfig, abilityName, input);

      const calls = mockFetch.mock.calls;
      expect(calls[1][1].method).toBe('DELETE');
    }
  );

  it('should use POST for non-destructive write abilities', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ updated: true }),
      headers: new Headers(),
    });

    await executeAbility(baseConfig, 'mainwp/update-site-v1', { site_id: 1, name: 'New Name' });

    const calls = mockFetch.mock.calls;
    expect(calls[1][1].method).toBe('POST');
  });

  it('should use POST for destructive non-idempotent abilities', async () => {
    const destructiveNonIdempotentAbility: Ability = {
      ...sampleAbilities[1],
      meta: {
        annotations: {
          readonly: false,
          destructive: true,
          idempotent: false,
        },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [destructiveNonIdempotentAbility],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
      headers: new Headers(),
    });

    await executeAbility(baseConfig, 'mainwp/delete-site-v1', { site_id: 1, confirm: true });

    const request = mockFetch.mock.calls[1][1];
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body as string)).toEqual({ input: { site_id: 1, confirm: true } });
  });

  it('should serialize input to query string for DELETE requests', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ dry_run: true }),
      headers: new Headers(),
    });

    await executeAbility(baseConfig, 'mainwp/delete-site-v1', { site_id: 1, dry_run: true });

    const calls = mockFetch.mock.calls;
    const url = calls[1][0] as string;
    // DELETE uses query string, not JSON body
    expect(url).toContain('input[site_id]=1');
    expect(url).toContain('input[dry_run]=true');
    // Should not have a body
    expect(calls[1][1].body).toBeUndefined();
  });

  it('should throw when ability not found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await expect(executeAbility(baseConfig, 'mainwp/unknown', {})).rejects.toThrow(
      /Ability not found/
    );
  });

  it('should throw McpError with ABILITY_NOT_FOUND code for unknown ability', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    try {
      await executeAbility(baseConfig, 'mainwp/unknown', {});
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(MCP_ERROR_CODES.ABILITY_NOT_FOUND);
    }
  });

  it('should handle error responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ code: 'invalid_param', message: 'Bad parameter' }),
      headers: new Headers(),
    });

    await expect(executeAbility(baseConfig, 'mainwp/list-sites-v1', {})).rejects.toThrow(
      /invalid_param/
    );
  });

  it('should serialize input to query string for GET requests', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
      headers: new Headers(),
    });

    await executeAbility(baseConfig, 'mainwp/list-sites-v1', { page: 2 });

    const calls = mockFetch.mock.calls;
    const url = calls[1][0] as string;
    expect(url).toContain('input[page]=2');
  });

  it('preserves one-level object and scalar-array query encoding', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
      headers: new Headers(),
    });

    await executeAbility(baseConfig, 'mainwp/list-sites-v1', {
      filters: { status: 'active', count: 2 },
      ids: [1, 'two'],
    });

    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain('input[filters][status]=active');
    expect(url).toContain('input[filters][count]=2');
    expect(url).toContain('input[ids][]=1');
    expect(url).toContain('input[ids][]=two');
  });

  it('rejects objects nested deeper than one level and names the offending key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await expect(
      executeAbility(baseConfig, 'mainwp/list-sites-v1', {
        filters: { status: { value: 'active' } },
      })
    ).rejects.toMatchObject({
      code: MCP_ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('filters'),
    });
  });

  it('rejects arrays containing objects and names the offending key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await expect(
      executeAbility(baseConfig, 'mainwp/list-sites-v1', {
        filters: [{ status: 'active' }],
      })
    ).rejects.toMatchObject({
      code: MCP_ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('filters'),
    });
  });

  it('should throw when GET URL exceeds 8000 characters', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // Create input with a very long string parameter that will produce a URL > 8000 chars
    const longValue = 'x'.repeat(8000);
    await expect(
      executeAbility(baseConfig, 'mainwp/list-sites-v1', { filter: longValue })
    ).rejects.toThrow(/URL exceeds 8000 characters/);
  });

  it('logs destructive previews as previewed and never executed', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ preview: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await executeAbility(
      baseConfig,
      'mainwp/delete-site-v1',
      { site_id: 1, dry_run: true },
      mockLogger,
      sampleAbilities[1]
    );
    expect(mockLogger.info).toHaveBeenCalledWith('AUDIT: destructive operation previewed', {
      abilityName: 'mainwp/delete-site-v1',
    });
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'AUDIT: destructive operation executed',
      expect.anything()
    );
  });

  it('does not log destructive operations as executed after a 5xx failure', async () => {
    mockFetch.mockResolvedValueOnce(new Response('failure', { status: 500 }));
    await expect(
      executeAbility(
        baseConfig,
        'mainwp/delete-site-v1',
        { site_id: 1 },
        mockLogger,
        sampleAbilities[1]
      )
    ).rejects.toThrow(/Ability execution failed/);
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'AUDIT: destructive operation executed',
      expect.anything()
    );
  });

  it('does not log destructive operations as executed after cancellation', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeAbility(
        baseConfig,
        'mainwp/delete-site-v1',
        { site_id: 1 },
        mockLogger,
        sampleAbilities[1],
        controller.signal
      )
    ).rejects.toThrow();
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'AUDIT: destructive operation executed',
      expect.anything()
    );
  });

  it('logs a successful destructive execution exactly once', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await executeAbility(
      baseConfig,
      'mainwp/delete-site-v1',
      { site_id: 1 },
      mockLogger,
      sampleAbilities[1]
    );
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith('AUDIT: destructive operation executed', {
      abilityName: 'mainwp/delete-site-v1',
    });
  });
});

describe('clearCache', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should clear cached abilities', async () => {
    // First fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await fetchAbilities(baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Clear cache
    clearCache();

    // Second fetch should make new request
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await fetchAbilities(baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should clear cached categories', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleCategories,
      headers: new Headers(),
    });

    await fetchCategories(baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    clearCache();

    await fetchCategories(baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should clear the abilities index', async () => {
    // Warm cache and index
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await getAbility(baseConfig, 'mainwp/list-sites-v1');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Clear cache (and index)
    clearCache();

    // Next getAbility should trigger a new fetch since index was cleared
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await getAbility(baseConfig, 'mainwp/list-sites-v1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should clear the toolName index', async () => {
    // Warm the cache and its tool-name lookup index
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const beforeClear = await getAbilityByToolName(baseConfig, 'list_sites_v1');
    expect(beforeClear?.name).toBe('mainwp/list-sites-v1');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Clear the cache, dropping the abilities array and its WeakMap-keyed indexes
    clearCache();

    // Next getAbilityByToolName should trigger a new fetch — if clearCache left
    // the cached array in place, the lookup would silently resolve through its
    // stale indexes and skip the fetch.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const afterClear = await getAbilityByToolName(baseConfig, 'list_sites_v1');
    expect(afterClear?.name).toBe('mainwp/list-sites-v1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('onCacheRefresh', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
  });

  it('should notify callbacks on cache refresh with changes', async () => {
    const callback = vi.fn();
    onCacheRefresh(callback);

    // First fetch - establishes cache
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig);

    // Second fetch with different abilities - should trigger callback
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [sampleAbilities[0]], // Different list
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig, true);

    expect(callback).toHaveBeenCalled();
  });

  it('notifies when a same-named ability changes schema and annotations', async () => {
    const callback = vi.fn();
    onCacheRefresh(callback);
    const original = sampleAbilities[0];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [original],
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ...original,
          description: 'Changed description',
          input_schema: {
            type: 'object',
            properties: { page: { type: 'integer' } },
          },
          meta: {
            ...original.meta,
            annotations: { ...original.meta?.annotations, readonly: false },
          },
        },
      ],
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig, true);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('notifies when a same-named ability changes label or category', async () => {
    const callback = vi.fn();
    onCacheRefresh(callback);
    const original = sampleAbilities[0];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [original],
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig);

    // label becomes the MCP annotation title; category becomes the standard-mode
    // description prefix — both affect tool conversion, so a change must notify.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...original, label: 'Renamed Label', category: 'mainwp-renamed' }],
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig, true);

    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('generateToolHelp', () => {
  it('should generate help for a simple ability', () => {
    const ability = sampleAbilities[0];
    const help = generateToolHelp(ability, 'mainwp');

    expect(help.toolName).toBe('list_sites_v1');
    expect(help.abilityName).toBe('mainwp/list-sites-v1');
    expect(help.label).toBe('List Sites');
    expect(help.annotations.readonly).toBe(true);
    expect(help.annotations.destructive).toBe(false);
  });

  it('should detect safety features', () => {
    const ability = sampleAbilities[1];
    const help = generateToolHelp(ability, 'mainwp');

    expect(help.safetyFeatures.supportsDryRun).toBe(true);
    expect(help.safetyFeatures.requiresConfirm).toBe(true);
    expect(help.annotations.destructive).toBe(true);
  });

  it('should include parameters', () => {
    const ability = sampleAbilities[1];
    const help = generateToolHelp(ability, 'mainwp');

    expect(help.parameters).toContainEqual(
      expect.objectContaining({ name: 'site_id', required: true })
    );
    expect(help.parameters).toContainEqual(
      expect.objectContaining({ name: 'confirm', required: false })
    );
  });
});

describe('generateHelpDocument', () => {
  it('should generate complete help document', () => {
    const helpDoc = generateHelpDocument(sampleAbilities, 'mainwp');

    expect(helpDoc.version).toBe('1.0');
    expect(helpDoc.overview.totalTools).toBe(7);
    expect(helpDoc.overview.categories).toContain('mainwp-sites');
  });

  it('should list destructive tools', () => {
    const helpDoc = generateHelpDocument(sampleAbilities, 'mainwp');

    expect(helpDoc.destructiveTools).toContain('delete_site_v1');
    expect(helpDoc.destructiveTools).not.toContain('list_sites_v1');
  });

  it('should list tools with dry_run', () => {
    const helpDoc = generateHelpDocument(sampleAbilities, 'mainwp');

    expect(helpDoc.toolsWithDryRun).toContain('delete_site_v1');
  });

  it('should list tools requiring confirm', () => {
    const helpDoc = generateHelpDocument(sampleAbilities, 'mainwp');

    expect(helpDoc.toolsRequiringConfirm).toContain('delete_site_v1');
  });

  it('should group tools by category', () => {
    const helpDoc = generateHelpDocument(sampleAbilities, 'mainwp');

    // mainwp-sites has: list-sites, delete-site, delete-site-plugins, delete-site-themes, update-site
    expect(helpDoc.toolsByCategory['mainwp-sites']).toHaveLength(5);
  });

  it('should include safety conventions', () => {
    const helpDoc = generateHelpDocument(sampleAbilities, 'mainwp');

    expect(helpDoc.overview.safetyConventions).toHaveProperty('dryRun');
    expect(helpDoc.overview.safetyConventions).toHaveProperty('confirm');
    expect(helpDoc.overview.safetyConventions).toHaveProperty('destructive');
  });
});

describe('readLimitedBody', () => {
  it('should read a streaming response body within size limit', async () => {
    const data = 'hello world';
    const encoded = new TextEncoder().encode(data);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    const response = new Response(stream);

    const result = await readLimitedBody(response, 1000);
    expect(result).toBe(data);
  });

  it('should reject a streaming response exceeding maxBytes', async () => {
    const chunk = new Uint8Array(5000).fill(65); // 5KB of 'A'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk); // 10KB total
        controller.close();
      },
    });
    const response = new Response(stream);

    await expect(readLimitedBody(response, 8000)).rejects.toThrow(
      /Response body exceeds 8000 bytes limit/
    );
  });

  it('should reject mid-stream when a chunk pushes past the limit', async () => {
    const smallChunk = new Uint8Array(100).fill(65);
    const bigChunk = new Uint8Array(10000).fill(66);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(smallChunk); // 100 bytes — OK
        controller.enqueue(bigChunk); // 10100 bytes total — exceeds 5000
        controller.close();
      },
    });
    const response = new Response(stream);

    await expect(readLimitedBody(response, 5000)).rejects.toThrow(
      /Response body exceeds 5000 bytes limit/
    );
  });

  it('should fall back to response.text() when body is unavailable', async () => {
    const mockResponse = {
      body: null,
      text: async () => 'fallback text',
    } as unknown as Response;

    const result = await readLimitedBody(mockResponse, 1000);
    expect(result).toBe('fallback text');
  });

  it('should reject via fallback when text exceeds maxBytes', async () => {
    const mockResponse = {
      body: null,
      text: async () => 'x'.repeat(2000),
    } as unknown as Response;

    await expect(readLimitedBody(mockResponse, 1000)).rejects.toThrow(
      /Response body exceeds 1000 bytes limit/
    );
  });

  it('should fall back to response.json() when text is unavailable', async () => {
    const mockResponse = {
      body: null,
      json: async () => ({ key: 'value' }),
    } as unknown as Response;

    const result = await readLimitedBody(mockResponse, 1000);
    expect(result).toBe('{"key":"value"}');
  });

  it('surfaces ETIMEDOUT when the request deadline expires during a body read', async () => {
    mockFetch.mockImplementationOnce((_url, options: RequestInit) => {
      const signal = options.signal as AbortSignal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        },
      });
      return Promise.resolve(new Response(stream));
    });
    const customFetch = createFetch(makeBaseConfig({ requestTimeout: 20 }));

    const response = await customFetch('https://test.local/stalled');

    await expect(readLimitedBody(response, 1000)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('preserves AbortError for external cancellation during a body read', async () => {
    mockFetch.mockImplementationOnce((_url, options: RequestInit) => {
      const signal = options.signal as AbortSignal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        },
      });
      return Promise.resolve(new Response(stream));
    });
    const externalController = new AbortController();
    const customFetch = createFetch(makeBaseConfig({ requestTimeout: 1000 }));
    const response = await customFetch('https://test.local/cancelled', {
      signal: externalController.signal,
    });

    externalController.abort();

    await expect(readLimitedBody(response, 1000)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('paginateApi', () => {
  it('does not warn when all 50 reported pages are fetched', async () => {
    const logger = makeMockLogger();
    const customFetch = vi.fn(
      async () => new Response('[]', { headers: { 'X-WP-TotalPages': '50' } })
    );

    await paginateApi(customFetch, 'https://test.local/items', 'items', 1000, logger);

    expect(customFetch).toHaveBeenCalledTimes(50);
    expect(logger.warning).not.toHaveBeenCalled();
  });

  it('warns when reported pages exceed the 50-page cap', async () => {
    const logger = makeMockLogger();
    const customFetch = vi.fn(
      async () => new Response('[]', { headers: { 'X-WP-TotalPages': '51' } })
    );

    await paginateApi(customFetch, 'https://test.local/items', 'items', 1000, logger);

    expect(customFetch).toHaveBeenCalledTimes(50);
    expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('Pagination capped'));
  });
});
