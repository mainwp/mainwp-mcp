import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, initRateLimiter, type Ability } from './abilities.js';
import { clearPendingPreviews } from './confirmation.js';
import { clearToolsCache, executeTool } from './tools.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('schema-aware tool input limits', () => {
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

  it('uses the resolved ability schema for large string parameters', async () => {
    const preflightAbility: Ability = {
      name: 'mainwp/preflight-mu-release-v1',
      label: 'Preflight MU Release',
      description: 'Validate an MU release plan',
      category: 'mainwp-deployments',
      input_schema: {
        type: 'object',
        properties: {
          plan_json: { type: 'string', maxLength: 1_048_576 },
        },
        required: ['plan_json'],
      },
      meta: {
        annotations: {
          readonly: false,
          destructive: false,
          idempotent: true,
        },
      },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [preflightAbility],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ready: true }),
      headers: new Headers(),
    });

    const planJson = 'a'.repeat(22_246);
    const result = await executeTool(
      makeBaseConfig(),
      'preflight_mu_release_v1',
      { plan_json: planJson },
      makeMockLogger()
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ready: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ input: { plan_json: planJson } }),
    });
  });
});
