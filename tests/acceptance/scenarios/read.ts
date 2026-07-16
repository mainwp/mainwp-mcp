import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseToolJson } from '../lib/client.js';
import type { VerifiedPluginResponse, VerifiedSite } from '../lib/verify.js';
import { findSiteWithPlugins, mcpListAllSites, type ScenarioDefinition } from './types.js';

function sorted(values: string[]): string[] {
  return [...values].sort();
}

async function assertSessionRecovery(ctx: Parameters<ScenarioDefinition['run']>[0]): Promise<void> {
  const followUp = await ctx.client.callTool('count_sites_v1', {});
  ctx.assert.equal('same-session follow-up is not an error', followUp.isError, undefined);
  const data = parseToolJson(followUp) as { total?: number };
  ctx.assert.truthy('same-session follow-up returns a count', typeof data.total === 'number');
}

export const startupHandshake: ScenarioDefinition = {
  id: 'startup-handshake',
  purpose:
    'Prove MCP initialization succeeds with the published server identity and required capabilities.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    ctx.assert.equal('server name', ctx.client.serverInfo?.name, 'mainwp-mcp');
    ctx.assert.equal('server version', ctx.client.serverInfo?.version, ctx.config.packageVersion);
    ctx.assert.truthy('tools capability', ctx.client.capabilities?.tools);
    ctx.assert.truthy('resources capability', ctx.client.capabilities?.resources);
    ctx.assert.truthy('prompts capability', ctx.client.capabilities?.prompts);
  },
};

export const discoveryTools: ScenarioDefinition = {
  id: 'discovery-tools',
  purpose: 'Validate the exposed tool catalog, schemas, annotations, and collision-free names.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const { tools } = await ctx.client.listTools();
    const names = tools.map(tool => tool.name);
    const listSites = tools.find(tool => tool.name === 'list_sites_v1');
    ctx.assert.truthy('tool catalog is non-empty', tools.length > 0);
    ctx.assert.truthy('list_sites_v1 is exposed', listSites);
    ctx.assert.equal('list_sites_v1 schema is object-like', listSites?.inputSchema.type, 'object');
    ctx.assert.equal('list_sites_v1 readOnlyHint', listSites?.annotations?.readOnlyHint, true);
    ctx.assert.equal(
      'list_sites_v1 destructiveHint',
      listSites?.annotations?.destructiveHint,
      false
    );
    ctx.assert.equal('tool names are unique', new Set(names).size, names.length);
  },
};

export const discoveryResourcesPrompts: ScenarioDefinition = {
  id: 'discovery-resources-prompts',
  purpose: 'Prove resources, prompts, and the static help resource work through MCP.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const resources = await ctx.client.listResources();
    const prompts = await ctx.client.listPrompts();
    const help = await ctx.client.readResource('mainwp://help');
    ctx.assert.includes(
      'mainwp://help is listed',
      resources.resources.map(resource => resource.uri),
      'mainwp://help'
    );
    ctx.assert.truthy('prompt catalog is non-empty', prompts.prompts.length > 0);
    ctx.assert.truthy(
      'help resource has text',
      help.contents.some(content => 'text' in content && content.text.length > 0)
    );
  },
};

export const listSitesCrossCheck: ScenarioDefinition = {
  id: 'list-sites-cross-check',
  purpose: 'Cross-check MCP site discovery against independent Abilities API reads.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const [mcpSites, directSites] = await Promise.all([
      mcpListAllSites(ctx.client),
      ctx.verifier.listSites(),
    ]);
    ctx.assert.equal('same site count', mcpSites.length, directSites.length);
    ctx.assert.deepEqual(
      'same site URL set',
      sorted(mcpSites.map(site => site.url)),
      sorted(directSites.map(site => site.url))
    );
  },
};

export const countSitesConsistency: ScenarioDefinition = {
  id: 'count-sites-consistency',
  purpose: 'Verify the MCP count-sites result equals an independent direct count.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const { result, data } = await ctx.client.callToolJson('count_sites_v1');
    const directCount = await ctx.verifier.countSites();
    ctx.assert.equal('count_sites_v1 succeeds', result.isError, undefined);
    ctx.assert.equal(
      'MCP and independent counts match',
      (data as { total: number }).total,
      directCount
    );
  },
};

