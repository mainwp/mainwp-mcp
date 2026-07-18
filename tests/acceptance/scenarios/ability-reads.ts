import type { AcceptanceClient } from '../lib/client.js';
import { BoundedPagination } from '../lib/pagination.js';
import type { IndependentVerifier, VerifiedSite } from '../lib/verify.js';
import type {
  ScenarioDefinition,
  ScenarioPreconditionContext,
  ScenarioPreconditionResult,
} from './types.js';

interface CheckSiteResponse {
  site_id: number;
  checked: boolean;
  site?: { id?: number; url?: string };
  status?: { online?: boolean; http_code?: number };
}

interface Theme {
  slug: string;
  version: string;
  active: boolean;
  update_version?: string | null;
}

interface ThemeResponse {
  site_id: number;
  site_url: string;
  active_theme: string;
  themes: Theme[];
  total: number;
}

interface Update {
  site_id: number;
  site_url: string;
  site_name: string;
  type: string;
  slug: string;
  name: string;
  current_version: string;
  new_version: string;
}

interface Client {
  id: number;
  name?: string;
}

interface Tag {
  id: number;
  name: string;
  sites_count: number;
  sites_ids?: number[];
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

interface UpdatesResponse {
  updates: Update[];
  total: number;
  errors?: unknown[];
}

interface UpdatesSnapshot {
  updates: Update[];
  errors: unknown[];
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function themeSignature(theme: Theme): string {
  return [theme.slug, theme.version, theme.active, theme.update_version ?? ''].join(':');
}

function updateSignature(update: Update): string {
  return [
    update.site_id,
    update.site_url,
    update.site_name,
    update.type,
    update.slug,
    update.name,
    update.current_version,
    update.new_version,
  ].join(':');
}

function tagSignature(tag: Tag): string {
  return [
    tag.id,
    tag.name,
    tag.sites_count,
    sorted((tag.sites_ids ?? []).map(String)).join(','),
  ].join(':');
}

async function connectedSitePrecondition(
  ctx: ScenarioPreconditionContext
): Promise<ScenarioPreconditionResult> {
  const site = (await ctx.verifier.listSites()).find(candidate => candidate.status === 'connected');
  if (!site) {
    return { status: 'skipped', reason: 'No connected site was available for the scenario.' };
  }
  return { state: { site } };
}

function selectedSite(state: Record<string, unknown>): VerifiedSite {
  const site = state.site as VerifiedSite | undefined;
  if (!site) throw new Error('Connected-site precondition did not provide a site');
  return site;
}

export async function verifierListAll<T>(
  verifier: IndependentVerifier,
  abilityName: string
): Promise<T[]> {
  const items: T[] = [];
  const pagination = new BoundedPagination(`Independent verifier ${abilityName}`);
  for (let page = 1; ; page += 1) {
    const response = (await verifier.execute(abilityName, {
      page,
      per_page: 100,
    })) as PaginatedResponse<T>;
    items.push(...response.items);
    const hasMore = items.length < response.total && response.items.length > 0;
    pagination.record(page, response.items, hasMore);
    if (!hasMore) return items;
  }
}

async function mcpListAll<T>(
  client: AcceptanceClient,
  toolName: string
): Promise<{ items: T[]; isError: boolean }> {
  const items: T[] = [];
  const pagination = new BoundedPagination(`MCP ${toolName}`);
  for (let page = 1; ; page += 1) {
    const { result, data } = await client.callToolJson(toolName, { page, per_page: 100 });
    if (result.isError) return { items, isError: true };
    const response = data as PaginatedResponse<T>;
    items.push(...response.items);
    const hasMore = items.length < response.total && response.items.length > 0;
    pagination.record(page, response.items, hasMore);
    if (!hasMore) {
      return { items, isError: false };
    }
  }
}

async function verifierListUpdates(
  verifier: IndependentVerifier,
  siteId: number
): Promise<UpdatesSnapshot> {
  const updates: Update[] = [];
  const errors: unknown[] = [];
  const pagination = new BoundedPagination('Independent verifier list-updates-v1');
  for (let page = 1; ; page += 1) {
    const response = (await verifier.execute('mainwp/list-updates-v1', {
      site_ids_or_domains: [siteId],
      page,
      per_page: 200,
    })) as UpdatesResponse;
    updates.push(...response.updates);
    errors.push(...(response.errors ?? []));
    const hasMore = updates.length < response.total && response.updates.length > 0;
    pagination.record(page, response.updates, hasMore);
    if (!hasMore) {
      return { updates, errors };
    }
  }
}

async function mcpListUpdates(
  client: AcceptanceClient,
  siteId: number
): Promise<UpdatesSnapshot & { isError: boolean }> {
  const updates: Update[] = [];
  const errors: unknown[] = [];
  const pagination = new BoundedPagination('MCP list_updates_v1');
  for (let page = 1; ; page += 1) {
    const { result, data } = await client.callToolJson('list_updates_v1', {
      site_ids_or_domains: [siteId],
      page,
      per_page: 200,
    });
    if (result.isError) return { updates, errors, isError: true };
    const response = data as UpdatesResponse;
    updates.push(...response.updates);
    errors.push(...(response.errors ?? []));
    const hasMore = updates.length < response.total && response.updates.length > 0;
    pagination.record(page, response.updates, hasMore);
    if (!hasMore) {
      return { updates, errors, isError: false };
    }
  }
}

export const checkSite: ScenarioDefinition = {
  id: 'check-site',
  purpose:
    'Verify check-site status against an independent direct execution and enforce a 20-second latency ceiling.',
  kind: 'read',
  targets: ['live', 'fixture'],
  preconditions: connectedSitePrecondition,
  async run(ctx) {
    const site = selectedSite(ctx.state);
    const direct = (await ctx.verifier.execute('mainwp/check-site-v1', {
      site_id_or_domain: site.id,
    })) as CheckSiteResponse;

    const startedAt = performance.now();
    const { result, data } = await ctx.client.callToolJson('check_site_v1', {
      site_id_or_domain: site.id,
    });
    const durationMs = performance.now() - startedAt;
    const actual = data as CheckSiteResponse;

    ctx.assert.equal('check_site_v1 succeeds', result.isError, undefined);
    ctx.assert.lessThan('check_site_v1 completes in under 20 seconds', durationMs, 20_000);
    ctx.assert.equal('independent check completed', direct.checked, true);
    ctx.assert.equal('independent check targeted the connected site', direct.site_id, site.id);
    ctx.assert.equal('checked site id matches the direct result', actual.site_id, direct.site_id);
    ctx.assert.equal('checked result matches the direct result', actual.checked, direct.checked);
    ctx.assert.equal('site URL matches the direct result', actual.site?.url, direct.site?.url);
    ctx.assert.equal(
      'HTTP status matches the direct result',
      actual.status?.http_code,
      direct.status?.http_code
    );
    ctx.assert.equal(
      'online status matches the direct result',
      actual.status?.online,
      direct.status?.online
    );
  },
};

export const siteThemes: ScenarioDefinition = {
  id: 'site-themes',
  purpose: 'Cross-check a site theme inventory against an independent direct ability read.',
  kind: 'read',
  targets: ['live'],
  preconditions: connectedSitePrecondition,
  async run(ctx) {
    const site = selectedSite(ctx.state);
    const direct = (await ctx.verifier.execute('mainwp/get-site-themes-v1', {
      site_id_or_domain: site.id,
    })) as ThemeResponse;
    const { result, data } = await ctx.client.callToolJson('get_site_themes_v1', {
      site_id_or_domain: site.id,
    });
    const actual = data as ThemeResponse;

    ctx.assert.equal('get_site_themes_v1 succeeds', result.isError, undefined);
    ctx.assert.equal('theme site id matches', actual.site_id, direct.site_id);
    ctx.assert.equal('theme site URL matches', actual.site_url, direct.site_url);
    ctx.assert.equal('active theme matches', actual.active_theme, direct.active_theme);
    ctx.assert.equal('theme total matches', actual.total, direct.total);
    ctx.assert.deepEqual(
      'theme inventory matches',
      sorted(actual.themes.map(themeSignature)),
      sorted(direct.themes.map(themeSignature))
    );
  },
};

export const listUpdatesCrossCheck: ScenarioDefinition = {
  id: 'list-updates-cross-check',
  purpose:
    'Cross-check available updates against independent direct reads that bracket the MCP snapshot.',
  kind: 'read',
  targets: ['live'],
  preconditions: connectedSitePrecondition,
  async run(ctx) {
    const site = selectedSite(ctx.state);
    const before = await verifierListUpdates(ctx.verifier, site.id);
    const mcp = await mcpListUpdates(ctx.client, site.id);
    const after = await verifierListUpdates(ctx.verifier, site.id);
    const beforeSignatures = sorted(before.updates.map(updateSignature));
    const actualSignatures = sorted(mcp.updates.map(updateSignature));
    const afterSignatures = sorted(after.updates.map(updateSignature));
    const directUnion = new Set([...beforeSignatures, ...afterSignatures]);
    const directIntersection = beforeSignatures.filter(signature =>
      afterSignatures.includes(signature)
    );
    const actualSet = new Set(actualSignatures);
    const oracleUnchanged = JSON.stringify(beforeSignatures) === JSON.stringify(afterSignatures);

    ctx.assert.equal('list_updates_v1 succeeds for every page', mcp.isError, false);
    ctx.assert.equal(
      'bracketing direct update reads have no site errors',
      before.errors.length + after.errors.length,
      0
    );
    ctx.assert.equal('MCP update read has no site errors', mcp.errors.length, 0);
    ctx.assert.equal(
      'MCP updates are covered by the bracketing direct reads',
      actualSignatures.every(signature => directUnion.has(signature)),
      true
    );
    ctx.assert.equal(
      'updates stable across direct reads are present through MCP',
      directIntersection.every(signature => actualSet.has(signature)),
      true
    );
    ctx.assert.equal(
      'MCP updates match an unchanged direct snapshot',
      oracleUnchanged ? JSON.stringify(actualSignatures) : 'changed',
      oracleUnchanged ? JSON.stringify(beforeSignatures) : 'changed'
    );
  },
};

export const clientsCountConsistency: ScenarioDefinition = {
  id: 'clients-count-consistency',
  purpose:
    'Verify MCP client listing and count agreement against independent list-clients and count-clients reads.',
  kind: 'read',
  targets: ['live'],
  async run(ctx) {
    const directClients = await verifierListAll<Client>(ctx.verifier, 'mainwp/list-clients-v1');
    const directCount = (await ctx.verifier.execute('mainwp/count-clients-v1')) as {
      total: number;
    };
    const mcpClients = await mcpListAll<Client>(ctx.client, 'list_clients_v1');
    const { result, data } = await ctx.client.callToolJson('count_clients_v1');
    const mcpCount = data as { total: number };

    ctx.assert.equal(
      'independent client list length agrees with independent count',
      directClients.length,
      directCount.total
    );
    ctx.assert.equal('list_clients_v1 succeeds for every page', mcpClients.isError, false);
    ctx.assert.equal('count_clients_v1 succeeds', result.isError, undefined);
    ctx.assert.equal(
      'MCP client list length agrees with count',
      mcpClients.items.length,
      mcpCount.total
    );
    ctx.assert.equal('MCP client count matches direct count', mcpCount.total, directCount.total);
    ctx.assert.deepEqual(
      'client id set matches the direct list',
      mcpClients.items.map(client => client.id).sort((a, b) => a - b),
      directClients.map(client => client.id).sort((a, b) => a - b)
    );
  },
};

export const listTagsCrossCheck: ScenarioDefinition = {
  id: 'list-tags-cross-check',
  purpose: 'Cross-check the complete MCP tag list against an independent direct list-tags read.',
  kind: 'read',
  targets: ['live'],
  async run(ctx) {
    const directTags = await verifierListAll<Tag>(ctx.verifier, 'mainwp/list-tags-v1');
    const mcpTags = await mcpListAll<Tag>(ctx.client, 'list_tags_v1');

    ctx.assert.equal('list_tags_v1 succeeds for every page', mcpTags.isError, false);
    ctx.assert.equal('tag count matches the direct list', mcpTags.items.length, directTags.length);
    ctx.assert.deepEqual(
      'tag inventory matches the direct list',
      sorted(mcpTags.items.map(tagSignature)),
      sorted(directTags.map(tagSignature))
    );
  },
};

export const abilityReadScenarios = [
  checkSite,
  siteThemes,
  listUpdatesCrossCheck,
  clientsCountConsistency,
  listTagsCrossCheck,
];
