/**
 * MCP Tool Conversion Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTools, executeTool, clearToolsCache, isToolAllowed } from './tools.js';
import { abilityNameToToolName } from './naming.js';
import { getSessionDataUsage, resetSessionData, isNoOpError } from './session.js';
import { clearPendingPreviews } from './confirmation.js';
import { generateInstructions, buildSafetyTags } from './tool-schema.js';
import { MCP_ERROR_CODES } from './errors.js';
import {
  type Ability,
  clearCache,
  fetchAbilities,
  initRateLimiter,
  onCacheRefresh,
} from './abilities.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

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
        per_page: { type: 'integer', description: 'Items per page' },
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
    description: 'Delete a site from MainWP Dashboard',
    category: 'mainwp-sites',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'integer', description: 'Site ID to delete' },
        confirm: { type: 'boolean', description: 'Must be true to execute' },
        dry_run: { type: 'boolean', description: 'Preview mode' },
      },
      required: ['site_id'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: true,
        idempotent: false,
      },
    },
  },
  {
    name: 'mainwp/delete-plugins-v1',
    label: 'Delete Plugins',
    description: 'Delete plugins from a site',
    category: 'mainwp-plugins',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'integer', description: 'Site ID' },
        plugins: { type: 'array', description: 'Plugin slugs to delete' },
        confirm: { type: 'boolean', description: 'Must be true to execute' },
        dry_run: { type: 'boolean', description: 'Preview mode' },
      },
      required: ['site_id', 'plugins'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: true,
        idempotent: false,
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
        name: { type: 'string', description: 'New name' },
      },
      required: ['site_id'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: false,
        idempotent: true,
      },
    },
  },
  {
    name: 'mainwp/activate-site-plugins-v1',
    label: 'Activate Site Plugins',
    description: 'Activate plugins on a site',
    category: 'mainwp-plugins',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'integer', description: 'Site ID' },
        plugins: { type: 'array', description: 'Plugin slugs to activate' },
      },
      required: ['site_id', 'plugins'],
    },
    meta: {
      annotations: {
        readonly: false,
        destructive: false,
        idempotent: true,
      },
    },
  },
];

const baseConfig = makeBaseConfig();

const mockLogger = makeMockLogger();

describe('getTools', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearToolsCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should convert abilities to tools', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);

    expect(tools).toHaveLength(5);
    expect(tools[0].name).toBe('list_sites_v1');
    expect(tools[1].name).toBe('delete_site_v1');
    expect(tools[2].name).toBe('delete_plugins_v1');
  });

  it('should apply allowedTools filter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const config = { ...baseConfig, allowedTools: ['list_sites_v1'] };
    const tools = await getTools(config);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('list_sites_v1');
  });

  it('should apply blockedTools filter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const config = { ...baseConfig, blockedTools: ['delete_site_v1'] };
    const tools = await getTools(config);

    expect(tools).toHaveLength(4);
    expect(tools.find(t => t.name === 'delete_site_v1')).toBeUndefined();
  });

  it('should include user_confirmed parameter for destructive tools with confirm', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);
    const deleteTool = tools.find(t => t.name === 'delete_site_v1');

    expect(deleteTool?.inputSchema.properties).toHaveProperty('user_confirmed');
  });

  it('does not mutate cached schemas or notify on an identical forced refresh', async () => {
    const callback = vi.fn();
    onCacheRefresh(callback);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => structuredClone(sampleAbilities),
      headers: new Headers(),
    });

    await getTools(baseConfig);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => structuredClone(sampleAbilities),
      headers: new Headers(),
    });
    await fetchAbilities(baseConfig, true);

    expect(callback).not.toHaveBeenCalled();
  });

  it('should handle schema verbosity modes - compact', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const config = { ...baseConfig, schemaVerbosity: 'compact' as const };
    const tools = await getTools(config);

    // Compact mode should still have tools with basic properties
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]).toHaveProperty('name');
    expect(tools[0]).toHaveProperty('description');
  });

  it('should add DESTRUCTIVE tag to descriptions in standard mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);
    const deleteTool = tools.find(t => t.name === 'delete_site_v1');

    expect(deleteTool?.description).toContain('[DESTRUCTIVE');
  });

  it('should include MCP semantic annotations', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);
    const listTool = tools.find(t => t.name === 'list_sites_v1');

    expect(listTool?.annotations?.readOnlyHint).toBe(true);
    expect(listTool?.annotations?.destructiveHint).toBe(false);
  });

  it('should include title and openWorldHint in annotations', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);
    const listTool = tools.find(t => t.name === 'list_sites_v1');
    const deleteTool = tools.find(t => t.name === 'delete_site_v1');

    expect(listTool?.annotations?.title).toBe('List Sites');
    expect(listTool?.annotations?.openWorldHint).toBe(true);
    expect(deleteTool?.annotations?.title).toBe('Delete Site');
    expect(deleteTool?.annotations?.openWorldHint).toBe(true);
  });

  it('should include category prefix in standard mode descriptions', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);
    const listTool = tools.find(t => t.name === 'list_sites_v1');
    const deleteTool = tools.find(t => t.name === 'delete_site_v1');
    const pluginTool = tools.find(t => t.name === 'delete_plugins_v1');

    expect(listTool?.description).toMatch(/^\[sites\] /);
    expect(deleteTool?.description).toMatch(/^\[sites\] /);
    expect(pluginTool?.description).toMatch(/^\[plugins\] /);
  });

  it('should include LLM instructions for readonly tools', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);
    const listTool = tools.find(t => t.name === 'list_sites_v1');

    expect(listTool?.description).toContain('Read-only. Safe to call without confirmation.');
  });

  it('should include LLM instructions for destructive tools with confirm and dry_run', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);
    const deleteTool = tools.find(t => t.name === 'delete_site_v1');

    expect(deleteTool?.description).toContain(
      'Always preview with dry_run or confirm before executing.'
    );
    expect(deleteTool?.description).toContain('Not idempotent');
  });

  it('should include LLM instructions for write non-destructive tools', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);
    const updateTool = tools.find(t => t.name === 'update_site_v1');

    expect(updateTool?.description).toContain('Write operation.');
  });

  it('should prepend API instructions with punctuation guard', async () => {
    const abilitiesWithInstructions: Ability[] = [
      {
        name: 'mainwp/get-costs-v1',
        label: 'Get Costs',
        description: 'Get cost data',
        category: 'mainwp-clients',
        meta: {
          annotations: {
            readonly: true,
            destructive: false,
            idempotent: true,
            instructions: 'Requires Cost Tracker module',
          },
        },
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => abilitiesWithInstructions,
      headers: new Headers(),
    });

    const tools = await getTools(baseConfig);

    // Should add period and then cleanly concatenate with read-only instruction
    expect(tools[0].description).toContain(
      'Requires Cost Tracker module. Read-only. Safe to call without confirmation.'
    );
  });

  it('should include safety tags in compact mode for destructive tools', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const config = { ...baseConfig, schemaVerbosity: 'compact' as const };
    const tools = await getTools(config);
    const deleteTool = tools.find(t => t.name === 'delete_site_v1');

    expect(deleteTool?.description).toContain('[destructive, confirm, dry_run]');
    expect(deleteTool?.description).toContain('FLOW:');
  });

  it('should not include safety tags in compact mode for readonly tools', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const config = { ...baseConfig, schemaVerbosity: 'compact' as const };
    const tools = await getTools(config);
    const listTool = tools.find(t => t.name === 'list_sites_v1');

    // Readonly tools have no compact-mode tags (not destructive, no confirm, no dry_run)
    expect(listTool?.description).not.toContain('[');
    expect(listTool?.description).not.toContain('FLOW:');
  });

  it('should truncate descriptions in compact mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const config = { ...baseConfig, schemaVerbosity: 'compact' as const };
    const tools = await getTools(config);
    const listTool = tools.find(t => t.name === 'list_sites_v1');

    // Short descriptions should pass through unchanged (no category prefix in compact)
    expect(listTool?.description).toBe('Get all managed sites');
  });

  it('surfaces tools from every configured namespace at once', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        ...sampleAbilities,
        {
          name: 'acme/do-thing-v1',
          label: 'Acme Do Thing',
          description: 'Third-party ability',
          category: 'acme-misc',
          meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
        },
      ],
      headers: new Headers(),
    });

    const config = {
      ...baseConfig,
      abilityNamespaces: ['mainwp', 'acme'] as [string, ...string[]],
    };
    const tools = await getTools(config);

    const names = tools.map(t => t.name);
    expect(names).toContain('list_sites_v1');
    expect(names).toContain('acme__do_thing_v1');
  });

  it('invalidates the tools cache when abilityNamespaces changes', async () => {
    const payload = [
      ...sampleAbilities,
      {
        name: 'acme/do-thing-v1',
        label: 'Acme Do Thing',
        description: 'Third-party ability',
        category: 'acme-misc',
        meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
      },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => payload,
      headers: new Headers(),
    });

    const firstTools = await getTools(baseConfig);
    expect(firstTools.map(t => t.name)).not.toContain('acme__do_thing_v1');

    // Same diff-config-shape except for the namespace allowlist — the tools
    // cache fingerprint must include abilityNamespaces, or this call would
    // return the stale first result.
    const secondTools = await getTools({
      ...baseConfig,
      abilityNamespaces: ['mainwp', 'acme'] as [string, ...string[]],
    });
    expect(secondTools.map(t => t.name)).toContain('acme__do_thing_v1');
  });
});

describe('isToolAllowed', () => {
  it('gives the blocklist precedence over the allowlist', () => {
    const config = {
      ...baseConfig,
      allowedTools: ['list_sites_v1'],
      blockedTools: ['list_sites_v1'],
    };

    expect(isToolAllowed(config, 'list_sites_v1')).toBe(false);
  });
});

describe('executeTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearToolsCache();
    clearPendingPreviews();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should execute read-only tool successfully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: 'Site 1' }],
      headers: new Headers(),
    });

    const result = await executeTool(baseConfig, 'list_sites_v1', {}, mockLogger);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toContainEqual({ id: 1, name: 'Site 1' });
    expect(result.isError).toBeUndefined();
  });

  it('passes tool arguments through to the ability request', async () => {
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

    await executeTool(baseConfig, 'list_sites_v1', { page: 2, per_page: 25 }, mockLogger);

    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain('input[page]=2');
    expect(url).toContain('input[per_page]=25');
  });

  it('rejects a disallowed tool before lookup, preview, or execution', async () => {
    const config = { ...baseConfig, blockedTools: ['delete_site_v1'] };

    const result = await executeTool(
      config,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Tool is not allowed: delete_site_v1');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should validate input before execution', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // Invalid ID should be caught by validation
    const result = await executeTool(baseConfig, 'list_sites_v1', { site_id: -1 }, mockLogger);

    expect(result.content[0].text).toContain('error');
    expect(result.isError).toBe(true);
  });

  it('should return isError for unknown tool', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const result = await executeTool(baseConfig, 'no_such_tool_v1', {}, mockLogger);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
    expect(parsed.error.message).toContain('Tool not found: no_such_tool_v1');
  });

  it('should block destructive operations in safe mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const config = { ...baseConfig, safeMode: true };
    const result = await executeTool(
      config,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );

    expect(result.content[0].text).toContain('SAFE_MODE_BLOCKED');
    expect(result.isError).toBe(true);
  });

  it('allows read-only tools in safe mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sites: [] }),
      headers: new Headers(),
    });

    const result = await executeTool(
      { ...baseConfig, safeMode: true },
      'list_sites_v1',
      {},
      mockLogger
    );

    expect(JSON.parse(result.content[0].text)).toEqual({ sites: [] });
    expect(result.isError).toBeUndefined();
  });

  it('should strip confirm parameter in safe mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const config = { ...baseConfig, safeMode: true };
    await executeTool(config, 'delete_site_v1', { site_id: 1, confirm: true }, mockLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Stripped confirm'),
      expect.any(Object)
    );
  });

  it('should handle confirmation flow - generate preview', async () => {
    // Abilities fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // Dry run preview
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true, affected: [1] }),
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );

    expect(result.content[0].text).toContain('CONFIRMATION_REQUIRED');
    expect(result.content[0].text).toContain('preview');

    // Should include a confirmation token at top level
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.confirmation_token).toBeDefined();
    expect(typeof parsed.confirmation_token).toBe('string');
    expect(parsed.confirmation_token.length).toBeGreaterThan(0);

    // Preview is a successful workflow step, not a failed call
    expect(result.isError).toBeUndefined();
  });

  it('issues a confirmation token without calling upstream when the ability has confirm but no dry_run', async () => {
    const confirmOnlyAbility: Ability = {
      ...sampleAbilities[1],
      name: 'mainwp/delete-without-preview-v1',
      input_schema: {
        type: 'object',
        properties: {
          site_id: { type: 'integer', description: 'Site ID' },
          confirm: { type: 'boolean', description: 'Must be true to execute' },
        },
        required: ['site_id'],
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [...sampleAbilities, confirmOnlyAbility],
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'delete_without_preview_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );

    // Workflow step, not an error: token issued, no preview, no upstream call
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('CONFIRMATION_REQUIRED');
    expect(parsed.next_action).toBe('confirm_without_preview');
    expect(parsed.preview).toBeNull();
    expect(typeof parsed.confirmation_token).toBe('string');
    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1); // abilities fetch only

    // The confirmed follow-up call executes — the gate is not a dead end
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ deleted: true }),
      headers: new Headers(),
    });
    const confirmed = await executeTool(
      baseConfig,
      'delete_without_preview_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: parsed.confirmation_token },
      mockLogger
    );
    expect(confirmed.isError).toBeUndefined();
    expect(confirmed.content[0].text).toContain('deleted');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects injected dry_run on an ability that does not declare it', async () => {
    const confirmOnlyAbility: Ability = {
      ...sampleAbilities[1],
      name: 'mainwp/delete-without-preview-v1',
      input_schema: {
        type: 'object',
        properties: {
          site_id: { type: 'integer', description: 'Site ID' },
          confirm: { type: 'boolean', description: 'Must be true to execute' },
        },
        required: ['site_id'],
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [...sampleAbilities, confirmOnlyAbility],
      headers: new Headers(),
    });

    // Undeclared dry_run must not bypass confirmation: if upstream ignored
    // the unknown parameter, the destructive operation would execute for real.
    const result = await executeTool(
      baseConfig,
      'delete_without_preview_v1',
      { site_id: 1, dry_run: true },
      mockLogger
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('INVALID_PARAMETER');
    expect(parsed.message).toContain('dry_run');
    expect(result.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1); // abilities fetch only, no /run
  });

  it('rejects injected dry_run even when combined with confirm: true', async () => {
    const confirmOnlyAbility: Ability = {
      ...sampleAbilities[1],
      name: 'mainwp/delete-without-preview-v1',
      input_schema: {
        type: 'object',
        properties: {
          site_id: { type: 'integer', description: 'Site ID' },
          confirm: { type: 'boolean', description: 'Must be true to execute' },
        },
        required: ['site_id'],
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [...sampleAbilities, confirmOnlyAbility],
      headers: new Headers(),
    });

    // Worst case: confirm: true rides along with the fabricated dry_run —
    // a skip here would forward confirm: true upstream without any gate.
    const result = await executeTool(
      baseConfig,
      'delete_without_preview_v1',
      { site_id: 1, confirm: true, dry_run: true },
      mockLogger
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('INVALID_PARAMETER');
    expect(result.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1); // abilities fetch only, no /run
  });

  it('requires a preview for a bare destructive call with confirm support', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const result = await executeTool(baseConfig, 'delete_site_v1', { site_id: 1 }, mockLogger);

    expect(result.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(result.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should reject user_confirmed without prior preview', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true },
      mockLogger
    );

    expect(result.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(result.isError).toBe(true);
  });

  it('should reject conflicting dry_run and user_confirmed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, dry_run: true, user_confirmed: true },
      mockLogger
    );

    expect(result.content[0].text).toContain('CONFLICTING_PARAMETERS');
    expect(result.isError).toBe(true);
  });

  it('allows a declared explicit dry_run to bypass confirmation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ dry_run: true, preview: true }),
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, dry_run: true },
      mockLogger
    );

    expect(JSON.parse(result.content[0].text)).toEqual({ dry_run: true, preview: true });
    expect(result.isError).toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Explicit dry_run bypasses confirmation flow',
      expect.objectContaining({ toolName: 'delete_site_v1' })
    );
  });

  it('strips confirm from an explicit dry_run call before reaching upstream', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ dry_run: true, preview: true }),
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, dry_run: true, confirm: true },
      mockLogger
    );

    expect(result.isError).toBeUndefined();
    // Upstream must never see the ambiguous confirm+dry_run combination
    const [executionUrl, executionInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const serialized = `${executionUrl} ${String(executionInit?.body ?? '')}`;
    expect(serialized).toContain('dry_run');
    expect(serialized).not.toContain('confirm=');
    expect(serialized).not.toContain('"confirm"');
  });

  it('should accept confirmation_token to resolve preview', async () => {
    // Step 1: Generate preview
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true, affected: [1] }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );
    const parsed = JSON.parse(previewResult.content[0].text);
    const token = parsed.confirmation_token;

    // Step 2: Confirm with token
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, deleted_site_id: 1 }),
      headers: new Headers(),
    });

    const confirmResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: token },
      mockLogger
    );

    expect(confirmResult.content[0].text).toContain('success');
  });

  it('should reject invalid confirmation_token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: 'invalid-token-uuid' },
      mockLogger
    );

    expect(result.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(result.isError).toBe(true);
  });

  it('should not include confirmation_token in preview key', async () => {
    // Generate first preview without token
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true }),
      headers: new Headers(),
    });

    await executeTool(baseConfig, 'delete_site_v1', { site_id: 1, confirm: true }, mockLogger);

    // Generate second preview with a confirmation_token in args (shouldn't affect key)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true }),
      headers: new Headers(),
    });

    const result2 = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true, confirmation_token: 'some-token' },
      mockLogger
    );

    // Second call should still succeed (overwrites same key)
    expect(result2.content[0].text).toContain('CONFIRMATION_REQUIRED');
  });

  it('should handle user_confirmed on tool without confirm parameter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
      headers: new Headers(),
    });

    // update-site-v1 is not destructive, has no confirm param
    const result = await executeTool(
      baseConfig,
      'update_site_v1',
      { site_id: 1, user_confirmed: true },
      mockLogger
    );

    // Non-destructive tool should execute normally — no error, no rejection
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).not.toContain('error');
    expect(mockFetch).toHaveBeenCalledTimes(2); // Abilities fetch + execution
  });

  it('should handle AbortSignal cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const result = await executeTool(baseConfig, 'list_sites_v1', {}, mockLogger, {
      signal: controller.signal,
    });

    expect(result.content[0].text).toContain('cancelled');
    expect(result.isError).toBe(true);
  });

  it('should log tool execution with timing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
      headers: new Headers(),
    });

    await executeTool(baseConfig, 'list_sites_v1', {}, mockLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('succeeded'),
      expect.objectContaining({ durationMs: expect.any(Number) })
    );
  });

  it('should handle errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await executeTool(baseConfig, 'list_sites_v1', {}, mockLogger);

    expect(result.content[0].text).toContain('error');
    expect(result.isError).toBe(true);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('returns an error result for upstream HTTP execution errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ code: 'site_not_found', message: 'Site does not exist' }),
      headers: new Headers(),
    });

    const result = await executeTool(baseConfig, 'list_sites_v1', {}, mockLogger);

    expect(result.content[0].text).toContain('site_not_found');
    expect(result.isError).toBe(true);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('should return compact JSON by default', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: 'Site 1' }],
      headers: new Headers(),
    });

    const result = await executeTool(baseConfig, 'list_sites_v1', {}, mockLogger);
    const parsed = JSON.parse(result.content[0].text);

    // Compact format should equal JSON.stringify without indentation
    expect(result.content[0].text).toBe(JSON.stringify(parsed));
  });

  it('should return pretty JSON when responseFormat is pretty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: 'Site 1' }],
      headers: new Headers(),
    });

    const prettyConfig = { ...baseConfig, responseFormat: 'pretty' as const };
    const result = await executeTool(prettyConfig, 'list_sites_v1', {}, mockLogger);

    // Pretty format should contain newlines (indented)
    expect(result.content[0].text).toContain('\n');
    const parsed = JSON.parse(result.content[0].text);
    expect(result.content[0].text).toBe(JSON.stringify(parsed, null, 2));
  });

  it('executes non-primary namespace tools against their original ability URL', async () => {
    const abilities: Ability[] = [
      {
        name: 'acme/do-thing-v1',
        label: 'Acme Do Thing',
        description: 'Third-party readonly ability',
        category: 'acme-misc',
        meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
      },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => abilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 'pong' }),
      headers: new Headers(),
    });
    const config = {
      ...baseConfig,
      abilityNamespaces: ['mainwp', 'acme'] as [string, ...string[]],
    };

    const result = await executeTool(config, 'acme__do_thing_v1', { input: 'ping' }, mockLogger);

    expect(mockFetch.mock.calls[1][0]).toContain('/abilities/acme/do-thing-v1/run');
    expect(JSON.parse(result.content[0].text)).toEqual({ result: 'pong' });
    expect(result.isError).toBeUndefined();
  });

  it('round-trips a hyphenated namespace through execution', async () => {
    const abilities: Ability[] = [
      {
        name: 'acme-corp/do-thing-v1',
        label: 'Acme Corp Do Thing',
        description: 'Hyphenated-namespace ability',
        category: 'acme-corp-misc',
        meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
      },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => abilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
      headers: new Headers(),
    });
    const config = {
      ...baseConfig,
      abilityNamespaces: ['mainwp', 'acme-corp'] as [string, ...string[]],
    };

    const result = await executeTool(config, 'acme_corp__do_thing_v1', {}, mockLogger);

    expect(mockFetch.mock.calls[1][0]).toContain('/abilities/acme-corp/do-thing-v1/run');
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
    expect(result.isError).toBeUndefined();
  });
});

describe('confirmation flow - full cycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearPendingPreviews();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should reject confirmation when preview has expired', async () => {
    vi.useFakeTimers();
    const startTime = Date.now();
    vi.setSystemTime(startTime);

    // Step 1: Generate a preview
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: { site_id: 1, will_delete: true } }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );

    expect(previewResult.content[0].text).toContain('CONFIRMATION_REQUIRED');
    const expiredToken = JSON.parse(previewResult.content[0].text as string)
      .confirmation_token as string;

    // Step 2: Advance time beyond PREVIEW_EXPIRY_MS (5 minutes + 1ms)
    vi.setSystemTime(startTime + 5 * 60 * 1000 + 1);

    // Step 3: Attempt confirmation with expired preview
    const expiredResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: expiredToken },
      mockLogger
    );

    expect(expiredResult.content[0].text).toContain('PREVIEW_EXPIRED');
    expect(expiredResult.isError).toBe(true);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Confirmation failed - preview expired',
      expect.objectContaining({ toolName: 'delete_site_v1' })
    );

    // Step 4: Subsequent confirmation with the expired (now deleted) token should require preview
    const subsequentResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: expiredToken },
      mockLogger
    );

    expect(subsequentResult.content[0].text).toContain('PREVIEW_REQUIRED');
  });

  it('should reject confirmation without a token even when a matching preview is pending', async () => {
    // Step 1: Generate a preview (creates a pending preview for these exact args)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: { site_id: 1, will_delete: true } }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );
    expect(previewResult.content[0].text).toContain('CONFIRMATION_REQUIRED');
    const token = JSON.parse(previewResult.content[0].text as string).confirmation_token as string;
    const fetchCallsAfterPreview = mockFetch.mock.calls.length;

    // Step 2: user_confirmed with identical args but NO token must be rejected
    // without any upstream call (a tool+args fallback would let a caller
    // confirm a preview it never read)
    const noTokenResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true, user_confirmed: true },
      mockLogger
    );

    expect(noTokenResult.isError).toBe(true);
    expect(noTokenResult.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(noTokenResult.content[0].text).toContain('confirmation_token');
    expect(mockFetch.mock.calls.length).toBe(fetchCallsAfterPreview);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Confirmation failed - confirmation_token missing',
      expect.objectContaining({ toolName: 'delete_site_v1' })
    );

    // Step 3: The issued token still works after the rejected attempt
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ deleted: true }),
      headers: new Headers(),
    });
    const confirmedResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: token },
      mockLogger
    );
    expect(confirmedResult.isError).toBeUndefined();
    expect(confirmedResult.content[0].text).toContain('deleted');
  });

  it('should reject reuse of consumed confirmation_token', async () => {
    // Step 1: Generate preview
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );
    const parsed = JSON.parse(previewResult.content[0].text);
    const token = parsed.confirmation_token;

    // Step 2: Confirm with token (consumes it)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
      headers: new Headers(),
    });

    const confirmResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: token },
      mockLogger
    );
    expect(confirmResult.content[0].text).toContain('success');

    // Step 3: Attempt to reuse the same token
    const reuseResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: token },
      mockLogger
    );
    expect(reuseResult.content[0].text).toContain('PREVIEW_REQUIRED');
  });

  it('should reject cross-tool confirmation token reuse', async () => {
    // Step 1: Generate preview for delete_site_v1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true, affected: [1] }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );
    const parsed = JSON.parse(previewResult.content[0].text);
    const token = parsed.confirmation_token;

    // Step 2: Attempt to use that token on a different destructive tool
    const crossToolResult = await executeTool(
      baseConfig,
      'delete_plugins_v1',
      { site_id: 1, plugins: ['akismet'], user_confirmed: true, confirmation_token: token },
      mockLogger
    );

    // Should be rejected — token was scoped to delete_site_v1
    expect(crossToolResult.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(crossToolResult.isError).toBe(true);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Confirmation failed - token belongs to a different tool or identity',
      expect.objectContaining({ toolName: 'delete_plugins_v1' })
    );

    // Step 3: The token should have been consumed (deleted) — verify it can't be reused on original tool either
    const reuseResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: token },
      mockLogger
    );
    expect(reuseResult.content[0].text).toContain('PREVIEW_REQUIRED');
  });

  it('rejects a confirmation token issued under a different config identity', async () => {
    // Preview against dashboard A
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true, affected: [1] }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );
    const token = JSON.parse(previewResult.content[0].text).confirmation_token;
    expect(token).toBeDefined();

    // Confirm against dashboard B with the same tool and arguments: the
    // module-level preview maps are shared, so without identity scoping this
    // would execute against a dashboard that never previewed anything.
    const otherDashboard = { ...baseConfig, dashboardUrl: 'https://other-dashboard.example' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const crossIdentityResult = await executeTool(
      otherDashboard,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: token },
      mockLogger
    );

    expect(crossIdentityResult.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(crossIdentityResult.isError).toBe(true);
  });

  it('should reject confirmation when arguments differ from preview (arg-swap)', async () => {
    // Step 1: Generate preview for delete_site_v1 with site_id: 1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true, site_id: 1 }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );
    const parsed = JSON.parse(previewResult.content[0].text);
    const token = parsed.confirmation_token;
    expect(token).toBeDefined();

    // Step 2: Attempt to confirm with different site_id (arg-swap attack)
    const swapResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 2, user_confirmed: true, confirmation_token: token },
      mockLogger
    );

    // Should be rejected — args don't match the preview
    expect(swapResult.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(swapResult.isError).toBe(true);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Confirmation failed - arguments do not match preview',
      expect.objectContaining({ toolName: 'delete_site_v1' })
    );
  });

  it('should reject confirmation when nested arguments differ from preview (nested arg-swap)', async () => {
    // Step 1: Generate preview with a nested argument value
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true, site_id: 1 }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, settings: { role: 'viewer' }, confirm: true },
      mockLogger
    );
    const parsed = JSON.parse(previewResult.content[0].text);
    const token = parsed.confirmation_token;
    expect(token).toBeDefined();

    // Step 2: Confirm with the same top-level shape but a different nested value
    const swapResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      {
        site_id: 1,
        settings: { role: 'admin' },
        user_confirmed: true,
        confirmation_token: token,
      },
      mockLogger
    );

    expect(swapResult.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(swapResult.isError).toBe(true);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Confirmation failed - arguments do not match preview',
      expect.objectContaining({ toolName: 'delete_site_v1' })
    );
  });

  it('should reject confirmation when values nested under a __proto__ key differ from preview', async () => {
    // JSON.parse creates __proto__ as an own property; a plain-object
    // canonicalization target would silently drop it via the prototype setter,
    // collapsing differing payloads onto one preview key.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: true, site_id: 1 }),
      headers: new Headers(),
    });

    const previewArgs = JSON.parse(
      '{"site_id":1,"settings":{"__proto__":{"role":"viewer"}},"confirm":true}'
    ) as Record<string, unknown>;
    const previewResult = await executeTool(baseConfig, 'delete_site_v1', previewArgs, mockLogger);
    const parsed = JSON.parse(previewResult.content[0].text);
    const token = parsed.confirmation_token;
    expect(token).toBeDefined();

    const confirmArgs = JSON.parse(
      '{"site_id":1,"settings":{"__proto__":{"role":"admin"}},"user_confirmed":true}'
    ) as Record<string, unknown>;
    confirmArgs.confirmation_token = token;
    const swapResult = await executeTool(baseConfig, 'delete_site_v1', confirmArgs, mockLogger);

    expect(swapResult.content[0].text).toContain('PREVIEW_REQUIRED');
    expect(swapResult.isError).toBe(true);
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Confirmation failed - arguments do not match preview',
      expect.objectContaining({ toolName: 'delete_site_v1' })
    );
  });

  it('should complete two-phase confirmation flow', async () => {
    // Step 1: Preview
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: { site_id: 1, will_delete: true } }),
      headers: new Headers(),
    });

    const previewResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );

    expect(previewResult.content[0].text).toContain('CONFIRMATION_REQUIRED');
    const confirmationToken = JSON.parse(previewResult.content[0].text as string)
      .confirmation_token as string;

    // Step 2: Confirm execution with the issued token
    // Note: abilities are already cached from step 1, so no need to mock abilities fetch again
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, deleted_site_id: 1 }),
      headers: new Headers(),
    });

    const confirmResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: confirmationToken },
      mockLogger
    );

    expect(confirmResult.content[0].text).toContain('success');
  });
});

describe('session data tracking', () => {
  beforeEach(() => resetSessionData());

  it('should return usage object with used and limit', () => {
    const usage = getSessionDataUsage(baseConfig);
    expect(usage).toEqual({
      used: expect.any(Number),
      limit: baseConfig.maxSessionData,
    });
    expect(usage.used).toBeGreaterThanOrEqual(0);
  });

  it('should reset session data to zero', () => {
    resetSessionData();
    const usage = getSessionDataUsage(baseConfig);
    expect(usage.used).toBe(0);
  });
});

describe('no-op error handling for idempotent tools', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearToolsCache();
    clearPendingPreviews();
    resetSessionData();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return NO_CHANGE for idempotent tool with recognized no-op error code', async () => {
    // Abilities fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // API returns 409 with already_active error code
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () =>
        JSON.stringify({ code: 'already_active', message: 'Plugin is already active' }),
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'activate_site_plugins_v1',
      { site_id: 1, plugins: ['hello-dolly'] },
      mockLogger
    );

    expect(result.content).toHaveLength(1);
    // No-op is a successful outcome, not a failed call
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('NO_CHANGE');
    expect(parsed.message).toContain('activate_site_plugins_v1');
    expect(parsed.details.code).toBe('already_active');
    expect(parsed.details.reason).toContain('Already active');
    expect(parsed.details.tool).toBe('activate_site_plugins_v1');
    expect(parsed.details.ability).toBe('mainwp/activate-site-plugins-v1');
  });

  it('should log no-op at info level with byte tracking', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () =>
        JSON.stringify({ code: 'already_active', message: 'Plugin is already active' }),
      headers: new Headers(),
    });

    await executeTool(
      baseConfig,
      'activate_site_plugins_v1',
      { site_id: 1, plugins: ['hello-dolly'] },
      mockLogger
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Tool execution no-op (idempotent already-state)',
      expect.objectContaining({
        toolName: 'activate_site_plugins_v1',
        durationMs: expect.any(Number),
        responseBytes: expect.any(Number),
        sessionDataBytes: expect.any(Number),
      })
    );
    // Should NOT log an error
    expect(mockLogger.error).not.toHaveBeenCalledWith('Tool execution failed', expect.anything());
  });

  it('should NOT intercept no-op errors for non-idempotent tools', async () => {
    // Use a non-idempotent ability: delete-plugins-v1 (destructive: true, idempotent: false)
    // Need to add a sample ability that is non-idempotent and non-destructive to avoid
    // confirmation flow, so we use delete_plugins_v1 with a confirmation token path
    const nonIdempotentAbilities: Ability[] = [
      {
        name: 'mainwp/simple-action-v1',
        label: 'Simple Action',
        description: 'A non-idempotent, non-destructive action',
        category: 'mainwp-test',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'ID' },
          },
          required: ['id'],
        },
        meta: {
          annotations: {
            readonly: false,
            destructive: false,
            idempotent: false,
          },
        },
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => nonIdempotentAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => JSON.stringify({ code: 'already_active', message: 'Already active' }),
      headers: new Headers(),
    });

    const result = await executeTool(baseConfig, 'simple_action_v1', { id: 1 }, mockLogger);

    // Should surface as a normal error, not NO_CHANGE
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toBeDefined();
  });

  it('should NOT intercept unrecognized error codes for idempotent tools', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // Unrecognized error code on an idempotent tool
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ code: 'invalid_plugin', message: 'Plugin not found' }),
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'activate_site_plugins_v1',
      { site_id: 1, plugins: ['nonexistent'] },
      mockLogger
    );

    // Should surface as a normal error, not NO_CHANGE
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toBeDefined();
    expect(mockLogger.error).toHaveBeenCalledWith('Tool execution failed', expect.anything());
  });

  it('should NOT intercept 5xx errors even with recognized error codes', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // 500 with a no-op code — should NOT be intercepted
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({ code: 'already_active', message: 'Server error' }),
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'activate_site_plugins_v1',
      { site_id: 1, plugins: ['hello-dolly'] },
      mockLogger
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toBeDefined();
  });

  it('should track session data bytes for no-op responses', async () => {
    resetSessionData();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => JSON.stringify({ code: 'already_active', message: 'Already active' }),
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'activate_site_plugins_v1',
      { site_id: 1, plugins: ['hello-dolly'] },
      mockLogger
    );

    const responseBytes = Buffer.byteLength(result.content[0].text, 'utf8');
    const usage = getSessionDataUsage(baseConfig);
    expect(usage.used).toBeGreaterThanOrEqual(responseBytes);
  });
});

describe('generateInstructions', () => {
  it('should include preview guidance for destructive tools with confirm and dry_run', () => {
    const meta = { destructive: true, idempotent: false, readonly: false };
    const result = generateInstructions(meta, true, true);

    expect(result).toContain('Always preview with dry_run or confirm');
    expect(result).toContain('Not idempotent');
  });

  it('should include generic destructive warning when no dry_run or confirm', () => {
    const meta = { destructive: true, idempotent: true, readonly: false };
    const result = generateInstructions(meta, false, false);

    expect(result).toContain('This is destructive');
    expect(result).not.toContain('Not idempotent');
  });

  it('should include read-only assurance for readonly tools', () => {
    const meta = { readonly: true, destructive: false, idempotent: true };
    const result = generateInstructions(meta, false, false);

    expect(result).toContain('Read-only. Safe to call');
  });

  it('should prepend API-provided instructions with punctuation guard', () => {
    const meta = {
      readonly: true,
      destructive: false,
      idempotent: true,
      instructions: 'Requires module',
    };
    const result = generateInstructions(meta, false, false);

    expect(result).toMatch(/^Requires module\./);
    expect(result).toContain('Read-only. Safe to call');
  });

  it('should return write operation text for non-destructive non-readonly tools', () => {
    const meta = { readonly: false, destructive: false, idempotent: true };
    const result = generateInstructions(meta, false, false);

    expect(result).toContain('Write operation.');
  });

  it('should not duplicate period on instructions ending with punctuation', () => {
    const meta = {
      readonly: true,
      destructive: false,
      idempotent: true,
      instructions: 'Needs Pro.',
    };
    const result = generateInstructions(meta, false, false);

    expect(result).toMatch(/^Needs Pro\./);
    expect(result).not.toContain('Needs Pro..');
  });
});

describe('buildSafetyTags', () => {
  it('should build verbose tags for destructive tools with confirm and dry_run in standard mode', () => {
    const meta = { destructive: true, idempotent: false, readonly: false };
    const result = buildSafetyTags(meta, true, true, 'standard');

    expect(result).toBe(
      '[DESTRUCTIVE, Requires two-step confirmation, Supports dry_run, Not idempotent]'
    );
  });

  it('should build minimal tag for destructive tools without confirm or dry_run in standard mode', () => {
    const meta = { destructive: true, idempotent: true, readonly: false };
    const result = buildSafetyTags(meta, false, false, 'standard');

    expect(result).toBe('[DESTRUCTIVE]');
  });

  it('should build Read-only tag in standard mode', () => {
    const meta = { readonly: true, destructive: false, idempotent: true };
    const result = buildSafetyTags(meta, false, false, 'standard');

    expect(result).toBe('[Read-only]');
  });

  it('should return empty string when no annotations apply in standard mode', () => {
    const meta = { readonly: false, destructive: false, idempotent: true };
    const result = buildSafetyTags(meta, false, false, 'standard');

    expect(result).toBe('');
  });

  it('should build compact tags for destructive tools with confirm and dry_run', () => {
    const meta = { destructive: true, idempotent: false, readonly: false };
    const result = buildSafetyTags(meta, true, true, 'compact');

    expect(result).toBe('[destructive, confirm, dry_run]');
  });

  it('should return empty string for readonly tools in compact mode', () => {
    const meta = { readonly: true, destructive: false, idempotent: true };
    const result = buildSafetyTags(meta, false, false, 'compact');

    expect(result).toBe('');
  });
});

describe('isNoOpError', () => {
  it('should match known no-op error code with 4xx status', () => {
    expect(isNoOpError({ status: 409, code: 'already_active' })).toBe(true);
  });

  it('should match all nine NOOP_ERROR_CODES', () => {
    const codes = [
      'already_active',
      'already_inactive',
      'already_installed',
      'already_connected',
      'already_disconnected',
      'already_suspended',
      'already_unsuspended',
      'no_updates_available',
      'nothing_to_update',
    ];

    for (const code of codes) {
      expect(isNoOpError({ status: 400, code })).toBe(true);
    }
  });

  it('should reject 5xx status even with recognized code', () => {
    expect(isNoOpError({ status: 500, code: 'already_active' })).toBe(false);
  });

  it('should reject missing status property', () => {
    expect(isNoOpError({ code: 'already_active' })).toBe(false);
  });

  it('should reject unknown error code', () => {
    expect(isNoOpError({ status: 409, code: 'invalid_plugin' })).toBe(false);
  });

  it('should reject non-object values', () => {
    expect(isNoOpError(null)).toBe(false);
    expect(isNoOpError('string')).toBe(false);
    expect(isNoOpError(42)).toBe(false);
    expect(isNoOpError(undefined)).toBe(false);
  });
});

describe('name conversion re-exports', () => {
  it('should export abilityNameToToolName', () => {
    expect(typeof abilityNameToToolName).toBe('function');
    expect(abilityNameToToolName('mainwp/test-v1', 'mainwp')).toBe('test_v1');
  });
});

describe('default-deny annotations', () => {
  const abilityWithoutAnnotations: Ability = {
    name: 'mainwp/mystery-action-v1',
    label: 'Mystery Action',
    description: 'An ability with no annotations',
    category: 'mainwp-misc',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target' },
      },
    },
    // Note: no meta.annotations
  };

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearPendingPreviews();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should block ability without annotations in safe mode (defaults to destructive)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [abilityWithoutAnnotations],
      headers: new Headers(),
    });

    const config = { ...baseConfig, safeMode: true };
    const result = await executeTool(config, 'mystery_action_v1', { target: 'test' }, mockLogger);

    expect(result.content[0].text).toContain('SAFE_MODE_BLOCKED');
    expect(result.isError).toBe(true);
  });

  it('should log warning about missing annotations', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [abilityWithoutAnnotations],
      headers: new Headers(),
    });

    const config = { ...baseConfig, safeMode: true };
    await executeTool(config, 'mystery_action_v1', { target: 'test' }, mockLogger);

    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Ability missing destructive annotation, defaulting to destructive',
      expect.objectContaining({
        toolName: 'mystery_action_v1',
        abilityName: 'mainwp/mystery-action-v1',
        hasAnnotations: false,
      })
    );
  });
});

describe('request correlation IDs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearPendingPreviews();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should include requestId (UUID format) in log calls', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
      headers: new Headers(),
    });

    await executeTool(baseConfig, 'list_sites_v1', {}, mockLogger);

    // The mockLogger receives calls from withRequestId wrapper, which adds requestId
    // Check the debug call for 'Tool execution started' — it uses the reqLogger
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const debugCalls = (mockLogger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const startedCall = debugCalls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Tool execution started')
    );

    expect(startedCall).toBeDefined();
    expect(startedCall![1]).toHaveProperty('requestId');
    expect(startedCall![1].requestId).toMatch(uuidRegex);
  });
});
