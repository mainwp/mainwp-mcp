/**
 * Description Quality Evaluation
 *
 * Verifies that MCP tool descriptions are useful for LLM tool selection:
 * - Every tool has a non-empty description > 20 chars
 * - Destructive tools mention danger/safety/confirmation
 * - Read-only tools indicate their read-only nature
 * - No duplicate descriptions within the same category
 * - No description exceeds 1200 characters
 * - Compact mode preserves the primary verb/action word
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

/** Extract category from an ability name (e.g., "mainwp/list-sites-v1" → "sites") */
function getCategoryFromAbilityName(abilityName: string): string {
  const fixture = abilitiesFixture.find(a => a.name === abilityName);
  return fixture?.category ?? 'unknown';
}

describe('Description Quality', () => {
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
    it('every tool should have a non-empty description > 20 chars', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        if (!tool.description || tool.description.trim().length <= 20) {
          violations.push(`${tool.name} (${tool.description?.length ?? 0} chars)`);
        }
      }

      expect(violations, `Tools with insufficient descriptions: ${violations.join(', ')}`).toEqual(
        []
      );
    });

    it('destructive tools should mention safety/confirmation in description or tags', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const safetyTerms = /destructive|confirm|danger|warning|caution|preview|two-step|dry.?run/i;
      const violations: string[] = [];

      for (const tool of tools) {
        const isDestructive = tool.annotations?.destructiveHint === true;
        if (isDestructive) {
          if (!safetyTerms.test(tool.description ?? '')) {
            violations.push(tool.name);
          }
        }
      }

      expect(
        violations,
        `Destructive tools missing safety language: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('read-only tools should indicate read-only nature', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const readOnlyIndicators = /read.?only|\[RO\]|safe to call|no confirmation/i;
      const violations: string[] = [];

      for (const tool of tools) {
        const isReadOnly = tool.annotations?.readOnlyHint === true;
        if (isReadOnly) {
          if (!readOnlyIndicators.test(tool.description ?? '')) {
            violations.push(tool.name);
          }
        }
      }

      expect(
        violations,
        `Read-only tools missing read-only indicator: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('no two tools in the same category should have identical descriptions', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      // Build category map from fixture data
      const categoryMap = new Map<string, Map<string, string[]>>();
      for (const tool of tools) {
        // Reverse-lookup the ability to get its category
        const abilityName = `mainwp/${tool.name.replace(/_/g, '-')}`;
        const category = getCategoryFromAbilityName(abilityName);

        if (!categoryMap.has(category)) {
          categoryMap.set(category, new Map());
        }
        const descMap = categoryMap.get(category)!;
        const desc = tool.description ?? '';
        if (!descMap.has(desc)) {
          descMap.set(desc, []);
        }
        descMap.get(desc)!.push(tool.name);
      }

      const violations: string[] = [];
      for (const [category, descMap] of categoryMap) {
        for (const [_desc, toolNames] of descMap) {
          if (toolNames.length > 1) {
            violations.push(`${category}: ${toolNames.join(', ')}`);
          }
        }
      }

      expect(
        violations,
        `Duplicate descriptions within category: ${violations.join('; ')}`
      ).toEqual([]);
    });

    it('no description should exceed 1200 characters', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        const len = tool.description?.length ?? 0;
        if (len > 1200) {
          violations.push(`${tool.name} (${len} chars)`);
        }
      }

      expect(violations, `Descriptions exceeding 1200 chars: ${violations.join(', ')}`).toEqual([]);
    });
  });

  describe('compact mode', () => {
    it('every tool should have a non-empty description > 20 chars', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'compact' });

      const violations: string[] = [];
      for (const tool of tools) {
        if (!tool.description || tool.description.trim().length <= 20) {
          violations.push(`${tool.name} (${tool.description?.length ?? 0} chars)`);
        }
      }

      expect(
        violations,
        `Compact tools with insufficient descriptions: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('compact descriptions should preserve the primary action verb', async () => {
      // Get both modes
      mockAbilitiesFetch();
      const standardTools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      clearCache();
      clearToolsCache();
      mockAbilitiesFetch();
      const compactTools = await getTools({ ...baseConfig, schemaVerbosity: 'compact' });

      const violations: string[] = [];
      for (const stdTool of standardTools) {
        const compactTool = compactTools.find(t => t.name === stdTool.name);
        if (!compactTool) continue;

        // Extract the primary verb from the tool name (e.g., list_sites_v1 → "list")
        const verb = stdTool.name.split('_')[0];

        // The compact description should contain the ability's original description start
        // or at minimum be non-trivial
        const compactDesc = compactTool.description?.toLowerCase() ?? '';
        const stdDesc = stdTool.description?.toLowerCase() ?? '';

        // Check that the compact description contains some word from the standard description's
        // first sentence (a loose check that meaning is preserved)
        const firstSentence = stdDesc.split(/[.!?]/)[0] ?? '';
        const contentWords = firstSentence
          .split(/\s+/)
          .filter(w => w.length > 3)
          .slice(0, 3);

        const hasOverlap = contentWords.some(w => compactDesc.includes(w));
        if (!hasOverlap && verb.length > 2 && !compactDesc.includes(verb)) {
          violations.push(`${stdTool.name}: compact="${compactTool.description?.slice(0, 50)}..."`);
        }
      }

      expect(
        violations,
        `Compact descriptions lost action context: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('destructive tools in compact mode should still have safety markers', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'compact' });

      const safetyTerms = /destructive|confirm|flow/i;
      const violations: string[] = [];

      for (const tool of tools) {
        const isDestructive = tool.annotations?.destructiveHint === true;
        if (isDestructive) {
          if (!safetyTerms.test(tool.description ?? '')) {
            violations.push(tool.name);
          }
        }
      }

      expect(
        violations,
        `Compact destructive tools missing safety markers: ${violations.join(', ')}`
      ).toEqual([]);
    });
  });
});
