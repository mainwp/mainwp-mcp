import type { ScenarioDefinition } from './types.js';

export const emptyObjectInput: ScenarioDefinition = {
  id: 'empty-object-input',
  purpose: 'Call a readonly object-schema ability without arguments.',
  kind: 'read',
  targets: ['fixture'],
  async run(ctx) {
    const { result, data } = await ctx.client.callToolJson('count_sites_v1');
    const directCount = await ctx.verifier.countSites();
    ctx.assert.equal('no-argument count succeeds', result.isError, undefined);
    ctx.assert.equal(
      'no-argument count matches the independent count',
      (data as { total?: number }).total,
      directCount
    );
  },
};

export const stringJobId: ScenarioDefinition = {
  id: 'string-job-id',
  purpose: 'Read batch job status using its declared string job_id.',
  kind: 'read',
  targets: ['fixture'],
  async run(ctx) {
    const { result, data } = await ctx.client.callToolJson('get_batch_job_status_v1', {
      job_id: 'sync_abc123',
    });
    ctx.assert.equal('string job_id call succeeds', result.isError, undefined);
    ctx.assert.deepEqual('batch job status matches the fixture', data, {
      job_id: 'sync_abc123',
      type: 'sync',
      status: 'completed',
      progress: 100,
      processed: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
    });
  },
};

export const idInputScenarios = [emptyObjectInput, stringJobId];
