/**
 * Tools Integration Tests
 *
 * End-to-end tests for tool execution flow including validation,
 * confirmation, and safe mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTools, executeTool, clearPendingPreviews } from '../../src/tools.js';
import { clearCache, initRateLimiter } from '../../src/abilities.js';
import { type Config } from '../../src/config.js';
import { type Logger } from '../../src/logging.js';

// Import fixtures
import abilitiesFixture from '../fixtures/abilities.json';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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
  configSource: 'environment',
  retryEnabled: false,
  maxRetries: 2,
  retryBaseDelay: 1000,
  retryMaxDelay: 2000,
};

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};

describe('Tools Integration', () => {
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

  describe('getTools integration', () => {
    it('should convert fixture abilities to tools', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const tools = await getTools(baseConfig);

      expect(tools).toHaveLength(abilitiesFixture.length);
      expect(tools.map(t => t.name)).toContain('list_sites_v1');
      expect(tools.map(t => t.name)).toContain('get_site_v1');
      expect(tools.map(t => t.name)).toContain('delete_site_v1');
    });

    it('should add user_confirmed to destructive tools', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const tools = await getTools(baseConfig);
      const deleteTool = tools.find(t => t.name === 'delete_site_v1');

      expect(deleteTool?.inputSchema.properties).toHaveProperty('user_confirmed');
    });

    it('should mark destructive tools in descriptions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const tools = await getTools(baseConfig);
      const deleteTool = tools.find(t => t.name === 'delete_site_v1');

      expect(deleteTool?.description).toContain('DESTRUCTIVE');
    });
  });

  describe('executeTool - read-only operations', () => {
    it('should execute read-only tool successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sites: [{ id: 1, name: 'Test Site', url: 'https://test.com' }],
          total: 1,
        }),
        headers: new Headers(),
      });

      const result = await executeTool(
        baseConfig,
        'list_sites_v1',
        { page: 1, per_page: 10 },
        mockLogger
      );

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');

      const parsed = JSON.parse(result[0].text);
      expect(parsed.sites).toHaveLength(1);
    });

    it('should pass parameters to ability', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 123, name: 'Site' }),
        headers: new Headers(),
      });

      await executeTool(baseConfig, 'get_site_v1', { site_id_or_domain: 123 }, mockLogger);

      // Verify the URL included the parameter
      const execCall = mockFetch.mock.calls[1];
      const url = execCall[0] as string;
      expect(url).toContain('site_id_or_domain');
    });
  });

  describe('executeTool - safe mode', () => {
    it('should block destructive tool in safe mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const safeConfig = { ...baseConfig, safeMode: true };
      const result = await executeTool(
        safeConfig,
        'delete_site_v1',
        { site_id_or_domain: 1, confirm: true },
        mockLogger
      );

      expect(result[0].text).toContain('SAFE_MODE_BLOCKED');
      expect(result[0].text).toContain('delete_site_v1');
    });

    it('should allow read-only tool in safe mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sites: [] }),
        headers: new Headers(),
      });

      const safeConfig = { ...baseConfig, safeMode: true };
      const result = await executeTool(safeConfig, 'list_sites_v1', {}, mockLogger);

      const parsed = JSON.parse(result[0].text);
      expect(parsed).toHaveProperty('sites');
    });
  });

  describe('executeTool - confirmation flow', () => {
    it('should generate preview for destructive operation', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dry_run: true,
          site: { id: 1, name: 'Test' },
          would_delete: true,
        }),
        headers: new Headers(),
      });

      const result = await executeTool(
        baseConfig,
        'delete_site_v1',
        { site_id_or_domain: 1, confirm: true },
        mockLogger
      );

      expect(result[0].text).toContain('CONFIRMATION_REQUIRED');
      expect(result[0].text).toContain('preview');
      expect(result[0].text).toContain('user_confirmed');
    });

    it('should complete two-phase confirmation flow', async () => {
      // Phase 1: Preview request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dry_run: true, would_delete: true }),
        headers: new Headers(),
      });

      const previewResult = await executeTool(
        baseConfig,
        'delete_site_v1',
        { site_id_or_domain: 1, confirm: true },
        mockLogger
      );

      expect(previewResult[0].text).toContain('CONFIRMATION_REQUIRED');

      // Phase 2: Confirmed execution (need to clear logger mocks for fresh tracking)
      vi.mocked(mockLogger.info).mockClear();

      // Note: abilities are already cached from Phase 1, so no need to mock abilities fetch again
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, deleted: true }),
        headers: new Headers(),
      });

      const confirmResult = await executeTool(
        baseConfig,
        'delete_site_v1',
        { site_id_or_domain: 1, user_confirmed: true },
        mockLogger
      );

      const parsed = JSON.parse(confirmResult[0].text);
      expect(parsed.success).toBe(true);
    });

    it('should reject user_confirmed without preview', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      // Skip preview, go straight to confirm
      const result = await executeTool(
        baseConfig,
        'delete_site_v1',
        { site_id_or_domain: 999, user_confirmed: true },
        mockLogger
      );

      expect(result[0].text).toContain('PREVIEW_REQUIRED');
    });

    it('should reject conflicting parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const result = await executeTool(
        baseConfig,
        'delete_site_v1',
        { site_id_or_domain: 1, dry_run: true, user_confirmed: true },
        mockLogger
      );

      expect(result[0].text).toContain('CONFLICTING_PARAMETERS');
    });

    it('should allow explicit dry_run to bypass confirmation', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
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
        { site_id_or_domain: 1, dry_run: true },
        mockLogger
      );

      // Should return the dry_run result directly, not CONFIRMATION_REQUIRED
      const parsed = JSON.parse(result[0].text);
      expect(parsed.dry_run).toBe(true);
    });
  });

  describe('executeTool - error handling', () => {
    it('should handle ability execution errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () =>
          JSON.stringify({
            code: 'site_not_found',
            message: 'Site does not exist',
          }),
      });

      const result = await executeTool(
        baseConfig,
        'get_site_v1',
        { site_id_or_domain: 999 },
        mockLogger
      );

      expect(result[0].text).toContain('error');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should validate input and reject invalid IDs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const result = await executeTool(baseConfig, 'get_site_v1', { site_id: -1 }, mockLogger);

      expect(result[0].text).toContain('error');
      expect(result[0].text).toContain('positive integer');
    });

    it('should handle tool not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const result = await executeTool(baseConfig, 'nonexistent_tool_v1', {}, mockLogger);

      expect(result[0].text).toContain('error');
      expect(result[0].text).toContain('not found');
    });
  });

  describe('executeTool - logging', () => {
    it('should log tool execution start and end', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
        headers: new Headers(),
      });

      await executeTool(baseConfig, 'list_sites_v1', {}, mockLogger);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('started'),
        expect.any(Object)
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('succeeded'),
        expect.objectContaining({ durationMs: expect.any(Number) })
      );
    });

    it('should log destructive operations', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
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
        { site_id_or_domain: 1, confirm: true },
        mockLogger
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Destructive'),
        expect.any(Object)
      );
    });
  });
});
