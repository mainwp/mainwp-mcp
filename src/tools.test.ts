/**
 * MCP Tool Conversion Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTools,
  executeTool,
  getSessionDataUsage,
  resetSessionData,
  toolNameToAbilityName,
  abilityNameToToolName,
  clearPendingPreviews,
} from './tools.js';
import { type Config } from './config.js';
import { type Logger } from './logging.js';
import { type Ability, clearCache, initRateLimiter } from './abilities.js';

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

const baseConfig: Config = {
  dashboardUrl: 'https://test.local',
  authType: 'basic',
  username: 'admin',
  appPassword: 'xxxx',
  skipSslVerify: true,
  allowHttp: false,
  rateLimit: 0,
  requestTimeout: 5000,
  maxResponseSize: 10485760,
  safeMode: false,
  requireUserConfirmation: true,
  maxSessionData: 52428800,
  schemaVerbosity: 'standard',
  responseFormat: 'compact',
  retryEnabled: false, // Disable retries for tests
  maxRetries: 2,
  retryBaseDelay: 1000,
  retryMaxDelay: 2000,
  configSource: 'environment',
};

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};

describe('getTools', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
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
});

describe('executeTool', () => {
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

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    const parsed = JSON.parse(result[0].text);
    expect(parsed).toContainEqual({ id: 1, name: 'Site 1' });
  });

  it('should validate input before execution', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // Invalid ID should be caught by validation
    const result = await executeTool(baseConfig, 'list_sites_v1', { site_id: -1 }, mockLogger);

    expect(result[0].text).toContain('error');
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

    expect(result[0].text).toContain('SAFE_MODE_BLOCKED');
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

    expect(result[0].text).toContain('CONFIRMATION_REQUIRED');
    expect(result[0].text).toContain('preview');

    // Should include a confirmation token
    const parsed = JSON.parse(result[0].text);
    expect(parsed.metadata.confirmation_token).toBeDefined();
    expect(typeof parsed.metadata.confirmation_token).toBe('string');
    expect(parsed.metadata.confirmation_token.length).toBeGreaterThan(0);
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

    expect(result[0].text).toContain('PREVIEW_REQUIRED');
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

    expect(result[0].text).toContain('CONFLICTING_PARAMETERS');
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
    const parsed = JSON.parse(previewResult[0].text);
    const token = parsed.metadata.confirmation_token;

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

    expect(confirmResult[0].text).toContain('success');
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

    expect(result[0].text).toContain('PREVIEW_REQUIRED');
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

    await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, confirm: true },
      mockLogger
    );

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
    expect(result2[0].text).toContain('CONFIRMATION_REQUIRED');
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
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(result[0].text).not.toContain('error');
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

    expect(result[0].text).toContain('cancelled');
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

    expect(result[0].text).toContain('error');
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
    const parsed = JSON.parse(result[0].text);

    // Compact format should equal JSON.stringify without indentation
    expect(result[0].text).toBe(JSON.stringify(parsed));
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
    expect(result[0].text).toContain('\n');
    const parsed = JSON.parse(result[0].text);
    expect(result[0].text).toBe(JSON.stringify(parsed, null, 2));
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

    expect(previewResult[0].text).toContain('CONFIRMATION_REQUIRED');

    // Step 2: Advance time beyond PREVIEW_EXPIRY_MS (5 minutes + 1ms)
    vi.setSystemTime(startTime + 5 * 60 * 1000 + 1);

    // Step 3: Attempt confirmation with expired preview
    const expiredResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true },
      mockLogger
    );

    expect(expiredResult[0].text).toContain('PREVIEW_EXPIRED');
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Confirmation failed - preview expired',
      expect.objectContaining({ toolName: 'delete_site_v1' })
    );

    // Step 4: Subsequent confirmation without new preview should require preview
    const subsequentResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true },
      mockLogger
    );

    expect(subsequentResult[0].text).toContain('PREVIEW_REQUIRED');
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
    const parsed = JSON.parse(previewResult[0].text);
    const token = parsed.metadata.confirmation_token;

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
    expect(confirmResult[0].text).toContain('success');

    // Step 3: Attempt to reuse the same token
    const reuseResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: token },
      mockLogger
    );
    expect(reuseResult[0].text).toContain('PREVIEW_REQUIRED');
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
    const parsed = JSON.parse(previewResult[0].text);
    const token = parsed.metadata.confirmation_token;

    // Step 2: Attempt to use that token on a different destructive tool
    const crossToolResult = await executeTool(
      baseConfig,
      'delete_plugins_v1',
      { site_id: 1, plugins: ['akismet'], user_confirmed: true, confirmation_token: token },
      mockLogger
    );

    // Should be rejected — token was scoped to delete_site_v1
    expect(crossToolResult[0].text).toContain('PREVIEW_REQUIRED');
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Confirmation failed - token belongs to different tool',
      expect.objectContaining({ toolName: 'delete_plugins_v1' })
    );

    // Step 3: The token should have been consumed (deleted) — verify it can't be reused on original tool either
    const reuseResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true, confirmation_token: token },
      mockLogger
    );
    expect(reuseResult[0].text).toContain('PREVIEW_REQUIRED');
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

    expect(previewResult[0].text).toContain('CONFIRMATION_REQUIRED');

    // Step 2: Confirm execution
    // Note: abilities are already cached from step 1, so no need to mock abilities fetch again
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, deleted_site_id: 1 }),
      headers: new Headers(),
    });

    const confirmResult = await executeTool(
      baseConfig,
      'delete_site_v1',
      { site_id: 1, user_confirmed: true },
      mockLogger
    );

    expect(confirmResult[0].text).toContain('success');
  });
});

describe('session data tracking', () => {
  // Note: session data tracking is cumulative across all tests
  // These tests verify the tracking mechanism exists

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
      text: async () => JSON.stringify({ code: 'already_active', message: 'Plugin is already active' }),
      headers: new Headers(),
    });

    const result = await executeTool(
      baseConfig,
      'activate_site_plugins_v1',
      { site_id: 1, plugins: ['hello-dolly'] },
      mockLogger
    );

    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0].text);
    expect(parsed.status).toBe('NO_CHANGE');
    expect(parsed.message).toContain('activate_site_plugins_v1');
    expect(parsed.details.reason).toBe('already_active');
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
      text: async () => JSON.stringify({ code: 'already_active', message: 'Plugin is already active' }),
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
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      'Tool execution failed',
      expect.anything()
    );
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

    const result = await executeTool(
      baseConfig,
      'simple_action_v1',
      { id: 1 },
      mockLogger
    );

    // Should surface as a normal error, not NO_CHANGE
    const parsed = JSON.parse(result[0].text);
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
    const parsed = JSON.parse(result[0].text);
    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toBeDefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Tool execution failed',
      expect.anything()
    );
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

    const parsed = JSON.parse(result[0].text);
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

    const responseBytes = Buffer.byteLength(result[0].text, 'utf8');
    const usage = getSessionDataUsage(baseConfig);
    expect(usage.used).toBeGreaterThanOrEqual(responseBytes);
  });
});

describe('name conversion re-exports', () => {
  it('should export abilityNameToToolName', () => {
    expect(typeof abilityNameToToolName).toBe('function');
    expect(abilityNameToToolName('mainwp/test-v1')).toBe('test_v1');
  });

  it('should export toolNameToAbilityName', () => {
    expect(typeof toolNameToAbilityName).toBe('function');
    expect(toolNameToAbilityName('test_v1', 'mainwp')).toBe('mainwp/test-v1');
  });
});
