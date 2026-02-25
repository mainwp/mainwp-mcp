/**
 * Abilities Module Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchAbilities,
  fetchCategories,
  getAbility,
  executeAbility,
  clearCache,
  onCacheRefresh,
  initRateLimiter,
  generateToolHelp,
  generateHelpDocument,
  type Ability,
} from './abilities.js';
import { McpError, MCP_ERROR_CODES } from './errors.js';
import { type Config } from './config.js';
import https from 'https';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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

const baseConfig: Config = {
  dashboardUrl: 'https://test.local',
  authType: 'basic',
  username: 'admin',
  appPassword: 'xxxx',
  skipSslVerify: true,
  allowHttp: false,
  rateLimit: 0, // Disable rate limiting for tests
  requestTimeout: 5000,
  maxResponseSize: 10485760,
  safeMode: false,
  requireUserConfirmation: true,
  maxSessionData: 52428800,
  schemaVerbosity: 'standard',
  retryEnabled: false, // Disable retries for tests
  maxRetries: 2,
  retryBaseDelay: 1000,
  retryMaxDelay: 2000,
  configSource: 'environment',
};

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

  it('should filter by namespace', async () => {
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

  it('should warn when X-WP-Total exceeds 100', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers({ 'X-WP-Total': '150' }),
    });

    await fetchAbilities(baseConfig);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/X-WP-Total/)
    );
  });

  it('should reuse the same https.Agent across multiple createFetch calls', async () => {
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    const agentSpy = vi.spyOn(https, 'Agent').mockImplementation(class {} as never);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    await fetchAbilities(baseConfig, true);
    await fetchAbilities(baseConfig, true);

    // sharedAgent persists for process lifetime (not reset by clearCache),
    // so it may already be warm from earlier tests — expect at most 1 construction.
    expect(agentSpy.mock.calls.length).toBeLessThanOrEqual(1);

    agentSpy.mockRestore();
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

  it('should warn when X-WP-Total exceeds 100', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleCategories,
      headers: new Headers({ 'X-WP-Total': '150' }),
    });

    await fetchCategories(baseConfig);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/X-WP-Total/)
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

  it('should use DELETE for destructive + idempotent abilities (delete_site_v1)', async () => {
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

    await executeAbility(baseConfig, 'mainwp/delete-site-v1', { site_id: 1, confirm: true });

    const calls = mockFetch.mock.calls;
    expect(calls[1][1].method).toBe('DELETE');
  });

  it('should use DELETE for destructive + idempotent abilities (delete_client_v1)', async () => {
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

    await executeAbility(baseConfig, 'mainwp/delete-client-v1', {
      client_id_or_email: 1,
      confirm: true,
    });

    const calls = mockFetch.mock.calls;
    expect(calls[1][1].method).toBe('DELETE');
  });

  it('should use DELETE for destructive + idempotent abilities (delete_tag_v1)', async () => {
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

    await executeAbility(baseConfig, 'mainwp/delete-tag-v1', { tag_id: 1, confirm: true });

    const calls = mockFetch.mock.calls;
    expect(calls[1][1].method).toBe('DELETE');
  });

  it('should use DELETE for destructive + idempotent abilities (delete_site_plugins_v1)', async () => {
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

    await executeAbility(baseConfig, 'mainwp/delete-site-plugins-v1', {
      site_id_or_domain: 1,
      plugins: ['test-plugin/test-plugin.php'],
      confirm: true,
    });

    const calls = mockFetch.mock.calls;
    expect(calls[1][1].method).toBe('DELETE');
  });

  it('should use DELETE for destructive + idempotent abilities (delete_site_themes_v1)', async () => {
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

    await executeAbility(baseConfig, 'mainwp/delete-site-themes-v1', {
      site_id_or_domain: 1,
      themes: ['twentytwentyfour'],
      confirm: true,
    });

    const calls = mockFetch.mock.calls;
    expect(calls[1][1].method).toBe('DELETE');
  });

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
});

describe('generateToolHelp', () => {
  it('should generate help for a simple ability', () => {
    const ability = sampleAbilities[0];
    const help = generateToolHelp(ability);

    expect(help.toolName).toBe('list_sites_v1');
    expect(help.abilityName).toBe('mainwp/list-sites-v1');
    expect(help.label).toBe('List Sites');
    expect(help.annotations.readonly).toBe(true);
    expect(help.annotations.destructive).toBe(false);
  });

  it('should detect safety features', () => {
    const ability = sampleAbilities[1];
    const help = generateToolHelp(ability);

    expect(help.safetyFeatures.supportsDryRun).toBe(true);
    expect(help.safetyFeatures.requiresConfirm).toBe(true);
    expect(help.annotations.destructive).toBe(true);
  });

  it('should include parameters', () => {
    const ability = sampleAbilities[1];
    const help = generateToolHelp(ability);

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
    const helpDoc = generateHelpDocument(sampleAbilities);

    expect(helpDoc.version).toBe('1.0');
    expect(helpDoc.overview.totalTools).toBe(7);
    expect(helpDoc.overview.categories).toContain('mainwp-sites');
  });

  it('should list destructive tools', () => {
    const helpDoc = generateHelpDocument(sampleAbilities);

    expect(helpDoc.destructiveTools).toContain('delete_site_v1');
    expect(helpDoc.destructiveTools).not.toContain('list_sites_v1');
  });

  it('should list tools with dry_run', () => {
    const helpDoc = generateHelpDocument(sampleAbilities);

    expect(helpDoc.toolsWithDryRun).toContain('delete_site_v1');
  });

  it('should list tools requiring confirm', () => {
    const helpDoc = generateHelpDocument(sampleAbilities);

    expect(helpDoc.toolsRequiringConfirm).toContain('delete_site_v1');
  });

  it('should group tools by category', () => {
    const helpDoc = generateHelpDocument(sampleAbilities);

    // mainwp-sites has: list-sites, delete-site, delete-site-plugins, delete-site-themes, update-site
    expect(helpDoc.toolsByCategory['mainwp-sites']).toHaveLength(5);
  });

  it('should include safety conventions', () => {
    const helpDoc = generateHelpDocument(sampleAbilities);

    expect(helpDoc.overview.safetyConventions).toHaveProperty('dryRun');
    expect(helpDoc.overview.safetyConventions).toHaveProperty('confirm');
    expect(helpDoc.overview.safetyConventions).toHaveProperty('destructive');
  });
});
