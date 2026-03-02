/**
 * Token Budget Evaluation
 *
 * Measures the token cost of the full tool catalog to ensure
 * it fits within LLM context window budgets:
 * - Standard mode < 30K tokens
 * - Compact mode < 20K tokens
 * - Compact saves >= 20% vs standard
 * - No single tool exceeds 600 tokens
 * - Outputs per-category breakdown via console.warn
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTools, clearToolsCache } from '../../src/tools.js';
import { clearCache, initRateLimiter } from '../../src/abilities.js';
import { type Config } from '../../src/config.js';
import { type Tool } from '@modelcontextprotocol/sdk/types.js';

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

/** Estimate token count from a JSON string (chars / 3.5, rounded up) */
function estimateTokens(jsonStr: string): number {
  return Math.ceil(jsonStr.length / 3.5);
}

/** Get category from tool name by looking up fixture */
function getToolCategory(toolName: string): string {
  const abilityName = `mainwp/${toolName.replace(/_/g, '-')}`;
  const ability = abilitiesFixture.find(a => a.name === abilityName);
  return ability?.category ?? 'unknown';
}

/** Build a per-category token breakdown */
function buildCategoryBreakdown(tools: Tool[]): Map<string, { count: number; tokens: number }> {
  const breakdown = new Map<string, { count: number; tokens: number }>();

  for (const tool of tools) {
    const category = getToolCategory(tool.name);
    const tokens = estimateTokens(JSON.stringify(tool));

    const existing = breakdown.get(category) ?? { count: 0, tokens: 0 };
    breakdown.set(category, {
      count: existing.count + 1,
      tokens: existing.tokens + tokens,
    });
  }

  return breakdown;
}

describe('Token Budget', () => {
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

  it('standard mode catalog should be under 30K tokens', async () => {
    mockAbilitiesFetch();
    const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

    const catalogJson = JSON.stringify(tools);
    const totalTokens = estimateTokens(catalogJson);

    // Log breakdown to stderr for visibility
    const breakdown = buildCategoryBreakdown(tools);
    console.warn('\n--- Standard Mode Token Breakdown ---');
    console.warn(`Total: ${totalTokens} tokens (${tools.length} tools)`);
    for (const [category, data] of [...breakdown.entries()].sort(
      (a, b) => b[1].tokens - a[1].tokens
    )) {
      console.warn(`  ${category}: ${data.tokens} tokens (${data.count} tools)`);
    }
    console.warn('---');

    expect(totalTokens).toBeLessThan(30_000);
  });

  it('compact mode catalog should be under 20K tokens', async () => {
    mockAbilitiesFetch();
    const tools = await getTools({ ...baseConfig, schemaVerbosity: 'compact' });

    const catalogJson = JSON.stringify(tools);
    const totalTokens = estimateTokens(catalogJson);

    // Log breakdown to stderr for visibility
    const breakdown = buildCategoryBreakdown(tools);
    console.warn('\n--- Compact Mode Token Breakdown ---');
    console.warn(`Total: ${totalTokens} tokens (${tools.length} tools)`);
    for (const [category, data] of [...breakdown.entries()].sort(
      (a, b) => b[1].tokens - a[1].tokens
    )) {
      console.warn(`  ${category}: ${data.tokens} tokens (${data.count} tools)`);
    }
    console.warn('---');

    expect(totalTokens).toBeLessThan(20_000);
  });

  it('compact mode should save >= 20% vs standard', async () => {
    mockAbilitiesFetch();
    const standardTools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });
    const standardTokens = estimateTokens(JSON.stringify(standardTools));

    clearCache();
    clearToolsCache();
    mockAbilitiesFetch();
    const compactTools = await getTools({ ...baseConfig, schemaVerbosity: 'compact' });
    const compactTokens = estimateTokens(JSON.stringify(compactTools));

    const savings = ((standardTokens - compactTokens) / standardTokens) * 100;

    console.warn(`\n--- Verbosity Comparison ---`);
    console.warn(`Standard: ${standardTokens} tokens`);
    console.warn(`Compact:  ${compactTokens} tokens`);
    console.warn(`Savings:  ${savings.toFixed(1)}%`);
    console.warn('---');

    expect(savings).toBeGreaterThanOrEqual(20);
  });

  it('no single tool should exceed 600 tokens', async () => {
    mockAbilitiesFetch();
    const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

    const violations: string[] = [];
    for (const tool of tools) {
      const tokens = estimateTokens(JSON.stringify(tool));
      if (tokens > 600) {
        violations.push(`${tool.name} (${tokens} tokens)`);
      }
    }

    expect(violations, `Tools exceeding 600 token limit: ${violations.join(', ')}`).toEqual([]);
  });
});
