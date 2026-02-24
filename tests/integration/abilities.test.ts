/**
 * Abilities Integration Tests
 *
 * End-to-end tests for ability fetching with mocked HTTP responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchAbilities,
  fetchCategories,
  getAbility,
  executeAbility,
  clearCache,
  initRateLimiter,
} from '../../src/abilities.js';
import { type Config } from '../../src/config.js';

// Import fixtures
import abilitiesFixture from '../fixtures/abilities.json';
import categoriesFixture from '../fixtures/categories.json';

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
  configSource: 'environment',
  retryEnabled: false,
  maxRetries: 2,
  retryBaseDelay: 1000,
  retryMaxDelay: 2000,
};

describe('Abilities Integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchAbilities end-to-end', () => {
    it('should fetch abilities and populate cache', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      // First fetch
      const abilities1 = await fetchAbilities(baseConfig);

      expect(abilities1).toHaveLength(abilitiesFixture.length);
      expect(abilities1[0].name).toBe('mainwp/list-sites-v1');

      // Second fetch should use cache
      const abilities2 = await fetchAbilities(baseConfig);

      expect(abilities2).toEqual(abilities1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network unreachable'));

      await expect(fetchAbilities(baseConfig)).rejects.toThrow('Network unreachable');
    });

    it('should use cached data on subsequent error after initial success', async () => {
      // First successful fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const abilities1 = await fetchAbilities(baseConfig);

      // Simulate error on force refresh
      mockFetch.mockRejectedValueOnce(new Error('Server down'));

      // Should return cached data
      const abilities2 = await fetchAbilities(baseConfig, true);

      expect(abilities2).toEqual(abilities1);
    });

    it('should filter abilities by namespace', async () => {
      const mixedAbilities = [
        ...abilitiesFixture,
        {
          name: 'other-plugin/some-ability',
          label: 'Other',
          description: 'From another plugin',
          category: 'other',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mixedAbilities,
        headers: new Headers(),
      });

      const abilities = await fetchAbilities(baseConfig);

      // Should only include mainwp/ abilities
      expect(abilities.every(a => a.name.startsWith('mainwp/'))).toBe(true);
      expect(abilities).toHaveLength(abilitiesFixture.length);
    });
  });

  describe('fetchCategories end-to-end', () => {
    it('should fetch and cache categories', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => categoriesFixture,
        headers: new Headers(),
      });

      const categories = await fetchCategories(baseConfig);

      expect(categories).toHaveLength(categoriesFixture.length);
      expect(categories[0].slug).toBe('mainwp-sites');
    });

    it('should filter categories by namespace', async () => {
      const mixedCategories = [
        ...categoriesFixture,
        { slug: 'other-category', label: 'Other', description: 'Other' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mixedCategories,
        headers: new Headers(),
      });

      const categories = await fetchCategories(baseConfig);

      // Should only include mainwp- prefixed categories
      expect(categories.every(c => c.slug.startsWith('mainwp-'))).toBe(true);
    });
  });

  describe('getAbility end-to-end', () => {
    it('should find ability from fetched list', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const ability = await getAbility(baseConfig, 'mainwp/list-sites-v1');

      expect(ability).toBeDefined();
      expect(ability?.label).toBe('List Sites');
    });

    it('should return undefined for non-existent ability', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      const ability = await getAbility(baseConfig, 'mainwp/non-existent-v1');

      expect(ability).toBeUndefined();
    });
  });

  describe('executeAbility end-to-end', () => {
    it('should execute readonly ability with GET', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sites: [], total: 0 }),
        headers: new Headers(),
      });

      const result = await executeAbility(baseConfig, 'mainwp/list-sites-v1', { page: 1 });

      expect(result).toEqual({ sites: [], total: 0 });

      // Verify GET was used
      const execCall = mockFetch.mock.calls[1];
      expect(execCall[1].method).toBe('GET');
    });

    it('should execute destructive + idempotent ability with DELETE', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, deleted: true }),
        headers: new Headers(),
      });

      const result = await executeAbility(baseConfig, 'mainwp/delete-site-v1', {
        site_id_or_domain: 123,
        confirm: true,
      });

      expect(result).toEqual({ success: true, deleted: true });

      // Verify DELETE was used for destructive + idempotent abilities
      const execCall = mockFetch.mock.calls[1];
      expect(execCall[1].method).toBe('DELETE');
    });

    it('should handle execution errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () =>
          JSON.stringify({
            code: 'invalid_site_id',
            message: 'Site not found',
          }),
        headers: new Headers(),
      });

      await expect(
        executeAbility(baseConfig, 'mainwp/get-site-v1', { site_id_or_domain: 999 })
      ).rejects.toThrow(/invalid_site_id/);
    });
  });

  describe('clearCache behavior', () => {
    it('should clear abilities cache', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => abilitiesFixture,
        headers: new Headers(),
      });

      // Fetch and cache
      await fetchAbilities(baseConfig);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Clear cache
      clearCache();

      // Should fetch again
      await fetchAbilities(baseConfig);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should clear categories cache', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => categoriesFixture,
        headers: new Headers(),
      });

      await fetchCategories(baseConfig);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      clearCache();

      await fetchCategories(baseConfig);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
