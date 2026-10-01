import { parseToolJson } from '../lib/client.js';
import { FIXTURE_PREVIEW_TOKEN_TOOL, FIXTURE_REQUIRED_CONFIRM_TOOL } from '../fixture-dashboard.js';
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

    const tokenless = await ctx.client.callTool('delete_site_v1', {
      ...args,
      confirm: true,
      user_confirmed: true,
    });
    const tokenlessData = parseToolJson(tokenless) as { error?: string };
    ctx.assert.equal('tokenless confirm is rejected', tokenless.isError, true);
    ctx.assert.equal(
      'tokenless confirm requires the token',
      tokenlessData.error,
      'PREVIEW_REQUIRED'
    );
    const afterTokenless = await ctx.verifier.listSites();
    ctx.assert.deepEqual(
      'tokenless confirm does not change fixture sites',
      afterTokenless.map(site => `${site.id}:${site.url}`).sort(),
      before.map(site => `${site.id}:${site.url}`).sort()
    );

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

export const fixtureRequiredBooleanConfirmation: ScenarioDefinition = {
  id: 'fixture-required-boolean-confirmation',
  purpose: 'Preview and confirm an ability that requires explicit confirm and dry_run booleans.',
  kind: 'write',
  targets: ['fixture'],
  /**
   * The fixture ability rejects a call that omits confirm or dry_run, so the
   * preview and the confirmed call only succeed when the server sends both.
   */
  async run(ctx) {
    const before = await ctx.verifier.listSites();
    if (before.length === 0)
      throw new Error('No fixture site was available for a note replacement');
    const target = before[0];
    const args = {
      site_id_or_domain: target.id,
      note: `${String(target.notes)} Required boolean confirmation completed.`,
    };

    const preview = await ctx.client.callTool(FIXTURE_REQUIRED_CONFIRM_TOOL, {
      ...args,
      confirm: true,
    });
    const previewData = parseToolJson(preview) as {
      status?: string;
      confirmation_token?: string;
      preview?: { dry_run?: boolean; updated?: boolean };
    };
    ctx.assert.equal('required boolean preview succeeds', preview.isError, undefined);
    ctx.assert.equal('preview requires confirmation', previewData.status, 'CONFIRMATION_REQUIRED');
    ctx.assert.truthy('preview issues a confirmation token', previewData.confirmation_token);
    ctx.assert.equal('upstream returns a dry-run preview', previewData.preview?.dry_run, true);
    ctx.assert.equal('upstream preview reports no update', previewData.preview?.updated, false);
    ctx.assert.deepEqual(
      'required boolean preview leaves fixture state unchanged',
      await ctx.verifier.listSites(),
      before
    );
    if (!previewData.confirmation_token) {
      throw new Error('Required boolean preview did not issue a confirmation token');
    }

    const confirmed = await ctx.client.callTool(FIXTURE_REQUIRED_CONFIRM_TOOL, {
      ...args,
      user_confirmed: true,
      confirmation_token: previewData.confirmation_token,
    });
    const confirmedData = parseToolJson(confirmed) as { dry_run?: boolean; updated?: boolean };
    ctx.assert.equal('required boolean execution succeeds', confirmed.isError, undefined);
    ctx.assert.equal('confirmed execution reports an update', confirmedData.updated, true);
    ctx.assert.equal('confirmed execution reports dry_run false', confirmedData.dry_run, false);
    const after = await ctx.verifier.listSites();
    ctx.assert.equal('confirmed execution preserves the site count', after.length, before.length);
    ctx.assert.equal(
      'confirmed execution changes the previewed site note',
      after.find(site => site.id === target.id)?.notes,
      args.note
    );
    ctx.assert.deepEqual(
      'confirmed execution preserves other sites',
      after.filter(site => site.id !== target.id),
      before.filter(site => site.id !== target.id)
    );
  },
};

