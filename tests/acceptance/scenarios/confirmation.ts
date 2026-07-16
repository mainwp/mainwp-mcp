import { parseToolJson } from '../lib/client.js';
import type { ScenarioDefinition } from './types.js';

export const fixtureConfirmationFlow: ScenarioDefinition = {
  id: 'fixture-confirmation-flow',
  purpose:
    'Exercise destructive preview, token-bound confirmation, execution, and replay rejection against fixture state.',
  kind: 'write',
  targets: ['fixture'],
  async run(ctx) {
    const tools = await ctx.client.listTools();
    const deleteSite = tools.tools.find(tool => tool.name === 'delete_site_v1');
    ctx.assert.equal(
      'fixture confirmation tool is destructive',
      deleteSite?.annotations?.destructiveHint,
      true
    );
    ctx.assert.truthy(
      'fixture confirmation tool declares dry_run',
      deleteSite?.inputSchema.properties && 'dry_run' in deleteSite.inputSchema.properties
    );

    const before = await ctx.verifier.listSites();
    if (before.length === 0) throw new Error('No fixture site was available for deletion');
    const target = before[0];
    const args = { site_id_or_domain: target.id };

    const preview = await ctx.client.callTool('delete_site_v1', { ...args, confirm: true });
    const previewData = parseToolJson(preview) as {
      status?: string;
      confirmation_token?: string;
      preview?: unknown;
    };
    ctx.assert.equal('preview is a successful workflow step', preview.isError, undefined);
    ctx.assert.equal('preview requires confirmation', previewData.status, 'CONFIRMATION_REQUIRED');
    ctx.assert.truthy('preview issues a confirmation token', previewData.confirmation_token);
    ctx.assert.truthy('preview payload is present', previewData.preview);
    const afterPreview = await ctx.verifier.listSites();
    ctx.assert.deepEqual(
      'preview does not change fixture sites',
      afterPreview.map(site => `${site.id}:${site.url}`).sort(),
      before.map(site => `${site.id}:${site.url}`).sort()
    );
    if (!previewData.confirmation_token) {
      throw new Error('delete_site_v1 preview did not issue a confirmation token');
    }

    const forged = await ctx.client.callTool('delete_site_v1', {
      ...args,
      user_confirmed: true,
      confirmation_token: `forged-${previewData.confirmation_token}`,
    });
    const forgedData = parseToolJson(forged) as { error?: string };
    ctx.assert.equal('forged token is rejected', forged.isError, true);
    ctx.assert.equal('forged token requires a new preview', forgedData.error, 'PREVIEW_REQUIRED');
    const afterForged = await ctx.verifier.listSites();
    ctx.assert.deepEqual(
      'forged token does not change fixture sites',
      afterForged.map(site => `${site.id}:${site.url}`).sort(),
      before.map(site => `${site.id}:${site.url}`).sort()
    );

    const confirmed = await ctx.client.callTool('delete_site_v1', {
      ...args,
      user_confirmed: true,
      confirmation_token: previewData.confirmation_token,
    });
    const confirmedData = parseToolJson(confirmed) as { deleted?: boolean };
    ctx.assert.equal('confirmed execution succeeds', confirmed.isError, undefined);
    ctx.assert.equal('confirmed execution reports deletion', confirmedData.deleted, true);
    const afterConfirmed = await ctx.verifier.listSites();
    ctx.assert.equal(
      'confirmed execution removes one site',
      afterConfirmed.length,
      before.length - 1
    );
    ctx.assert.equal(
      'confirmed execution removes the previewed site',
      afterConfirmed.some(site => site.id === target.id),
      false
    );

    const replay = await ctx.client.callTool('delete_site_v1', {
      ...args,
      user_confirmed: true,
      confirmation_token: previewData.confirmation_token,
    });
    const replayData = parseToolJson(replay) as { error?: string };
    ctx.assert.equal('consumed token replay is rejected', replay.isError, true);
    ctx.assert.equal('token replay requires a new preview', replayData.error, 'PREVIEW_REQUIRED');
    const afterReplay = await ctx.verifier.listSites();
    ctx.assert.deepEqual(
      'token replay does not change fixture sites',
      afterReplay.map(site => `${site.id}:${site.url}`).sort(),
      afterConfirmed.map(site => `${site.id}:${site.url}`).sort()
    );
  },
};

export const confirmationScenarios = [fixtureConfirmationFlow];