export const getSite: ScenarioDefinition = {
  id: 'get-site',
  purpose: 'Verify a discovered site detail response against an independent read.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const sites = await ctx.verifier.listSites();
    if (sites.length === 0) throw new Error('No sites were available');
    const direct = await ctx.verifier.getSite(sites[0].id);
    const { result, data } = await ctx.client.callToolJson('get_site_v1', {
      site_id_or_domain: sites[0].id,
    });
    const actual = data as VerifiedSite;
    ctx.assert.equal('get_site_v1 succeeds', result.isError, undefined);
    ctx.assert.equal('site id matches', actual.id, direct.id);
    ctx.assert.equal('site URL matches', actual.url, direct.url);
    ctx.assert.equal('site name matches', actual.name, direct.name);
  },
};

export const sitePlugins: ScenarioDefinition = {
  id: 'site-plugins',
  purpose: 'Verify a site plugin inventory and a known slug against an independent read.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const { site, plugins: direct } = await findSiteWithPlugins(ctx.verifier);
    const { result, data } = await ctx.client.callToolJson('get_site_plugins_v1', {
      site_id_or_domain: site.id,
    });
    const actual = data as VerifiedPluginResponse;
    ctx.assert.equal('get_site_plugins_v1 succeeds', result.isError, undefined);
    ctx.assert.deepEqual(
      'plugin inventory matches',
      sorted(actual.plugins.map(plugin => `${plugin.slug}:${plugin.active}`)),
      sorted(direct.plugins.map(plugin => `${plugin.slug}:${plugin.active}`))
    );
    const knownSlug = direct.plugins[0].slug;
    ctx.assert.includes(
      'known plugin slug is present',
      actual.plugins.map(plugin => plugin.slug),
      knownSlug
    );
    if (ctx.config.target === 'fixture') {
      ctx.assert.includes(
        'fixture includes Hello Dolly',
        actual.plugins.map(plugin => plugin.slug),
        'hello.php'
      );
    }
  },
};

export const notFoundInput: ScenarioDefinition = {
  id: 'not-found-input',
  purpose: 'Require a structured not-found error and prove the same MCP session recovers.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const result = await ctx.client.callTool('get_site_v1', { site_id_or_domain: 99999999 });
    ctx.assert.equal('not-found returns isError', result.isError, true);
    const data = parseToolJson(result);
    ctx.assert.truthy('not-found response is structured JSON', data && typeof data === 'object');
    await assertSessionRecovery(ctx);
  },
};

export const invalidArgs: ScenarioDefinition = {
  id: 'invalid-args',
  purpose: 'Reject wrong-typed arguments without terminating the MCP session.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    let result: CallToolResult | undefined;
    let protocolError: unknown;
    try {
      result = await ctx.client.callTool('count_sites_v1', { tag_ids: 'not-an-array' });
    } catch (error) {
      protocolError = error;
    }
    ctx.assert.truthy(
      'invalid input is rejected',
      protocolError !== undefined || result?.isError === true
    );
    await assertSessionRecovery(ctx);
  },
};

export const unknownTool: ScenarioDefinition = {
  id: 'unknown-tool',
  purpose: 'Return the tool-not-found MCP code and keep the session usable.',
  kind: 'read',
  targets: ['live', 'fixture'],
  async run(ctx) {
    const result = await ctx.client.callTool('no_such_tool_v1', {});
    const data = parseToolJson(result) as { error?: { code?: number; message?: string } };
    ctx.assert.equal('unknown tool returns isError', result.isError, true);
    ctx.assert.equal('unknown tool code', data.error?.code, -32003);
    ctx.assert.truthy('unknown tool message', data.error?.message?.includes('Tool not found'));
    await assertSessionRecovery(ctx);
  },
};

export const readScenarios = [
  startupHandshake,
  discoveryTools,
  discoveryResourcesPrompts,
  listSitesCrossCheck,
  countSitesConsistency,
  getSite,
  sitePlugins,
  notFoundInput,
  invalidArgs,
  unknownTool,
];
