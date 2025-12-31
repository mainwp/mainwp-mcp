/**
 * MCP Tool Conversion Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTools,
  executeTool,
  getSessionDataUsage,
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

    expect(tools).toHaveLength(3);
    expect(tools[0].name).toBe('list_sites_v1');
    expect(tools[1].name).toBe('delete_site_v1');
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

    expect(tools).toHaveLength(2);
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

  it('should handle user_confirmed on tool without confirm parameter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    // update-site-v1 is not destructive, has no confirm param
    await executeTool(
      baseConfig,
      'update_site_v1',
      { site_id: 1, user_confirmed: true },
      mockLogger
    );

    // Non-destructive tool should execute normally
    // Only destructive tools with confirm param need user_confirmed validation
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

  it('should track response sizes', () => {
    const usage = getSessionDataUsage();
    expect(typeof usage).toBe('number');
    expect(usage).toBeGreaterThanOrEqual(0);
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
