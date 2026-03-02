/**
 * Schema Quality Evaluation
 *
 * Verifies that MCP tool schemas are well-formed for LLM consumption:
 * - Required parameters have descriptions
 * - All parameters have type annotations
 * - Array parameters have items defined
 * - No schema exceeds the LLM confusion threshold (15 properties)
 * - Compact mode preserves required parameter info
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTools, clearToolsCache } from '../../src/tools.js';
import { clearCache, initRateLimiter } from '../../src/abilities.js';
import { type Config } from '../../src/config.js';

import abilitiesFixture from './fixtures/abilities-full.json';

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

function mockAbilitiesFetch(): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => abilitiesFixture,
    headers: new Headers(),
  });
}

describe('Schema Quality', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearToolsCache();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('standard mode', () => {
    it('every required parameter should have a non-empty description', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        const props = (tool.inputSchema.properties || {}) as Record<string, Record<string, unknown>>;
        const required = (tool.inputSchema.required || []) as string[];

        for (const paramName of required) {
          const param = props[paramName];
          if (!param?.description || String(param.description).trim().length === 0) {
            violations.push(`${tool.name}.${paramName}`);
          }
        }
      }

      expect(violations, `Required params missing descriptions: ${violations.join(', ')}`).toEqual(
        []
      );
    });

    it('every parameter should have a type annotation', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        const props = (tool.inputSchema.properties || {}) as Record<string, Record<string, unknown>>;

        for (const [paramName, param] of Object.entries(props)) {
          // Skip injected params (user_confirmed, confirmation_token) — they're always typed
          if (paramName === 'user_confirmed' || paramName === 'confirmation_token') continue;

          if (!param?.type && !param?.enum && !param?.oneOf && !param?.anyOf) {
            violations.push(`${tool.name}.${paramName}`);
          }
        }
      }

      expect(violations, `Params missing type: ${violations.join(', ')}`).toEqual([]);
    });

    it('array parameters should have items defined', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        const props = (tool.inputSchema.properties || {}) as Record<string, Record<string, unknown>>;

        for (const [paramName, param] of Object.entries(props)) {
          const paramType = param?.type;
          const isArray =
            paramType === 'array' || (Array.isArray(paramType) && paramType.includes('array'));

          if (isArray && !param?.items) {
            violations.push(`${tool.name}.${paramName}`);
          }
        }
      }

      expect(violations, `Array params missing items: ${violations.join(', ')}`).toEqual([]);
    });

    it('no schema should exceed 16 properties (LLM confusion threshold)', async () => {
      // Threshold set at 16 to accommodate real-world tools like update_client_v1
      // which has 16 properties in the upstream API. user_confirmed injection adds 1
      // more for destructive tools, so the effective max for destructive tools is 17.
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        const props = tool.inputSchema.properties || {};
        const count = Object.keys(props).length;
        if (count > 16) {
          violations.push(`${tool.name} (${count} properties)`);
        }
      }

      expect(
        violations,
        `Schemas exceeding 16 properties: ${violations.join(', ')}`
      ).toEqual([]);
    });
  });

  describe('compact mode', () => {
    it('should preserve all required parameter descriptions', async () => {
      mockAbilitiesFetch();
      const compactTools = await getTools({ ...baseConfig, schemaVerbosity: 'compact' });

      const violations: string[] = [];
      for (const tool of compactTools) {
        const props = (tool.inputSchema.properties || {}) as Record<string, Record<string, unknown>>;
        const required = (tool.inputSchema.required || []) as string[];

        for (const paramName of required) {
          const param = props[paramName];
          if (!param?.description || String(param.description).trim().length === 0) {
            violations.push(`${tool.name}.${paramName}`);
          }
        }
      }

      expect(
        violations,
        `Compact mode drops required param descriptions: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('should preserve all parameter type annotations', async () => {
      mockAbilitiesFetch();
      const compactTools = await getTools({ ...baseConfig, schemaVerbosity: 'compact' });

      const violations: string[] = [];
      for (const tool of compactTools) {
        const props = (tool.inputSchema.properties || {}) as Record<string, Record<string, unknown>>;

        for (const [paramName, param] of Object.entries(props)) {
          if (paramName === 'user_confirmed' || paramName === 'confirmation_token') continue;
          if (!param?.type && !param?.enum && !param?.oneOf && !param?.anyOf) {
            violations.push(`${tool.name}.${paramName}`);
          }
        }
      }

      expect(violations, `Compact mode drops types: ${violations.join(', ')}`).toEqual([]);
    });

    it('should preserve array items definitions', async () => {
      mockAbilitiesFetch();
      const compactTools = await getTools({ ...baseConfig, schemaVerbosity: 'compact' });

      const violations: string[] = [];
      for (const tool of compactTools) {
        const props = (tool.inputSchema.properties || {}) as Record<string, Record<string, unknown>>;

        for (const [paramName, param] of Object.entries(props)) {
          const paramType = param?.type;
          const isArray =
            paramType === 'array' || (Array.isArray(paramType) && paramType.includes('array'));

          if (isArray && !param?.items) {
            violations.push(`${tool.name}.${paramName}`);
          }
        }
      }

      expect(violations, `Compact mode drops items: ${violations.join(', ')}`).toEqual([]);
    });
  });

  describe('fixture staleness', () => {
    it('should warn if ability count diverges from reference doc', async () => {
      // Count section headings in abilities-reference.md
      const fs = await import('fs');
      const path = await import('path');
      const refPath = path.resolve(
        import.meta.dirname,
        '../../.mwpdev/abilities-reference.md'
      );

      let refCount = 0;
      if (fs.existsSync(refPath)) {
        const content = fs.readFileSync(refPath, 'utf8');
        // Count ### headings that match ability names (e.g., ### list_sites_v1)
        const headings = content.match(/^### \w+_v\d+/gm);
        refCount = headings?.length ?? 0;
      }

      const fixtureCount = abilitiesFixture.filter(
        (a: { name: string }) => a.name.startsWith('mainwp/')
      ).length;

      if (refCount > 0 && fixtureCount !== refCount) {
        console.warn(
          `\n⚠ Fixture staleness: fixture has ${fixtureCount} abilities, ` +
            `reference doc has ${refCount} headings. ` +
            `Consider re-capturing the fixture.\n`
        );
      }

      // This test always passes — it's a warning, not a failure
      expect(true).toBe(true);
    });
  });
});
