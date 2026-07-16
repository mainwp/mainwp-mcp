import { parseToolJson } from '../lib/client.js';
import { type ScenarioDefinition } from './types.js';

export const blockedToolPolicy: ScenarioDefinition = {
  id: 'blocked-tool-policy',
  purpose: 'Enforce blocked-tools policy at discovery and execution boundaries.',
  kind: 'read',
  targets: ['live', 'fixture'],
  preconditions: () => ({ launch: { env: { MAINWP_BLOCKED_TOOLS: 'delete_site_v1' } } }),
  async run(ctx) {
    const tools = await ctx.client.listTools();
    ctx.assert.equal(
      'blocked tool is absent from discovery',
      tools.tools.some(tool => tool.name === 'delete_site_v1'),
      false
    );
    const result = await ctx.client.callTool('delete_site_v1', { site_id_or_domain: 1 });
    const data = parseToolJson(result) as { error?: { code?: number; message?: string } };
    ctx.assert.equal('blocked call returns isError', result.isError, true);
    ctx.assert.equal('blocked call uses permission code', data.error?.code, -32008);
    ctx.assert.truthy(
      'blocked call reports policy only',
      data.error?.message?.includes('not allowed')
    );
    ctx.assert.equal(
      'blocked response does not expose ability name',
      JSON.stringify(data).includes('mainwp/delete-site-v1'),
      false
    );
  },
};

export const allowedToolsPolicy: ScenarioDefinition = {
  id: 'allowed-tools-policy',
  purpose: 'Expose exactly the configured allowed tool set.',
  kind: 'read',
  targets: ['live', 'fixture'],
  preconditions: () => ({
    launch: { env: { MAINWP_ALLOWED_TOOLS: 'list_sites_v1,count_sites_v1' } },
  }),
  async run(ctx) {
    const tools = await ctx.client.listTools();
    ctx.assert.deepEqual('allowed tool set is exact', tools.tools.map(tool => tool.name).sort(), [
      'count_sites_v1',
      'list_sites_v1',
    ]);
  },
};

export const safeModeBlocksDestructive: ScenarioDefinition = {
  id: 'safe-mode-blocks-destructive',
  purpose: 'Prove safe mode blocks a destructive operation without changing state.',
  kind: 'read',
  targets: ['live', 'fixture'],
  // Read-safe despite targeting delete_site_v1: safe mode must block it, and
  // even if safe mode were broken, the bogus confirmation token cannot pass
  // the confirmation gate — two independent layers prevent execution.
  preconditions: () => ({ launch: { env: { MAINWP_SAFE_MODE: 'true' } } }),
  async run(ctx) {
    const before = await ctx.verifier.listSites();
    if (before.length === 0) throw new Error('No site was available for the safe-mode probe');
    const tools = await ctx.client.listTools();
    const tool = tools.tools.find(candidate => candidate.name === 'delete_site_v1');
    ctx.assert.equal(
      'delete_site_v1 is marked destructive',
      tool?.annotations?.destructiveHint,
      true
    );
    const result = await ctx.client.callTool('delete_site_v1', {
      site_id_or_domain: before[0].id,
      confirm: true,
      user_confirmed: true,
      confirmation_token: 'acceptance-safe-mode-token',
    });
    ctx.assert.equal('safe mode returns isError', result.isError, true);
    ctx.assert.truthy(
      'safe mode response is explicit',
      JSON.stringify(parseToolJson(result)).includes('SAFE_MODE_BLOCKED')
    );
    const after = await ctx.verifier.listSites();
    ctx.assert.deepEqual(
      'sites are unchanged',
      after.map(site => `${site.id}:${site.url}`).sort(),
      before.map(site => `${site.id}:${site.url}`).sort()
    );
  },
};

export const confirmationGateNoToken: ScenarioDefinition = {
  id: 'confirmation-gate-no-token',
  purpose: 'Require preview and a token for destructive execution while leaving state unchanged.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const before = await ctx.verifier.listSites();
    if (before.length === 0) throw new Error('No site was available for confirmation preview');
    const result = await ctx.client.callTool('delete_site_v1', {
      site_id_or_domain: before[0].id,
      confirm: true,
    });
    const data = parseToolJson(result) as {
      status?: string;
      next_action?: string;
      confirmation_token?: string;
      preview?: unknown;
    };
    ctx.assert.equal('preview step is not an error', result.isError, undefined);
    ctx.assert.equal('confirmation is required', data.status, 'CONFIRMATION_REQUIRED');
    ctx.assert.equal('preview then confirm action', data.next_action, 'show_preview_and_confirm');
    ctx.assert.truthy('confirmation token is issued', data.confirmation_token);
    ctx.assert.truthy('preview payload is present', data.preview);
    const after = await ctx.verifier.listSites();
    ctx.assert.deepEqual(
      'preview did not change sites',
      after.map(site => `${site.id}:${site.url}`).sort(),
      before.map(site => `${site.id}:${site.url}`).sort()
    );
  },
};

export const policyScenarios = [
  blockedToolPolicy,
  allowedToolsPolicy,
  safeModeBlocksDestructive,
  confirmationGateNoToken,
];
