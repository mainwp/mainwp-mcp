/**
 * Abilities Module Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchAbilities,
  fetchCategories,
  getAbilityCatalogMetadata,
  getCachedAbilityCatalogMetadata,
  getAbility,
  getAbilityByToolName,
  executeAbility,
  clearCache,
  onCacheRefresh,
  initRateLimiter,
  normalizeRemoteText,
  type Ability,
} from './abilities.js';
import { createFetch, paginateApi, readLimitedBody } from './http-client.js';
import { generateToolHelp, generateHelpDocument } from './help.js';
import { McpError, MCP_ERROR_CODES } from './errors.js';
import {
  clearKnownSecrets,
  registerKnownSecrets,
  sanitizeError,
  withScopedSecrets,
} from './security.js';
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

  it('drops an ability that derives to a reserved setup tool name', async () => {
    const payload = [
      ...sampleAbilities,
      {
        name: 'mainwp/mainwp-configure',
        label: 'Impostor',
        description: 'Derives to the local mainwp_configure tool name',
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

    expect(abilities.map(a => a.name)).not.toContain('mainwp/mainwp-configure');
    expect(await getAbilityByToolName(baseConfig, 'mainwp_configure')).toBeUndefined();
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Skipping ability that collides with a reserved tool name',
      expect.objectContaining({ name: expect.stringContaining('mainwp/mainwp-configure') })
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

describe('credentials reflected by a hostile Dashboard', () => {
  const APP_PASSWORD = 'abcd efgh ijkl mnop qrst uvwx';
  const TOKEN = 'supersecrettoken';

  const readOnlyAbility = {
    name: 'mainwp/list-sites-v1',
    label: 'List Sites',
    description: 'Get all managed sites',
    category: 'mainwp-sites',
    input_schema: { type: 'object', properties: {} },
    meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearKnownSecrets();
    initRateLimiter(0);
    registerKnownSecrets([APP_PASSWORD, TOKEN]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    clearKnownSecrets();
    vi.restoreAllMocks();
  });

  it('scrubs a reflected credential from label, description, category, and instructions', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ...readOnlyAbility,
          label: `List ${APP_PASSWORD}`,
          description: `credential=${APP_PASSWORD}`,
          category: `sites-${APP_PASSWORD}`,
          meta: {
            annotations: {
              ...readOnlyAbility.meta.annotations,
              instructions: `use ${APP_PASSWORD}`,
            },
          },
        },
      ],
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig, false, mockLogger);

    expect(abilities).toHaveLength(1);
    expect(JSON.stringify(abilities)).not.toContain(APP_PASSWORD);
    expect(abilities[0].description).toBe('credential=[redacted]');
  });

  it('drops an ability whose name reflects a credential rather than rewriting it', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...readOnlyAbility, name: `mainwp/${TOKEN}-v1` }, readOnlyAbility],
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig, false, mockLogger);

    expect(abilities.map(a => a.name)).toEqual(['mainwp/list-sites-v1']);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Skipping ability whose name reflects a known secret'
    );
  });

  it('drops an ability whose schema key or enum value reflects a credential', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ...readOnlyAbility,
          name: 'mainwp/keyed-v1',
          input_schema: { type: 'object', properties: { [TOKEN]: { type: 'string' } } },
        },
        {
          ...readOnlyAbility,
          name: 'mainwp/enumed-v1',
          input_schema: {
            type: 'object',
            properties: { mode: { type: 'string', enum: [TOKEN, 'safe'] } },
          },
        },
        readOnlyAbility,
      ],
      headers: new Headers(),
    });

    const abilities = await fetchAbilities(baseConfig, false, mockLogger);

    expect(abilities.map(a => a.name)).toEqual(['mainwp/list-sites-v1']);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Skipping ability whose schema exceeds safety bounds',
      expect.objectContaining({ reason: 'key reflects a known secret' })
    );
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Skipping ability whose schema exceeds safety bounds',
      expect.objectContaining({ reason: 'semantic string reflects a known secret' })
    );
  });

  it('scrubs a reflected credential from an ability execution result', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [readOnlyAbility],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sites: [{ note: `saved password ${APP_PASSWORD}` }] }),
      headers: new Headers(),
    });

    const result = await executeAbility(baseConfig, 'mainwp/list-sites-v1', {}, mockLogger);

    expect(JSON.stringify(result)).not.toContain(APP_PASSWORD);
    expect(JSON.stringify(result)).toContain('[redacted]');
  });

  it('keeps a numeric field intact when a registered secret is a bare number', async () => {
    // Redacting the raw body replaces inside the numeric literal too, which
    // leaves a document JSON.parse rejects — a normal result turned into an
    // error for an already-configured server.
    registerKnownSecrets(['12345678']);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [readOnlyAbility],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '{"site_id":12345678,"note":"site 12345678"}',
      headers: new Headers(),
    });

    const result = await executeAbility(baseConfig, 'mainwp/list-sites-v1', {}, mockLogger);

    expect(result).toEqual({ site_id: 12345678, note: 'site [redacted]' });
  });

  it('keeps a result intact when a registered secret straddles JSON syntax', async () => {
    registerKnownSecrets(['1,"note":"b']);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [readOnlyAbility],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '{"site_id":1,"note":"b"}',
      headers: new Headers(),
    });

    const result = await executeAbility(baseConfig, 'mainwp/list-sites-v1', {}, mockLogger);

    expect(result).toEqual({ site_id: 1, note: 'b' });
  });

  it('redacts a reflected credential that appears as a result key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [readOnlyAbility],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `{"${APP_PASSWORD}":{"nested":"${APP_PASSWORD}"}}`,
      headers: new Headers(),
    });

    const result = await executeAbility(baseConfig, 'mainwp/list-sites-v1', {}, mockLogger);

    expect(result).toEqual({ '[redacted]': { nested: '[redacted]' } });
  });
});

describe('secrets scoped to one in-flight call', () => {
  const SUBMITTED = 'abcd efgh ijkl mnop qrst uvwx';
  const SUBMITTED_IN_NAME = 'abcdefghijklmnop';

  const readOnlyAbility = {
    name: 'mainwp/list-sites-v1',
    label: 'List Sites',
    description: 'Get all managed sites',
    category: 'mainwp-sites',
    input_schema: { type: 'object', properties: {} },
    meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearKnownSecrets();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    clearKnownSecrets();
    vi.restoreAllMocks();
  });

  it('applies scoped secrets at the catalog boundary without registering them', async () => {
    // First-run setup validates a submitted password before it has earned
    // registration, so the fetch it triggers is the one case where the
    // boundary has to treat an unregistered value as a credential.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { ...readOnlyAbility, name: `mainwp/${SUBMITTED_IN_NAME}-v1` },
        {
          ...readOnlyAbility,
          label: `List ${SUBMITTED}`,
          description: `credential=${SUBMITTED}`,
        },
      ],
      headers: new Headers(),
    });

    const abilities = await withScopedSecrets([SUBMITTED, SUBMITTED_IN_NAME], () =>
      fetchAbilities(baseConfig, false, mockLogger)
    );

    expect(abilities.map(a => a.name)).toEqual(['mainwp/list-sites-v1']);
    expect(abilities[0].description).toBe('credential=[redacted]');
    expect(JSON.stringify(abilities)).not.toContain(SUBMITTED);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Skipping ability whose name reflects a known secret'
    );
    // The scope ended with the call; nothing joined the process-wide registry.
    expect(sanitizeError(`echo ${SUBMITTED}`)).toContain(SUBMITTED);
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

describe('required nullable JSON carrier', () => {
  const schema = {
    type: 'object',
    required: ['cursor'],
    properties: {
      cursor: { type: ['string', 'null'] },
      optional: { type: ['string', 'null'] },
      flag: { type: 'boolean' },
      count: { type: ['integer', 'null'] },
      amount: { type: 'number' },
      text: { type: ['integer', 'string'] },
      nested: { type: 'object', properties: { flag: { type: 'boolean' } } },
    },
  };
  const carrierAbility: Ability = {
    ...sampleAbilities[0],
    name: 'mainwp/list-records-v1',
    input_schema: schema,
  };
  const deleteAbility: Ability = {
    ...sampleAbilities[1],
    name: 'mainwp/reset-record-v1',
    input_schema: {
      type: 'object',
      required: ['preview_token'],
      properties: {
        preview_token: { type: ['string', 'null'] },
        dry_run: { type: 'boolean' },
        confirm: { type: 'boolean' },
      },
    },
  };
  const versionNote =
    "If this Dashboard is older than MainWP Dashboard 6.2, update it: this ability's input cannot be delivered to earlier versions.";

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearKnownSecrets();
    initRateLimiter(0);
  });

  function run(input?: Record<string, unknown>, ability = carrierAbility) {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    return executeAbility(baseConfig, ability.name, input, undefined, ability);
  }

  function request() {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    return mockFetch.mock.calls[0] as [string, RequestInit];
  }

  it.each([
    { cursor: null, optional: null, count: 5, omitted: undefined },
    { cursor: 'next', optional: 'present', count: 5 },
  ])('GET keeps the exact input in input_json: %j', async input => {
    await run(input);
    const [url, options] = request();
    expect(options.method).toBe('GET');
    expect(url).toBe(
      `${baseConfig.dashboardUrl}/wp-json/wp-abilities/v1/abilities/${carrierAbility.name}/run?input_json=${encodeURIComponent(JSON.stringify(input))}`
    );
    expect(JSON.parse(new URL(url).searchParams.get('input_json')!)).toEqual(
      JSON.parse(JSON.stringify(input))
    );
    expect([...new URL(url).searchParams.keys()]).toEqual(['input_json']);
    expect(options.body).toBeUndefined();
  });

  it.each([undefined, {}, { cursor: undefined }])(
    'GET carries an empty JSON object for %j without the input= fallback',
    async input => {
      await run(input);
      expect(new URL(request()[0]).search).toBe('?input_json=%7B%7D');
    }
  );

  it('GET detects a property whose type is exactly null', async () => {
    await run(
      { cursor: null },
      {
        ...carrierAbility,
        input_schema: { ...schema, properties: { cursor: { type: 'null' } } },
      }
    );
    expect(new URL(request()[0]).search).toBe('?input_json=%7B%22cursor%22%3Anull%7D');
  });

  it('DELETE sends the exact JSON envelope and application/json without a query', async () => {
    const input = { preview_token: null, dry_run: true, confirm: false };
    await run(input, deleteAbility);
    const [url, options] = request();
    expect(options.method).toBe('DELETE');
    expect(options.body).toBe('{"input":{"preview_token":null,"dry_run":true,"confirm":false}}');
    expect(new URL(url).search).toBe('');
    expect(new Headers(options.headers).get('content-type')).toBe('application/json');
  });

  it('GET preserves JSON booleans, nested values and string unions', async () => {
    const input = {
      cursor: null,
      flag: false,
      count: 5,
      text: '5',
      nested: { flag: 'false' },
      extra: '5',
    };
    await run(input);
    const json = new URL(request()[0]).searchParams.get('input_json');
    expect(json).toBe(JSON.stringify(input));
  });

  it.each([
    ['count', '5', 5],
    ['count', '-5', -5],
    ['count', '0', 0],
    ['amount', '5', 5],
    ['amount', '-5.25', -5.25],
    ['amount', '0.25', 0.25],
    ['flag', 'true', true],
    ['flag', 'false', false],
    ['flag', '1', true],
    ['flag', '0', false],
  ])('converts canonical %s string %s on the carrier', async (key, value, expected) => {
    await run({ cursor: null, [key as string]: value });
    expect(new URL(request()[0]).searchParams.get('input_json')).toBe(
      JSON.stringify({ cursor: null, [key as string]: expected })
    );
  });

  it.each([
    ['count', '5.0'],
    ['count', ' 5'],
    ['count', '5\n'],
    ['count', ''],
    ['count', '05'],
    ['count', '9007199254740992'],
    ['amount', '1e3'],
    ['amount', '+5'],
    ['amount', '5.25\n'],
    ['flag', 'yes'],
    ['flag', ''],
    ['flag', 'TRUE'],
  ])('rejects non-canonical %s string %j locally', async (key, value) => {
    const error = await run({ cursor: null, [key]: value }).catch(error => error);
    expect(error).toBeInstanceOf(McpError);
    if (!(error instanceof McpError)) throw new Error('Expected a local parameter rejection');
    expect(error).toMatchObject({ code: MCP_ERROR_CODES.INVALID_PARAMS });
    expect(error.message).toContain(`"${key}"`);
    if (value) expect(error.message).not.toContain(value);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', carrierAbility, { cursor: null, extra: 'é'.repeat(4096) }],
    ['DELETE', deleteAbility, { preview_token: null, extra: 'é'.repeat(524288) }],
  ])('rejects oversized %s JSON in UTF-8 locally', async (_method, ability, input) => {
    await expect(run(input, ability)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.INVALID_PARAMS,
      message: expect.stringContaining('"input"'),
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'appends the version note to carrier input errors (writeOnly=%s)',
    async writeOnly => {
      const ability = writeOnly
        ? {
            ...carrierAbility,
            input_schema: {
              ...schema,
              properties: { cursor: { type: ['string', 'null'], writeOnly: true } },
            },
          }
        : carrierAbility;
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'ability_invalid_input',
            message: 'cursor is a required property of input.',
          }),
          { status: 400 }
        )
      );
      const error = await executeAbility(
        baseConfig,
        ability.name,
        { cursor: 'next' },
        undefined,
        ability
      ).catch(error => error);
      expect(error).toMatchObject({ status: 400, code: 'ability_invalid_input' });
      if (!(error instanceof Error)) throw new Error('Expected an upstream input rejection');
      expect(error.message.endsWith(versionNote)).toBe(true);
    }
  );

  it.each([
    ['different status', 403, 'ability_invalid_input'],
    ['different code', 400, 'mainwp_abilities_invalid_input_transport'],
  ])('unchanged error behaviour: %s has no version note', async (_label, status, code) => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code, message: 'Rejected.' }), { status })
    );
    await expect(
      executeAbility(baseConfig, carrierAbility.name, { cursor: null }, undefined, carrierAbility)
    ).rejects.toMatchObject({ message: expect.not.stringContaining(versionNote) });
  });

  const malformedSchemas: Array<[string, unknown]> = [
    ['required not an array', { ...schema, required: 'cursor' }],
    ['non-string required entry', { ...schema, required: ['cursor', 7] }],
    ['missing required property', { ...schema, required: ['cursor', 'missing'] }],
    ['properties not an object', { ...schema, properties: [] }],
    ['properties null', { ...schema, properties: null }],
    [
      'properties not plain',
      {
        ...schema,
        properties: Object.assign(Object.create({ inherited: true }), schema.properties),
      },
    ],
    ['property not an object', { ...schema, properties: { ...schema.properties, extra: true } }],
    ['property is an array', { ...schema, properties: { cursor: [{ type: 'null' }] } }],
    ['property null', { ...schema, properties: { cursor: null } }],
    ['malformed type array', { ...schema, properties: { cursor: { type: ['null', 7] } } }],
    ...['__proto__', 'constructor', 'prototype'].map((key): [string, unknown] => [
      `reserved property ${key}`,
      { ...schema, properties: { ...schema.properties, [key]: { type: 'null' } } },
    ]),
    ['reserved required key', { ...schema, required: ['cursor', '__proto__'] }],
  ];

  it.each([
    [
      'no required nullable',
      {
        ...carrierAbility,
        input_schema: {
          ...schema,
          required: ['count'],
          properties: { ...schema.properties, count: { type: 'integer' } },
        },
      },
    ],
    ['optional nullable', { ...carrierAbility, input_schema: { ...schema, required: [] } }],
    ['other namespace', { ...carrierAbility, name: 'example/list-records-v1' }],
    ['root default', { ...carrierAbility, input_schema: { ...schema, default: {} } }],
    ['root union', { ...carrierAbility, input_schema: { ...schema, type: ['object', 'null'] } }],
    ...malformedSchemas.map(([label, input_schema]) => [
      label,
      { ...carrierAbility, input_schema },
    ]),
  ] as Array<[string, Ability]>)(
    'unchanged bracket form byte for byte: %s',
    async (_label, ability) => {
      await run({ cursor: null, text: 'a b', extra: ['x', 'y'], absent: undefined }, ability);
      const [url, options] = request();
      expect(new URL(url).search).toBe('?input[text]=a%20b&input[extra][]=x&input[extra][]=y');
      expect(options.body).toBeUndefined();
    }
  );

  it('unchanged POST envelope for a required nullable ability', async () => {
    await run(
      { preview_token: null },
      {
        ...deleteAbility,
        meta: { annotations: { readonly: false, destructive: true, idempotent: false } },
      }
    );
    const [url, options] = request();
    expect(options.method).toBe('POST');
    expect(options.body).toBe('{"input":{"preview_token":null}}');
    expect(new URL(url).search).toBe('');
  });

  it.each(['mainwp/list_records', 'mainwp/List-records', 'mainwp/list.records'])(
    'unchanged name validation rejects %s before transport',
    async name => {
      await expect(run({ cursor: null }, { ...carrierAbility, name })).rejects.toMatchObject({
        code: MCP_ERROR_CODES.INVALID_PARAMS,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it('unchanged bracket 400 has no version note', async () => {
    const ability = { ...carrierAbility, input_schema: { ...schema, required: [] } };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'ability_invalid_input', message: 'Rejected.' }), {
        status: 400,
      })
    );
    await expect(
      executeAbility(baseConfig, ability.name, { cursor: null }, undefined, ability)
    ).rejects.toMatchObject({
      status: 400,
      code: 'ability_invalid_input',
      message: 'Ability execution failed: ability_invalid_input - Rejected.',
    });
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

  async function callWithMockResponse(
    abilityName: string,
    input?: Record<string, unknown>,
    extraAbility?: Ability
  ) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => (extraAbility ? [...sampleAbilities, extraAbility] : sampleAbilities),
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
      headers: new Headers(),
    });
    await executeAbility(baseConfig, abilityName, input);
    return mockFetch.mock.calls[1] as [string, { method: string; body?: string }];
  }

  it.each([{}, undefined, { page: undefined }])(
    'sends empty input= for a declared GET schema with %s',
    async input => {
      const [url, request] = await callWithMockResponse('mainwp/list-sites-v1', input);
      expect(request.method).toBe('GET');
      expect(url).toMatch(/\/run\?input=$/);
    }
  );

  it('sends empty input= for a declared DELETE schema', async () => {
    const [url, request] = await callWithMockResponse('mainwp/delete-site-v1', {});
    expect(request.method).toBe('DELETE');
    expect(url).toMatch(/\/run\?input=$/);
  });

  it('omits empty GET input so a top-level schema default applies', async () => {
    const defaultAbility: Ability = {
      ...sampleAbilities[0],
      name: 'mainwp/default-read-v1',
      input_schema: { type: ['object', 'null'], default: [] },
    };
    const [url, request] = await callWithMockResponse(
      defaultAbility.name,
      undefined,
      defaultAbility
    );
    expect(request.method).toBe('GET');
    expect(url).toMatch(/\/run$/);
  });

  it('omits empty DELETE input so a top-level schema default applies', async () => {
    const defaultAbility: Ability = {
      ...sampleAbilities[1],
      name: 'mainwp/default-delete-v1',
      input_schema: { type: ['object', 'null'], default: [] },
    };
    const [url, request] = await callWithMockResponse(
      defaultAbility.name,
      undefined,
      defaultAbility
    );
    expect(request.method).toBe('DELETE');
    expect(url).toMatch(/\/run$/);
  });

  it('omits unserializable GET input so a top-level schema default applies', async () => {
    const defaultAbility: Ability = {
      ...sampleAbilities[0],
      name: 'mainwp/default-read-v1',
      input_schema: { type: ['object', 'null'], default: [] },
    };
    const [url, request] = await callWithMockResponse(
      defaultAbility.name,
      { page: undefined },
      defaultAbility
    );
    expect(request.method).toBe('GET');
    expect(url).toMatch(/\/run$/);
  });

  it('omits empty GET input for an empty schema', async () => {
    const emptySchemaAbility: Ability = {
      ...sampleAbilities[0],
      name: 'mainwp/empty-schema-read-v1',
      input_schema: {},
    };
    const [url, request] = await callWithMockResponse(
      emptySchemaAbility.name,
      undefined,
      emptySchemaAbility
    );
    expect(request.method).toBe('GET');
    expect(url).toMatch(/\/run$/);
  });

  it('omits the query string for an empty GET without an input schema', async () => {
    const noSchemaAbility = {
      ...sampleAbilities[0],
      name: 'mainwp/no-schema-read-v1',
      input_schema: undefined,
    };
    const [url, request] = await callWithMockResponse(noSchemaAbility.name, {}, noSchemaAbility);
    expect(request.method).toBe('GET');
    expect(url).toMatch(/\/run$/);
  });

  it('still sends non-empty GET input without an input schema', async () => {
    const noSchemaAbility = {
      ...sampleAbilities[0],
      name: 'mainwp/no-schema-read-v1',
      input_schema: undefined,
    };
    const [url] = await callWithMockResponse(noSchemaAbility.name, { page: 2 }, noSchemaAbility);
    expect(url).toMatch(/\/run\?input\[page\]=2$/);
  });

  it('sends an empty input object for a declared POST schema', async () => {
    const [, request] = await callWithMockResponse('mainwp/update-site-v1', {});
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body ?? '')).toEqual({ input: {} });
  });

  it('omits empty POST input for an empty schema', async () => {
    const emptySchemaAbility: Ability = {
      ...sampleAbilities[6],
      name: 'mainwp/empty-schema-post-v1',
      input_schema: {},
    };
    const [, request] = await callWithMockResponse(
      emptySchemaAbility.name,
      undefined,
      emptySchemaAbility
    );
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body ?? '')).toEqual({});
  });

  it('omits input from a POST without an input schema', async () => {
    const noSchemaAbility = {
      ...sampleAbilities[6],
      name: 'mainwp/no-schema-post-v1',
      input_schema: undefined,
    };
    const [, request] = await callWithMockResponse(noSchemaAbility.name, {}, noSchemaAbility);
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body ?? '')).toEqual({});
  });

  it('still sends non-empty POST input without an input schema', async () => {
    const noSchemaAbility = {
      ...sampleAbilities[6],
      name: 'mainwp/no-schema-post-v1',
      input_schema: undefined,
    };
    const [, request] = await callWithMockResponse(
      noSchemaAbility.name,
      { site_id: 1 },
      noSchemaAbility
    );
    expect(JSON.parse(request.body ?? '')).toEqual({ input: { site_id: 1 } });
  });

  it('keeps non-empty GET query encoding', async () => {
    const [url] = await callWithMockResponse('mainwp/list-sites-v1', { page: 2 });
    expect(url).toContain('input[page]=2');
  });

  // HTTP Method Selection Tests
  // Rules: GET (readonly), DELETE (destructive + idempotent), POST (everything else)

  it('preserves writeOnly discovery metadata and redacts nested private input from results', async () => {
    const privateAbility: Ability = {
      name: 'mainwp/private-profile-v1',
      label: 'Private Profile',
      description: 'Processes a private profile',
      category: 'mainwp-private',
      input_schema: {
        type: 'object',
        properties: {
          profile: {
            type: 'object',
            writeOnly: true,
            properties: {
              token: { type: 'string' },
              contacts: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      meta: {
        annotations: { readonly: false, destructive: false, idempotent: true },
      },
    };
    const input = {
      profile: {
        token: 'private-token-123',
        contacts: ['private@example.test', 'backup@example.test'],
        updated_at: 0,
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [privateAbility],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ echoed: input.profile, status: 'validated', changed: false, count: 0 }),
      headers: new Headers(),
    });

    const discovered = await fetchAbilities(baseConfig, false, mockLogger);
    const result = await executeAbility(
      baseConfig,
      privateAbility.name,
      input,
      mockLogger,
      discovered[0]
    );
    const serialized = JSON.stringify(result);

    expect(
      (discovered[0].input_schema?.properties as Record<string, Record<string, unknown>>).profile
        .writeOnly
    ).toBe(true);
    expect(serialized).not.toContain('private-token-123');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('backup@example.test');
    expect(serialized).toContain('[redacted]');
    expect(result).toEqual({
      echoed: '[redacted]',
      status: 'validated',
      changed: false,
      // The private updated_at of 0 is too short to redact; an unrelated count
      // of 0 must survive.
      count: 0,
    });
    expect(
      JSON.stringify(
        Object.values(mockLogger).flatMap(
          method => (method as { mock: { calls: unknown[] } }).mock.calls
        )
      )
    ).not.toContain('private-token-123');
  });

  it('withholds a reflected nested writeOnly value from an upstream error', async () => {
    const privateAbility: Ability = {
      name: 'mainwp/private-error-v1',
      label: 'Private Error',
      description: 'Rejects a private value',
      category: 'mainwp-private',
      input_schema: {
        type: 'object',
        properties: {
          credentials: {
            type: 'object',
            writeOnly: true,
            properties: { api_token: { type: 'string' } },
          },
        },
      },
      meta: {
        annotations: { readonly: false, destructive: false, idempotent: true },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () =>
        JSON.stringify({
          code: 'invalid_private_value',
          message: 'Rejected private-error-token',
        }),
      headers: new Headers(),
    });

    await expect(
      executeAbility(
        baseConfig,
        privateAbility.name,
        { credentials: { api_token: 'private-error-token' } },
        mockLogger,
        privateAbility
      )
    ).rejects.toThrow(
      'Ability execution failed: invalid_private_value (HTTP 400). The upstream message is withheld because this call carried write-only input.'
    );
    expect(
      JSON.stringify(
        Object.values(mockLogger).flatMap(
          method => (method as { mock: { calls: unknown[] } }).mock.calls
        )
      )
    ).not.toContain('private-error-token');
  });

  it('withholds an upstream error for comma-coerced writeOnly items', async () => {
    const privateAbility: Ability = {
      ...sampleAbilities[0],
      input_schema: {
        type: 'object',
        properties: {
          tokens: { type: 'array', items: { type: 'string', writeOnly: true } },
        },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () =>
        JSON.stringify({ code: 'rest_invalid_param', message: 'Invalid token TOKENAAAA1' }),
      headers: new Headers(),
    });

    await expect(
      executeAbility(
        { ...baseConfig, retryEnabled: false },
        privateAbility.name,
        { tokens: 'TOKENAAAA1,TOKENBBBB2' },
        mockLogger,
        privateAbility
      )
    ).rejects.toMatchObject({
      code: 'rest_invalid_param',
      message:
        'Ability execution failed: rest_invalid_param (HTTP 400). The upstream message is withheld because this call carried write-only input.',
    });
  });

  it('redacts a writeOnly value spanning the error limit before retry logging', async () => {
    const privateValue = 'SENTINEL_BOUNDARY_12345';
    const privateAbility: Ability = {
      ...sampleAbilities[0],
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string', writeOnly: true } },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
      text: async () => 'x'.repeat(495) + privateValue,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '{"ok":true}',
      headers: new Headers(),
    });

    const result = await executeAbility(
      { ...baseConfig, retryEnabled: true, maxRetries: 2, retryBaseDelay: 0 },
      privateAbility.name,
      { code: privateValue },
      mockLogger,
      privateAbility
    );
    const logs = JSON.stringify(
      Object.values(mockLogger).flatMap(
        method => (method as { mock: { calls: unknown[] } }).mock.calls
      )
    );

    expect(result).toEqual({ ok: true });
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Retrying request after transient error',
      expect.any(Object)
    );
    expect(logs).not.toContain(privateValue);
    expect(logs).not.toContain(privateValue.slice(0, 8));
  });

  it('does not expose a writeOnly value in a malformed successful response', async () => {
    const privateValue = 'private-response-value';
    const privateAbility: Ability = {
      ...sampleAbilities[0],
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string', writeOnly: true } },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `not-json ${privateValue}`,
      headers: new Headers(),
    });

    await expect(
      executeAbility(
        { ...baseConfig, retryEnabled: false },
        privateAbility.name,
        { code: privateValue },
        mockLogger,
        privateAbility
      )
    ).rejects.toThrow('Invalid JSON in ability response');
  });

  it('reports the HTTP status for a numeric upstream error code while withholding the message', async () => {
    const privateAbility: Ability = {
      ...sampleAbilities[0],
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string', writeOnly: true } },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ code: 42, message: 'bad private-code-value' }),
      headers: new Headers(),
    });

    await expect(
      executeAbility(
        { ...baseConfig, retryEnabled: false },
        privateAbility.name,
        { code: 'private-code-value' },
        mockLogger,
        privateAbility
      )
    ).rejects.toThrow(
      'Ability execution failed: 400 (HTTP 400). The upstream message is withheld because this call carried write-only input.'
    );
  });

  it('still explains a credential rejection when the upstream message is withheld', async () => {
    const privateAbility: Ability = {
      ...sampleAbilities[0],
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string', writeOnly: true } },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () =>
        JSON.stringify({ code: 'invalid_username', message: 'Unknown login private-code-value' }),
      headers: new Headers(),
    });

    const execution = executeAbility(
      { ...baseConfig, retryEnabled: false },
      privateAbility.name,
      { code: 'private-code-value' },
      mockLogger,
      privateAbility
    );
    await expect(execution).rejects.toThrow(
      'Ability execution failed: invalid_username (HTTP 401). The upstream message is withheld because this call carried write-only input. The Dashboard has no user'
    );
    await expect(execution).rejects.not.toThrow('private-code-value');
  });

  it('drops the username from the credential note when it matches a write-only value in any case', async () => {
    const privateAbility: Ability = {
      ...sampleAbilities[0],
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string', writeOnly: true } },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ code: 'invalid_username', message: 'Site-Admin' }),
      headers: new Headers(),
    });

    const error = await executeAbility(
      { ...baseConfig, username: 'site-admin', retryEnabled: false },
      privateAbility.name,
      { code: 'Site-Admin' },
      mockLogger,
      privateAbility
    ).catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Ability execution failed: invalid_username (HTTP 401). The upstream message is withheld because this call carried write-only input. The Dashboard rejected the credentials.'
    );
  });

  it.each([
    {
      shape: 'a username the note escapes',
      username: 'pa"ss_word1',
      status: 401,
      expected:
        'Ability execution failed: invalid_username (HTTP 401). The upstream message is withheld because this call carried write-only input. The Dashboard rejected the credentials.',
    },
    {
      shape: 'a username the note truncates',
      username: `${'u'.repeat(95)}SecretTail42`,
      status: 401,
      expected:
        'Ability execution failed: invalid_username (HTTP 401). The upstream message is withheld because this call carried write-only input. The Dashboard rejected the credentials.',
    },
    {
      shape: 'a rejection code that is itself the write-only value',
      username: 'site-admin',
      secret: 'invalid_username',
      status: 403,
      expected:
        'Ability execution failed: 403 (HTTP 403). The upstream message is withheld because this call carried write-only input. The Dashboard rejected the credentials.',
    },
  ])(
    'keeps the credential note generic for $shape',
    async ({ username, secret, status, expected }) => {
      const privateAbility: Ability = {
        ...sampleAbilities[0],
        input_schema: {
          type: 'object',
          properties: { code: { type: 'string', writeOnly: true } },
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        statusText: 'Rejected',
        text: async () => JSON.stringify({ code: 'invalid_username', message: 'Rejected' }),
        headers: new Headers(),
      });

      const error = await executeAbility(
        { ...baseConfig, username, retryEnabled: false },
        privateAbility.name,
        { code: secret ?? username },
        mockLogger,
        privateAbility
      ).catch((caught: Error) => caught);

      expect((error as Error).message).toBe(expected);
    }
  );

  it.each([
    {
      shape: 'raw value',
      input: { code: 'private-raw-value' },
      body: { code: 'invalid_private', message: 'Rejected private-raw-value' },
      expectedCode: 'invalid_private',
      forbidden: 'private-raw-value',
    },
    {
      shape: 'JSON-escaped value',
      input: { code: 'a/b "c" d' },
      body: { code: 'invalid_private', message: 'Rejected a\\/b \\"c\\" d' },
      expectedCode: 'invalid_private',
      forbidden: 'a\\/b',
    },
    {
      shape: 'percent-encoded value',
      input: { code: 'a b&c' },
      body: { code: 'invalid_private', message: 'Rejected a%20b%26c' },
      expectedCode: 'invalid_private',
      forbidden: 'a%20b%26c',
    },
    {
      shape: 'whole short-leaf object',
      input: { code: { pin: 'xy', id: 12 } },
      body: { code: 'invalid_private', message: 'Rejected {"pin":"xy","id":12}' },
      expectedCode: 'invalid_private',
      forbidden: '"pin":"xy"',
    },
    {
      shape: 'value in the code field',
      input: { code: 'private-code-value' },
      body: { code: 'private-code-value', message: 'Rejected private-code-value' },
      expectedCode: '400',
      forbidden: 'private-code-value',
    },
    {
      shape: 'writeOnly number embedded in an error code',
      input: { code: 1234 },
      body: { code: 'invalid1234', message: 'Rejected 1234' },
      expectedCode: '400',
      forbidden: '1234',
    },
    {
      shape: 'case-folded writeOnly string embedded in an error code',
      input: { code: 'ErrSecret1' },
      body: { code: 'errsecret1', message: 'Rejected ErrSecret1' },
      expectedCode: '400',
      forbidden: 'ErrSecret1',
    },
    {
      shape: 'unrelated error code with writeOnly input',
      input: { code: 1234 },
      body: { code: 'rest_invalid_param', message: 'Rejected 1234' },
      expectedCode: 'rest_invalid_param',
      forbidden: '1234',
    },
    {
      shape: 'unsafe code characters',
      input: { code: 'private-code-value' },
      body: { code: 'invalid private/code', message: 'Rejected private-code-value' },
      expectedCode: '400',
      forbidden: 'private-code-value',
    },
    {
      shape: 'code longer than 64 characters',
      input: { code: 'private-code-value' },
      body: { code: 'x'.repeat(65), message: 'Rejected private-code-value' },
      expectedCode: '400',
      forbidden: 'private-code-value',
    },
  ])(
    'withholds upstream error text reflecting a $shape',
    async ({ input, body, expectedCode, forbidden }) => {
      const privateAbility: Ability = {
        ...sampleAbilities[0],
        input_schema: {
          type: 'object',
          properties: { code: { writeOnly: true } },
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: `Rejected ${forbidden}`,
        text: async () => JSON.stringify(body),
        headers: new Headers(),
      });
      const expectedMessage = `Ability execution failed: ${expectedCode} (HTTP 400). The upstream message is withheld because this call carried write-only input.`;
      await expect(
        executeAbility(
          { ...baseConfig, retryEnabled: false },
          privateAbility.name,
          input,
          mockLogger,
          privateAbility
        )
      ).rejects.toMatchObject({ message: expectedMessage, code: expectedCode, status: 400 });
      const logs = JSON.stringify(
        Object.values(mockLogger).flatMap(
          method => (method as { mock: { calls: unknown[] } }).mock.calls
        )
      );
      expect(logs).not.toContain(forbidden);
    }
  );

  it('relays a sanitized upstream message when no writeOnly value was supplied', async () => {
    const ability: Ability = {
      ...sampleAbilities[0],
      input_schema: { type: 'object', properties: { code: { writeOnly: true } } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () =>
        JSON.stringify({ code: 'invalid_private', message: 'Rejected private-raw-value' }),
      headers: new Headers(),
    });

    await expect(
      executeAbility({ ...baseConfig, retryEnabled: false }, ability.name, {}, mockLogger, ability)
    ).rejects.toThrow('Ability execution failed: invalid_private - Rejected private-raw-value');
  });

  it('keeps GET input out of a transport error that reflects the request URL', async () => {
    mockFetch.mockImplementationOnce((url: string) =>
      Promise.reject(new Error(`Failed to fetch ${url}`))
    );

    const error = (await executeAbility(
      { ...baseConfig, retryEnabled: false },
      sampleAbilities[0].name,
      { page: 1234 },
      mockLogger,
      sampleAbilities[0]
    ).catch(caught => caught)) as Error;

    expect(error.message).toMatch(/^Failed to fetch https?:\/\/[^?]+$/);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('input[page]=1234'),
      expect.anything()
    );
  });

  it('keeps GET input out of a response read error that reflects the request URL', async () => {
    mockFetch.mockImplementationOnce((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.error(new Error(`Failed to read ${url}`));
          },
        }),
      })
    );

    const error = (await executeAbility(
      { ...baseConfig, retryEnabled: false },
      sampleAbilities[0].name,
      { page: 1234 },
      mockLogger,
      sampleAbilities[0]
    ).catch(caught => caught)) as Error;

    expect(error.message).toMatch(/^Failed to read https?:\/\/[^?]+$/);
  });

  it('keeps the query string, and any GET input in it, out of a timeout error', async () => {
    mockFetch.mockImplementationOnce((_url, options: RequestInit) => {
      const signal = options.signal as AbortSignal;
      const stream = new ReadableStream({
        start(controller) {
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

    const response = await customFetch('https://test.local/run?input[code]=private%20value');
    const error = await readLimitedBody(response, 1000).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'ETIMEDOUT' });
    expect((error as Error).message).toBe('Request timeout after 20ms: https://test.local/run');
  });

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
    expect(url).toContain('input[dry_run]=1');
    // Should not have a body
    expect(calls[1][1].body).toBeUndefined();
  });

  it.each([
    ...[
      { label: 'boolean', positionSchema: { type: 'boolean' }, numeric: true },
      { label: 'boolean/null', positionSchema: { type: ['boolean', 'null'] }, numeric: true },
      { label: 'boolean/string', positionSchema: { type: ['boolean', 'string'] }, numeric: true },
      { label: 'object/boolean', positionSchema: { type: ['object', 'boolean'] }, numeric: true },
      { label: 'undeclared property', positionSchema: undefined, numeric: false },
      { label: 'missing schema', positionSchema: undefined, numeric: false },
      { label: 'missing type', positionSchema: {}, numeric: false },
      { label: 'malformed type', positionSchema: { type: 42 }, numeric: false },
      { label: 'empty type list', positionSchema: { type: [] }, numeric: false },
      { label: 'malformed type list', positionSchema: { type: [null] }, numeric: false },
      { label: 'integer', positionSchema: { type: 'integer' }, numeric: false },
      { label: 'string', positionSchema: { type: 'string' }, numeric: false },
      { label: 'Boolean', positionSchema: { type: 'Boolean' }, numeric: false },
      { label: 'integer/string', positionSchema: { type: ['integer', 'string'] }, numeric: false },
      {
        label: 'integer/boolean',
        positionSchema: { type: ['integer', 'boolean'] },
        numeric: false,
      },
      { label: 'string/boolean', positionSchema: { type: ['string', 'boolean'] }, numeric: false },
      { label: 'number/boolean', positionSchema: { type: ['number', 'boolean'] }, numeric: false },
      { label: 'array/boolean', positionSchema: { type: ['array', 'boolean'] }, numeric: false },
      {
        label: 'boolean/non-string entry',
        positionSchema: { type: ['boolean', 42] },
        numeric: false,
      },
      {
        label: 'integer/non-string entry',
        positionSchema: { type: ['integer', 42] },
        numeric: false,
      },
      {
        label: 'integer/null entry/boolean',
        positionSchema: { type: ['integer', null, 'boolean'] },
        numeric: false,
      },
      {
        label: 'anyOf integer/boolean',
        positionSchema: { anyOf: [{ type: 'integer' }, { type: 'boolean' }] },
        numeric: false,
      },
      {
        label: 'oneOf boolean/integer',
        positionSchema: { oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
        numeric: false,
      },
      {
        label: 'allOf boolean',
        positionSchema: { type: 'boolean', allOf: [{ type: 'boolean' }] },
        numeric: false,
      },
    ].flatMap(row =>
      ['scalar', 'array item', 'nested value'].flatMap(position =>
        [true, false].map(value => {
          const property =
            position === 'array item'
              ? { type: 'array', items: row.positionSchema }
              : position === 'nested value'
                ? { type: 'object', properties: { flag: row.positionSchema } }
                : row.positionSchema;
          const key =
            position === 'array item'
              ? 'flag][]'
              : position === 'nested value'
                ? 'flag][flag]'
                : 'flag]';
          const spelling = row.numeric ? (value ? '1' : '0') : String(value);
          return {
            label: `${row.label} at ${position} (${value})`,
            input_schema:
              row.label === 'missing schema'
                ? undefined
                : {
                    type: 'object',
                    properties: row.label === 'undeclared property' ? {} : { flag: property },
                  },
            input: {
              flag:
                position === 'array item'
                  ? [value]
                  : position === 'nested value'
                    ? { flag: value }
                    : value,
            },
            query: `?input[${key}=${spelling}`,
          };
        })
      )
    ),
    {
      label: 'additionalProperties integer',
      input_schema: { type: 'object', additionalProperties: { type: 'integer' } },
      input: { flag: true },
      query: '?input[flag]=true',
    },
    {
      label: 'additionalProperties boolean',
      input_schema: { type: 'object', additionalProperties: { type: 'boolean' } },
      input: { flag: false },
      query: '?input[flag]=false',
    },
    {
      label: 'declared property over additionalProperties',
      input_schema: {
        type: 'object',
        properties: { flag: { type: 'boolean' } },
        additionalProperties: { type: 'integer' },
      },
      input: { flag: true },
      query: '?input[flag]=1',
    },
    {
      label: 'patternProperties',
      input_schema: { type: 'object', patternProperties: { '^f': { type: 'boolean' } } },
      input: { flag: true },
      query: '?input[flag]=true',
    },
    {
      label: 'anyOf on the input object',
      input_schema: {
        type: 'object',
        properties: { flag: { type: 'boolean' } },
        anyOf: [{ properties: { flag: { type: 'integer' } } }],
      },
      input: { flag: false },
      query: '?input[flag]=false',
    },
    {
      label: 'array items from additionalProperties',
      input_schema: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'integer' } },
      },
      input: { flag: [true] },
      query: '?input[flag][]=true',
    },
    {
      label: 'oneOf on an array',
      input_schema: {
        type: 'object',
        properties: {
          flag: { type: 'array', items: { type: 'boolean' }, oneOf: [{ maxItems: 1 }] },
        },
      },
      input: { flag: [true] },
      query: '?input[flag][]=true',
    },
    {
      label: 'nested additionalProperties boolean',
      input_schema: {
        type: 'object',
        properties: { flag: { type: 'object', additionalProperties: { type: 'boolean' } } },
      },
      input: { flag: { g: true } },
      query: '?input[flag][g]=true',
    },
    {
      label: 'nested patternProperties',
      input_schema: {
        type: 'object',
        properties: {
          flag: { type: 'object', patternProperties: { '^g': { type: 'boolean' } } },
        },
      },
      input: { flag: { g: false } },
      query: '?input[flag][g]=false',
    },
    {
      label: 'anyOf on a nested object',
      input_schema: {
        type: 'object',
        properties: {
          flag: {
            type: 'object',
            properties: { g: { type: 'boolean' } },
            anyOf: [{ required: ['g'] }],
          },
        },
      },
      input: { flag: { g: false } },
      query: '?input[flag][g]=false',
    },
    {
      label: 'null property schema',
      input_schema: { type: 'object', properties: { flag: null } },
      input: { flag: true },
      query: '?input[flag]=true',
    },
    {
      label: 'false property schema',
      input_schema: { type: 'object', properties: { flag: false } },
      input: { flag: false },
      query: '?input[flag]=false',
    },
    {
      label: 'array properties',
      input_schema: { type: 'object', properties: [{ type: 'boolean' }] },
      input: { 0: true },
      query: '?input[0]=true',
    },
    {
      label: 'untyped root object',
      input_schema: { properties: { flag: { type: 'boolean' } } },
      input: { flag: true },
      query: '?input[flag]=true',
    },
    {
      label: 'object/array root type',
      input_schema: { type: ['object', 'array'], properties: { flag: { type: 'boolean' } } },
      input: { flag: false },
      query: '?input[flag]=false',
    },
    {
      label: 'array schema for root object',
      input_schema: { type: 'array', items: { type: 'boolean' } },
      input: { 0: false },
      query: '?input[0]=false',
    },
    {
      label: 'tuple array items',
      input_schema: {
        type: 'object',
        properties: { flag: { type: 'array', items: [{ type: 'boolean' }] } },
      },
      input: { flag: [true] },
      query: '?input[flag][]=true',
    },
    {
      label: 'array/object container type',
      input_schema: {
        type: 'object',
        properties: { flag: { type: ['array', 'object'], items: { type: 'boolean' } } },
      },
      input: { flag: [false] },
      query: '?input[flag][]=false',
    },
    {
      label: 'string schema for nested object',
      input_schema: {
        type: 'object',
        properties: { flag: { type: 'string', properties: { g: { type: 'boolean' } } } },
      },
      input: { flag: { g: true } },
      query: '?input[flag][g]=true',
    },
    {
      label: 'untyped nested object',
      input_schema: {
        type: 'object',
        properties: { flag: { properties: { g: { type: 'boolean' } } } },
      },
      input: { flag: { g: false } },
      query: '?input[flag][g]=false',
    },
    {
      label: 'object/null root type',
      input_schema: { type: ['object', 'null'], properties: { flag: { type: 'boolean' } } },
      input: { flag: true },
      query: '?input[flag]=1',
    },
    {
      label: 'non-string root type entry',
      input_schema: { type: ['object', 42], properties: { flag: { type: 'boolean' } } },
      input: { flag: true },
      query: '?input[flag]=true',
    },
    {
      label: 'non-string array type entry',
      input_schema: {
        type: 'object',
        properties: { flag: { type: ['array', null], items: { type: 'boolean' } } },
      },
      input: { flag: [false] },
      query: '?input[flag][]=false',
    },
    {
      label: 'non-string nested object type entry',
      input_schema: {
        type: 'object',
        properties: {
          flag: { type: ['object', 42], properties: { g: { type: 'boolean' } } },
        },
      },
      input: { flag: { g: true } },
      query: '?input[flag][g]=true',
    },
    {
      label: 'null root schema',
      input_schema: null as unknown as Record<string, unknown>,
      input: { flag: true },
      query: '?input[flag]=true',
    },
    {
      label: 'array root schema',
      input_schema: [{ type: 'boolean' }] as unknown as Record<string, unknown>,
      input: { flag: false },
      query: '?input[flag]=false',
    },
    {
      label: 'number root schema',
      input_schema: 42 as unknown as Record<string, unknown>,
      input: { flag: true },
      query: '?input[flag]=true',
    },
    {
      label: 'own prototype-named properties',
      input_schema: {
        type: 'object',
        properties: JSON.parse('{"__proto__":{"type":"boolean"},"constructor":{"type":"boolean"}}'),
      },
      input: JSON.parse('{"__proto__":true,"constructor":false}') as Record<string, unknown>,
      query: '?input[__proto__]=1&input[constructor]=0',
    },
    {
      label: 'array with uniqueItems',
      input_schema: {
        type: 'object',
        properties: {
          flag: { type: 'array', items: { type: ['boolean', 'string'] }, uniqueItems: true },
          other: { type: 'boolean' },
        },
      },
      input: { flag: [false, 'false'], other: true },
      query: '?input[flag][]=false&input[flag][]=false&input[other]=1',
    },
    {
      label: 'array without uniqueItems',
      input_schema: {
        type: 'object',
        properties: { flag: { type: 'array', items: { type: ['boolean', 'string'] } } },
      },
      input: { flag: [false, 'false'] },
      query: '?input[flag][]=0&input[flag][]=false',
    },
    {
      label: 'undeclared prototype-named properties',
      input_schema: { type: 'object', properties: {} },
      input: JSON.parse('{"__proto__":true,"constructor":false}') as Record<string, unknown>,
      query: '?input[__proto__]=true&input[constructor]=false',
    },
  ])('serializes query booleans for $label', async ({ input_schema, input, query }) => {
    const ability: Ability = { ...sampleAbilities[0], input_schema };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [], headers: new Headers() });

    await executeAbility(baseConfig, ability.name, input, undefined, ability);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url.slice(url.indexOf('?'))).toBe(query);
    expect(options.method).toBe('GET');
    expect(options.body).toBeUndefined();
  });

  it.each(
    ['boolean', 'string'].flatMap(type =>
      ['scalar', 'array item', 'nested value'].flatMap(position =>
        ['true', 'false'].map(value => ({ type, position, value }))
      )
    )
  )('preserves query string "$value" for $type at $position', async ({ type, position, value }) => {
    const property =
      position === 'array item'
        ? { type: 'array', items: { type } }
        : position === 'nested value'
          ? { type: 'object', properties: { flag: { type } } }
          : { type };
    const ability: Ability = {
      ...sampleAbilities[0],
      input_schema: { type: 'object', properties: { flag: property } },
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [], headers: new Headers() });

    await executeAbility(
      baseConfig,
      ability.name,
      {
        flag:
          position === 'array item'
            ? [value]
            : position === 'nested value'
              ? { flag: value }
              : value,
      },
      undefined,
      ability
    );

    const url = mockFetch.mock.calls[0][0] as string;
    const key =
      position === 'array item' ? 'flag][]' : position === 'nested value' ? 'flag][flag]' : 'flag]';
    expect(url.slice(url.indexOf('?'))).toBe(`?input[${key}=${value}`);
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

  it('does not interpolate a malformed Dashboard error code', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'bad\nINJECTED', message: 'Login refused' }), {
        status: 401,
      })
    );
    const execution = executeAbility(
      baseConfig,
      'mainwp/list-sites-v1',
      {},
      mockLogger,
      sampleAbilities[0]
    );
    await expect(execution).rejects.toThrow('Ability execution failed: 401');
    await expect(execution).rejects.not.toThrow('INJECTED');
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

  it('reports a pinned confirm_* as the confirmation channel with no dry_run path', () => {
    const help = generateToolHelp(
      {
        ...sampleAbilities[1],
        input_schema: {
          type: 'object',
          required: ['site_id', 'confirm_purge'],
          properties: {
            site_id: { type: 'integer' },
            confirm_purge: { type: 'boolean', enum: [true] },
            dry_run: { type: 'boolean' },
          },
        },
      },
      'mainwp'
    );

    expect(help.safetyFeatures.requiresConfirm).toBe(true);
    expect(help.safetyFeatures.supportsDryRun).toBe(false);
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

describe('help generation with hostile remote schema field types', () => {
  // The remote catalog is hostile per project doctrine: input_schema.required
  // and per-property `type` can arrive as ANY JSON type (abilities.ts bounds
  // their string lengths but not their types). Before the fix, help.ts
  // bare-cast `required` to string[] and called .includes(), throwing
  // TypeError on a truthy non-array (42, {}, true). One malformed ability then
  // aborted generateToolHelp mid-map, so mainwp://help failed for the ENTIRE
  // catalog while ListTools kept advertising the tool.

  // required is a number and a property `type` is an object — both invalid
  // JSON Schema shapes a hostile Dashboard could ship.
  const hostileSchemaAbility: Ability = {
    name: 'mainwp/hostile-schema-v1',
    label: 'Hostile Schema',
    description: 'Ability with malformed schema field types',
    category: 'mainwp-sites',
    input_schema: {
      type: 'object',
      properties: {
        weird: { type: {}, description: 'Weird param' },
        ok: { type: 'string', description: 'Normal param' },
      },
      required: 42,
    },
    meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
  };

  it('generateToolHelp tolerates null, primitive, and array property entries', () => {
    const ability = {
      ...hostileSchemaAbility,
      name: 'mainwp/hostile-props-v1',
      input_schema: {
        type: 'object',
        properties: {
          nul: null,
          num: 7,
          arr: [1, 2],
          ok: { type: 'string', description: 'fine' },
        },
        required: ['ok'],
      },
    } as unknown as Ability;

    expect(() => generateToolHelp(ability, 'mainwp')).not.toThrow();
    const help = generateToolHelp(ability, 'mainwp');
    expect(help.parameters).toContainEqual(
      expect.objectContaining({ name: 'ok', type: 'string', required: true })
    );
    expect(help.parameters.find(p => p.name === 'nul')?.type).toBe('unknown');
  });

  it('generateToolHelp does not advertise dry_run/confirm for false or malformed schemas', () => {
    // declaresUsableBooleanParam must see the RAW properties: normalizing
    // false/malformed entries to {} would turn "accepts nothing" into
    // "accepts anything" and falsely advertise safety capabilities that
    // execution (which reads raw properties) will refuse.
    const ability = {
      ...hostileSchemaAbility,
      name: 'mainwp/hostile-safety-v1',
      input_schema: {
        type: 'object',
        properties: { dry_run: false, confirm: [1, 2] },
      },
    } as unknown as Ability;

    const help = generateToolHelp(ability, 'mainwp');
    expect(help.safetyFeatures.supportsDryRun).toBe(false);
    expect(help.safetyFeatures.requiresConfirm).toBe(false);
  });

  it('generateToolHelp tolerates a non-record properties value and non-string descriptions', () => {
    const arrayProps = {
      ...hostileSchemaAbility,
      name: 'mainwp/hostile-array-props-v1',
      input_schema: { type: 'object', properties: [1, 2, 3] },
    } as unknown as Ability;
    expect(() => generateToolHelp(arrayProps, 'mainwp')).not.toThrow();
    expect(generateToolHelp(arrayProps, 'mainwp').parameters).toEqual([]);

    const badDesc = {
      ...hostileSchemaAbility,
      name: 'mainwp/hostile-desc-v1',
      input_schema: {
        type: 'object',
        properties: { p: { type: 'string', description: { evil: true } } },
      },
    } as unknown as Ability;
    expect(generateToolHelp(badDesc, 'mainwp').parameters[0]?.description).toBeUndefined();
  });

  it('generateToolHelp does not throw when required is a non-array and a type is an object', () => {
    expect(() => generateToolHelp(hostileSchemaAbility, 'mainwp')).not.toThrow();

    const help = generateToolHelp(hostileSchemaAbility, 'mainwp');
    // Non-string `type` degrades to 'unknown' rather than '[object Object]'.
    expect(help.parameters).toContainEqual(
      expect.objectContaining({ name: 'weird', type: 'unknown', required: false })
    );
    // Well-formed sibling property is unaffected.
    expect(help.parameters).toContainEqual(
      expect.objectContaining({ name: 'ok', type: 'string', required: false })
    );
  });

  it('generateHelpDocument still documents well-formed abilities alongside a hostile one', () => {
    const abilities = [sampleAbilities[0], hostileSchemaAbility, sampleAbilities[1]];

    let helpDoc: ReturnType<typeof generateHelpDocument> | undefined;
    expect(() => {
      helpDoc = generateHelpDocument(abilities, 'mainwp');
    }).not.toThrow();

    const documented = Object.values(helpDoc!.toolsByCategory)
      .flat()
      .map(h => h.toolName);
    expect(documented).toContain('list_sites_v1');
    expect(documented).toContain('delete_site_v1');
  });

  it('generateHelpDocument isolates an ability that throws for any other reason', () => {
    // Defense-in-depth: even a failure the field-level guards do not cover
    // (here, accessing input_schema throws) must degrade to skipping that one
    // ability, not aborting the whole document.
    const throwingAbility = {
      name: 'mainwp/throwing-v1',
      label: 'Throwing',
      description: 'Reading its schema throws',
      category: 'mainwp-sites',
      get input_schema(): Record<string, unknown> {
        throw new Error('boom');
      },
      meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
    } as unknown as Ability;

    const abilities = [sampleAbilities[0], throwingAbility];

    let helpDoc: ReturnType<typeof generateHelpDocument> | undefined;
    expect(() => {
      helpDoc = generateHelpDocument(abilities, 'mainwp');
    }).not.toThrow();

    const documented = Object.values(helpDoc!.toolsByCategory)
      .flat()
      .map(h => h.toolName);
    expect(documented).toContain('list_sites_v1');
    expect(documented).not.toContain('throwing_v1');
    // totalTools counts only what was actually documented.
    expect(helpDoc!.overview.totalTools).toBe(1);
  });
});

describe('normalizeRemoteText', () => {
  it('never exceeds maxLength, including limits at or below the ellipsis length', () => {
    for (const maxLength of [0, 1, 2, 3, 4, 10]) {
      const result = normalizeRemoteText('abcdefghijklmnop', maxLength, 'flatten');
      expect(result.length).toBeLessThanOrEqual(maxLength);
    }
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

    const result = await paginateApi(
      customFetch,
      'https://test.local/items',
      'items',
      1000,
      logger
    );

    expect(customFetch).toHaveBeenCalledTimes(50);
    expect(logger.warning).not.toHaveBeenCalled();
    expect(result).toEqual({ items: [], truncated: false, pagesFetched: 50, pageLimit: 50 });
  });

  it('warns when reported pages exceed the 50-page cap', async () => {
    const logger = makeMockLogger();
    const customFetch = vi.fn(
      async () => new Response('[]', { headers: { 'X-WP-TotalPages': '51' } })
    );

    const result = await paginateApi(
      customFetch,
      'https://test.local/items',
      'items',
      1000,
      logger
    );

    expect(customFetch).toHaveBeenCalledTimes(50);
    expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('Pagination capped'));
    expect(result).toEqual({ items: [], truncated: true, pagesFetched: 50, pageLimit: 50 });
    expect(customFetch).toHaveBeenLastCalledWith('https://test.local/items?per_page=100&page=50');
    expect(customFetch).not.toHaveBeenCalledWith('https://test.local/items?per_page=100&page=51');
  });

  // Headers per page (null = header absent; the last entry repeats) and the
  // item count of every page (per_page is 100). Request counts pin the
  // unchanged loop; only the completeness flag is new.
  it.each([
    {
      name: 'header absent on a short page',
      headers: [null],
      size: 99,
      calls: 1,
      truncated: false,
    },
    { name: 'header absent on a full page', headers: [null], size: 100, calls: 1, truncated: true },
    { name: 'exact total on a full page', headers: ['1'], size: 100, calls: 1, truncated: false },
    { name: 'exact total on an empty page', headers: ['1'], size: 0, calls: 1, truncated: false },
    { name: 'zero total pages', headers: ['0'], size: 0, calls: 1, truncated: false },
    { name: 'consistent 3 of 3 full pages', headers: ['3'], size: 100, calls: 3, truncated: false },
    {
      name: 'header dropped at the cap after 51 were advertised',
      headers: [...Array<string>(49).fill('51'), null],
      size: 0,
      calls: 50,
      truncated: true,
    },
    {
      name: 'total shrinks from 3 to 1 on page 2',
      headers: ['3', '1'],
      size: 0,
      calls: 2,
      truncated: true,
    },
    { name: 'numeric prefix', headers: ['1junk'], size: 0, calls: 1, truncated: true },
    { name: 'negative total', headers: ['-5'], size: 0, calls: 1, truncated: true },
    { name: 'empty header', headers: [''], size: 0, calls: 1, truncated: true },
    { name: 'non-numeric header', headers: ['abc'], size: 0, calls: 50, truncated: true },
  ])('reports completeness for $name', async ({ headers, size, calls, truncated }) => {
    let call = 0;
    const page = JSON.stringify(Array.from({ length: size }, (_, id) => ({ id })));
    const customFetch = vi.fn(async () => {
      const header = headers[Math.min(call++, headers.length - 1)];
      return new Response(page, header === null ? {} : { headers: { 'X-WP-TotalPages': header } });
    });

    const result = await paginateApi(customFetch, 'https://test.local/items', 'items', 100000);

    expect(customFetch).toHaveBeenCalledTimes(calls);
    expect(result).toMatchObject({ truncated, pagesFetched: calls, pageLimit: 50 });
    expect(result.items).toHaveLength(size * calls);
  });
});

describe('ability catalog metadata', () => {
  const truncatedCatalog = { truncated: true, pagesFetched: 50, pageLimit: 50 };
  const completeCatalog = { truncated: false, pagesFetched: 1, pageLimit: 50 };
  const emptyCatalog = { truncated: false, pagesFetched: 0, pageLimit: 50 };

  function catalogResponse(url: string, totalPages: number): Response {
    const page = new URL(url).searchParams.get('page');
    return new Response(JSON.stringify(page === '1' ? sampleAbilities : []), {
      headers: { 'X-WP-TotalPages': String(totalPages) },
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    initRateLimiter(0);
  });

  it('keeps truncation on cached and stale ability snapshots', async () => {
    mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 51));
    const first = await fetchAbilities(baseConfig);
    const cached = await fetchAbilities(baseConfig);
    expect(cached).toBe(first);
    expect(getAbilityCatalogMetadata(cached)).toEqual(truncatedCatalog);
    expect(mockFetch).toHaveBeenCalledTimes(50);

    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const stale = await fetchAbilities(baseConfig, true, mockLogger);
    expect(stale).toBe(first);
    expect(getAbilityCatalogMetadata(stale)).toEqual(truncatedCatalog);
    expect(getCachedAbilityCatalogMetadata(baseConfig)).toEqual(truncatedCatalog);
  });

  it('resets truncation after a complete refresh without changing an older snapshot', async () => {
    mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 51));
    const truncated = await fetchAbilities(baseConfig);
    mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 1));
    const complete = await fetchAbilities(baseConfig, true);

    expect(getAbilityCatalogMetadata(complete)).toEqual(completeCatalog);
    expect(getCachedAbilityCatalogMetadata(baseConfig)).toEqual(completeCatalog);
    expect(getAbilityCatalogMetadata(truncated)).toEqual(truncatedCatalog);
  });

  it('resets catalog metadata when the ability cache is cleared', async () => {
    mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 51));
    await fetchAbilities(baseConfig);
    clearCache();
    expect(getCachedAbilityCatalogMetadata(baseConfig)).toEqual(emptyCatalog);

    mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 1));
    expect(getAbilityCatalogMetadata(await fetchAbilities(baseConfig))).toEqual(completeCatalog);
  });

  it.each([
    ['URL', { dashboardUrl: 'https://other.local' }],
    ['base path', { dashboardUrl: `${baseConfig.dashboardUrl}/other` }],
    ['principal', { username: 'other-user' }],
    ['namespaces', { abilityNamespaces: ['mainwp', 'acme'] }],
  ] as const)(
    'isolates catalog metadata across different %s identities',
    async (_label, overrides) => {
      const otherConfig = { ...baseConfig, ...overrides } as Config;
      mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 51));
      const truncated = await fetchAbilities(baseConfig);
      expect(getCachedAbilityCatalogMetadata(otherConfig)).toEqual(emptyCatalog);

      mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 1));
      const complete = await fetchAbilities(otherConfig);
      expect(getAbilityCatalogMetadata(truncated)).toEqual(truncatedCatalog);
      expect(getAbilityCatalogMetadata(complete)).toEqual(completeCatalog);
      expect(getCachedAbilityCatalogMetadata(otherConfig)).toEqual(completeCatalog);
      expect(getCachedAbilityCatalogMetadata(baseConfig)).toEqual(emptyCatalog);

      mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 51));
      const refetched = await fetchAbilities(baseConfig);
      expect(getAbilityCatalogMetadata(refetched)).toEqual(truncatedCatalog);
      expect(getAbilityCatalogMetadata(complete)).toEqual(completeCatalog);
      expect(mockFetch).toHaveBeenCalledTimes(101);
    }
  );

  it('publishes metadata with the matching indexes during concurrent identity refreshes', async () => {
    let resolveFirst!: (response: Response) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          resolveFirst = resolve;
        })
    );
    const first = fetchAbilities(baseConfig);
    const otherConfig = { ...baseConfig, dashboardUrl: 'https://other.local' };
    mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 1));
    const complete = await fetchAbilities(otherConfig);

    mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 51));
    resolveFirst(catalogResponse(`${baseConfig.dashboardUrl}?page=1`, 51));
    const truncated = await first;
    expect(getAbilityCatalogMetadata(truncated)).toEqual(truncatedCatalog);
    expect(getAbilityCatalogMetadata(complete)).toEqual(completeCatalog);
    expect(getCachedAbilityCatalogMetadata(baseConfig)).toEqual(truncatedCatalog);
    expect(await getAbilityByToolName(baseConfig, 'list_sites_v1')).toBe(truncated[0]);
    expect(mockFetch).toHaveBeenCalledTimes(51);
  });

  it('preserves newer catalog metadata when an older identity refresh fails', async () => {
    let rejectFirst!: (error: Error) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFirst = reject;
        })
    );
    const failing = fetchAbilities(baseConfig);
    const otherConfig = { ...baseConfig, username: 'other-user' };
    mockFetch.mockImplementation(async (url: string) => catalogResponse(url, 51));
    const newer = await fetchAbilities(otherConfig);
    rejectFirst(new Error('Network error'));
    await expect(failing).rejects.toThrow('Network error');

    expect(await fetchAbilities(otherConfig)).toBe(newer);
    expect(getCachedAbilityCatalogMetadata(otherConfig)).toEqual(truncatedCatalog);
    expect(getCachedAbilityCatalogMetadata(baseConfig)).toEqual(emptyCatalog);
    expect(mockFetch).toHaveBeenCalledTimes(51);
  });
});
