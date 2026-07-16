import { parseToolJson } from '../lib/client.js';
import { findHelloDolly, type ScenarioDefinition } from './types.js';

async function waitForSyncAdvance(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  siteId: number,
  before: string | null | undefined
): Promise<string | null | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await ctx.verifier.getSite(siteId);
    if (current.last_sync && current.last_sync !== before) return current.last_sync;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return (await ctx.verifier.getSite(siteId)).last_sync;
}

async function setPluginActive(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  siteId: number,
  slug: string,
  active: boolean,
  requireConfirmation: boolean
): Promise<void> {
  const tool = active ? 'activate_site_plugins_v1' : 'deactivate_site_plugins_v1';
  const args = { site_id_or_domain: siteId, plugins: [slug] };
  if (!requireConfirmation) {
    const result = await ctx.client.callTool(tool, args);
    if (result.isError) throw new Error(`${tool} failed: ${JSON.stringify(parseToolJson(result))}`);
    // If the Dashboard still gates this tool, finish the flow instead of
    // leaving the toggle half-done (matters for cleanup reliability).
    const data = parseToolJson(result) as { status?: string; confirmation_token?: string } | null;
    if (data && data.status === 'CONFIRMATION_REQUIRED' && data.confirmation_token) {
      const confirmed = await ctx.client.callTool(tool, {
        ...args,
        user_confirmed: true,
        confirmation_token: data.confirmation_token,
      });
      if (confirmed.isError) {
        throw new Error(
          `${tool} confirmed call failed: ${JSON.stringify(parseToolJson(confirmed))}`
        );
      }
    }
    return;
  }
  const preview = await ctx.client.callTool(tool, { ...args, confirm: true });
  const previewData = parseToolJson(preview) as { confirmation_token?: string; status?: string };
  ctx.assert.equal(
    `${tool} preview requires confirmation`,
    previewData.status,
    'CONFIRMATION_REQUIRED'
  );
  ctx.assert.truthy(`${tool} preview issues token`, previewData.confirmation_token);
  if (!previewData.confirmation_token)
    throw new Error(`${tool} did not issue a confirmation token`);
  const confirmed = await ctx.client.callTool(tool, {
    ...args,
    user_confirmed: true,
    confirmation_token: previewData.confirmation_token,
  });
  if (confirmed.isError) {
    throw new Error(`${tool} confirmed call failed: ${JSON.stringify(parseToolJson(confirmed))}`);
  }
}

export const syncSite: ScenarioDefinition = {
  id: 'sync-site',
  purpose: 'Sync one discovered site and independently verify its last-sync timestamp advances.',
  kind: 'write',
  targets: ['live'],
  async run(ctx) {
    const sites = await ctx.verifier.listSites();
    if (sites.length === 0) throw new Error('No site was available to sync');
    const before = await ctx.verifier.getSite(sites[0].id);
    const result = await ctx.client.callTool('sync_sites_v1', {
      site_ids_or_domains: [sites[0].id],
    });
    ctx.assert.equal('sync_sites_v1 succeeds', result.isError, undefined);
    const after = await waitForSyncAdvance(ctx, sites[0].id, before.last_sync);
    ctx.assert.truthy('last_sync advanced', after && after !== before.last_sync);
  },
};

export const pluginToggleRoundtrip: ScenarioDefinition = {
  id: 'plugin-toggle-roundtrip',
  purpose: 'Deactivate and reactivate a safe plugin with independent state verification.',
  kind: 'write',
  targets: ['live'],
  preconditions: async ctx => {
    const plugin = await findHelloDolly(
      ctx.verifier,
      process.env.MAINWP_MCP_ACCEPTANCE_TOGGLE_PLUGIN
    );
    if (!plugin?.active) {
      return { status: 'skipped', reason: 'No active allowed toggle plugin was discovered.' };
    }
    return { state: { plugin } };
  },
  async run(ctx) {
    const plugin = ctx.state.plugin as Awaited<ReturnType<typeof findHelloDolly>>;
    if (!plugin) throw new Error('Plugin precondition did not provide a plugin');
    // Whether the toggle needs the two-step confirmation flow is the
    // Dashboard's call (destructive annotation + confirm parameter), so
    // derive it from the exposed tool instead of assuming either shape.
    const tools = await ctx.client.listTools();
    const needsConfirmation = (name: string): boolean => {
      const tool = tools.tools.find(candidate => candidate.name === name);
      return Boolean(
        tool?.annotations?.destructiveHint &&
        tool.inputSchema.properties &&
        'confirm' in tool.inputSchema.properties
      );
    };
    ctx.assert.truthy(
      'deactivate tool is exposed',
      tools.tools.some(tool => tool.name === 'deactivate_site_plugins_v1')
    );

    await setPluginActive(
      ctx,
      plugin.site.id,
      plugin.slug,
      false,
      needsConfirmation('deactivate_site_plugins_v1')
    );
    const inactive = await ctx.verifier.getSitePlugins(plugin.site.id);
    ctx.assert.equal(
      'plugin is independently inactive',
      inactive.plugins.find(candidate => candidate.slug === plugin.slug)?.active,
      false
    );
    await setPluginActive(
      ctx,
      plugin.site.id,
      plugin.slug,
      true,
      needsConfirmation('activate_site_plugins_v1')
    );
    const restored = await ctx.verifier.getSitePlugins(plugin.site.id);
    ctx.assert.equal(
      'plugin is independently active again',
      restored.plugins.find(candidate => candidate.slug === plugin.slug)?.active,
      true
    );
  },
  async cleanup(ctx) {
    const plugin = ctx.state.plugin as Awaited<ReturnType<typeof findHelloDolly>>;
    if (!plugin) return;
    const current = await ctx.verifier.getSitePlugins(plugin.site.id);
    if (current.plugins.find(candidate => candidate.slug === plugin.slug)?.active === false) {
      await setPluginActive(ctx, plugin.site.id, plugin.slug, true, false);
    }
  },
};

export const writeScenarios = [syncSite, pluginToggleRoundtrip];
