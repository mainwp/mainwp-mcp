import { parseToolJson } from '../lib/client.js';
import { FIXTURE_DELAY_SEARCH, FIXTURE_OVERSIZED_SEARCH } from '../fixture-dashboard.js';
import type { ScenarioDefinition } from './types.js';

interface StructuredError {
  error?: { code?: number; message?: string };
}

async function assertSessionRecovery(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  expectedCount: number
): Promise<void> {
  const { result, data } = await ctx.client.callToolJson('count_sites_v1');
  ctx.assert.equal('same-session recovery call succeeds', result.isError, undefined);
  ctx.assert.equal(
    'same-session recovery count matches the fixture',
    (data as { total?: number }).total,
    expectedCount
  );
}

export const oversizedResponseRecovery: ScenarioDefinition = {
  id: 'oversized-response-recovery',
  purpose: 'Reject an oversized fixture response and keep the same MCP session usable.',
  kind: 'read',
  targets: ['fixture'],
  preconditions: () => ({
    launch: {
      env: {
        MAINWP_MAX_RESPONSE_SIZE: '200000',
        MAINWP_RETRY_ENABLED: 'false',
      },
    },
  }),
  async run(ctx) {
    const expectedCount = await ctx.verifier.countSites();
    const result = await ctx.client.callTool('list_sites_v1', {
      search: FIXTURE_OVERSIZED_SEARCH,
    });
    const data = parseToolJson(result) as StructuredError;
    ctx.assert.equal('oversized response returns isError', result.isError, true);
    ctx.assert.equal(
      'oversized response has a structured numeric code',
      typeof data.error?.code,
      'number'
    );
    ctx.assert.truthy(
      'oversized response reports the configured transport limit',
      /response (?:body|size).*exceeds|maximum allowed|bytes limit/i.test(data.error?.message ?? '')
    );
    await assertSessionRecovery(ctx, expectedCount);
  },
};

export const requestTimeoutRecovery: ScenarioDefinition = {
  id: 'request-timeout-recovery',
  purpose:
    'Return a structured timeout for a delayed fixture response and keep the session usable.',
  kind: 'read',
  targets: ['fixture'],
  preconditions: () => ({
    launch: {
      env: {
        MAINWP_REQUEST_TIMEOUT: '250',
        MAINWP_RETRY_ENABLED: 'false',
      },
    },
  }),
  async run(ctx) {
    const expectedCount = await ctx.verifier.countSites();
    const result = await ctx.client.callTool('list_sites_v1', {
      search: FIXTURE_DELAY_SEARCH,
    });
    const data = parseToolJson(result) as StructuredError;
    ctx.assert.equal('delayed response returns isError', result.isError, true);
    ctx.assert.equal('delayed response uses the timeout code', data.error?.code, -32001);
    ctx.assert.truthy(
      'delayed response reports a timeout',
      data.error?.message?.toLowerCase().includes('timeout')
    );
    await assertSessionRecovery(ctx, expectedCount);
  },
};

export const transportScenarios = [oversizedResponseRecovery, requestTimeoutRecovery];