export const fixturePreviewTokenConfirmation: ScenarioDefinition = {
  id: 'fixture-preview-token-confirmation',
  purpose: 'Confirm a site note clear using its preview token, then reject a wrong token.',
  kind: 'write',
  targets: ['fixture'],
  async run(ctx) {
    const before = await ctx.verifier.listSites();
    const target = before.find(site => typeof site.notes === 'string' && site.notes.length > 0);
    if (!target) throw new Error('No fixture site with a note was available for clearing');
    const args = {
      site_id_or_domain: target.id,
      request_id: 'fixture-preview-token-confirmation',
      confirm: true,
      preview_token: null,
    };

    const preview = await ctx.client.callTool(FIXTURE_PREVIEW_TOKEN_TOOL, args);
    const previewData = parseToolJson(preview) as {
      status?: string;
      confirmation_token?: string;
      preview?: {
        dry_run?: boolean;
        updated?: boolean;
        would_affect?: { site_id?: number; notes?: string };
        preview_token?: string;
      };
    };
    ctx.assert.equal('preview token preview succeeds', preview.isError, undefined);
    ctx.assert.equal('preview requires confirmation', previewData.status, 'CONFIRMATION_REQUIRED');
    ctx.assert.truthy('preview issues a confirmation token', previewData.confirmation_token);
    ctx.assert.equal('upstream returns a dry-run preview', previewData.preview?.dry_run, true);
    ctx.assert.equal('upstream preview reports no update', previewData.preview?.updated, false);
    ctx.assert.deepEqual(
      'upstream preview identifies the note clear',
      previewData.preview?.would_affect,
      {
        site_id: target.id,
        notes: '',
      }
    );
    ctx.assert.truthy(
      'upstream preview issues a 43-character base64url token',
      typeof previewData.preview?.preview_token === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(previewData.preview.preview_token)
    );
    ctx.assert.deepEqual(
      'preview leaves fixture state unchanged',
      await ctx.verifier.listSites(),
      before
    );
    if (!previewData.confirmation_token) {
      throw new Error('Preview token preview did not issue a confirmation token');
    }

    // The Dashboard rejects null here, so success proves the server supplied its token.
    const confirmed = await ctx.client.callTool(FIXTURE_PREVIEW_TOKEN_TOOL, {
      ...args,
      user_confirmed: true,
      confirmation_token: previewData.confirmation_token,
    });
    const confirmedData = parseToolJson(confirmed) as { dry_run?: boolean; updated?: boolean };
    ctx.assert.equal('preview token execution succeeds', confirmed.isError, undefined);
    ctx.assert.equal('confirmed execution reports an update', confirmedData.updated, true);
    ctx.assert.equal('confirmed execution reports dry_run false', confirmedData.dry_run, false);
    const after = await ctx.verifier.listSites();
    ctx.assert.equal('confirmed execution preserves the site count', after.length, before.length);
    ctx.assert.equal(
      'confirmed execution clears the previewed note',
      after.find(site => site.id === target.id)?.notes,
      ''
    );
    ctx.assert.deepEqual(
      'confirmed execution preserves other sites',
      after.filter(site => site.id !== target.id),
      before.filter(site => site.id !== target.id)
    );

    const nextPreview = await ctx.client.callTool(FIXTURE_PREVIEW_TOKEN_TOOL, args);
    const nextPreviewData = parseToolJson(nextPreview) as typeof previewData;
    ctx.assert.equal('second preview succeeds', nextPreview.isError, undefined);
    ctx.assert.equal(
      'second preview requires confirmation',
      nextPreviewData.status,
      'CONFIRMATION_REQUIRED'
    );
    ctx.assert.truthy(
      'second preview issues a confirmation token',
      nextPreviewData.confirmation_token
    );
    ctx.assert.deepEqual(
      'second preview leaves fixture state unchanged',
      await ctx.verifier.listSites(),
      after
    );
    if (!nextPreviewData.confirmation_token) {
      throw new Error('Second preview did not issue a confirmation token');
    }
    const rejected = await ctx.client.callTool(FIXTURE_PREVIEW_TOKEN_TOOL, {
      ...args,
      preview_token: 'A'.repeat(43),
      user_confirmed: true,
      confirmation_token: nextPreviewData.confirmation_token,
    });
    const rejectedData = parseToolJson(rejected) as { error?: { message?: string } };
    ctx.assert.equal('wrong preview token is rejected', rejected.isError, true);
    ctx.assert.truthy(
      'wrong token reaches the fixture rejection',
      rejectedData.error?.message?.includes('fixture_preview_token_invalid')
    );
    ctx.assert.deepEqual(
      'wrong token leaves fixture state unchanged',
      await ctx.verifier.listSites(),
      after
    );
  },
};

export const confirmationScenarios = [
  fixtureConfirmationFlow,
  fixtureRequiredBooleanConfirmation,
  fixturePreviewTokenConfirmation,
];
