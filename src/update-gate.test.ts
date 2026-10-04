import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { clearCache, initRateLimiter } from './abilities.js';
import { clearToolsCache } from './tools.js';
import { clearPendingPreviews } from './confirmation.js';
import { resetSessionData } from './session.js';
import { clearKnownSecrets } from './security.js';
import { makeBaseConfig } from '../tests/helpers/config.js';
import {
  UPDATE_ABILITIES,
  makeDashboard63Abilities,
  makeOldDashboardAbilities,
  makePlanSites,
  makeUpdatePreview,
  makeExecutedUpdates,
  makeUnignorePreview,
} from '../tests/helpers/update-gate.js';
import type { Config } from './config.js';

const mockFetch = vi.fn();
const toolName = (ability: string) => ability.slice('mainwp/'.length).replaceAll('-', '_');
const batchArgs = { site_ids_or_domains: [1, 2, 3] };
const unignoreArgs = {
  site_id_or_domain: 1,
  type: 'plugin',
  slugs: ['wordpress-seo/wp-seo.php', 'akismet/akismet.php'],
};
const movedError = {
  code: 'mainwp_unignore_moved',
  message:
    'Removing an item from the ignored list needs confirmation. Use mainwp/unignore-site-updates-v1.',
  data: { status: 400, replacement: 'mainwp/unignore-site-updates-v1' },
};

describe('Dashboard 6.3 update gates through MCP handlers', () => {
  let catalog = makeDashboard63Abilities();
  let hostilePreview: unknown;
  let queued: boolean;
  const connections: Array<{ client: Client; server: Server }> = [];
  const requests: Array<{
    ability: string;
    method: string;
    url: URL;
    input: Record<string, unknown>;
    body: unknown;
  }> = [];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    clearCache();
    clearToolsCache();
    clearPendingPreviews();
    resetSessionData();
    clearKnownSecrets();
    initRateLimiter(0);
    catalog = makeDashboard63Abilities();
    hostilePreview = undefined;
    queued = false;
    requests.length = 0;
    mockFetch.mockImplementation(async (rawUrl: string, options: RequestInit) => {
      const url = new URL(rawUrl);
      if (!url.pathname.endsWith('/run')) return new Response(JSON.stringify(catalog));
      const ability = decodeURIComponent(url.pathname.split('/abilities/')[1].slice(0, -4));
      const input: Record<string, unknown> = options.body
        ? JSON.parse(String(options.body)).input
        : Object.fromEntries([...url.searchParams].map(([key, value]) => [key, value]));
      if (options.method === 'DELETE') {
        for (const key of ['site_id_or_domain', 'type', 'dry_run', 'confirm']) {
          const value = url.searchParams.get(`input[${key}]`);
          if (value !== null)
            input[key] = key === 'dry_run' || key === 'confirm' ? value === '1' : value;
        }
        input.slugs = url.searchParams.getAll('input[slugs][]');
      }
      requests.push({ ability, method: options.method!, url, input, body: options.body });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (ability === 'mainwp/set-ignored-updates-v1') return json(movedError, 400);
      const entry = catalog.find(candidate => candidate.name === ability)!;
      if (entry.meta?.annotations?.destructive) {
        if (input.dry_run && input.confirm) {
          return json(
            {
              code: 'mainwp_invalid_input',
              message: 'Cannot specify both dry_run and confirm.',
              data: { status: 400 },
            },
            400
          );
        }
        if (!input.dry_run && !input.confirm) {
          return json(
            {
              code: 'mainwp_confirmation_required',
              message:
                'Updates require confirm: true. Call with dry_run: true first to preview the plan.',
              data: { status: 400 },
            },
            400
          );
        }
      }
      if (ability === 'mainwp/unignore-site-updates-v1') {
        return json(
          input.dry_run
            ? makeUnignorePreview()
            : {
                dry_run: false,
                removed: [unignoreArgs.slugs[0]],
                not_held: [unignoreArgs.slugs[1]],
                count: 1,
              }
        );
      }
      let sites = makePlanSites();
      if (input.site_id_or_domain !== undefined) {
        const type = ability.includes('-core-')
          ? 'core'
          : ability.includes('-plugins-')
            ? 'plugin'
            : ability.includes('-themes-')
              ? 'theme'
              : 'translation';
        sites = sites
          .filter(site => site.site_id === Number(input.site_id_or_domain))
          .map(site => ({
            ...site,
            items: site.items.filter(item => item.type === type),
            skipped: site.skipped.filter(item => item.type === type),
          }));
      }
      const preview = makeUpdatePreview(sites);
      if (input.dry_run) return json(hostilePreview ?? preview);
      if (queued)
        return json({
          dry_run: false,
          queued: true,
          job_id: 'fixture-job-1',
          status_url: '/wp-json/mainwp/v2/batch/jobs/fixture-job-1',
          updates_queued: 5,
          errors: [],
        });
      const executed = makeExecutedUpdates(preview);
      if (!entry.meta?.annotations?.destructive) {
        const { dry_run: _dryRun, skipped: _skipped, ...oldResult } = executed;
        return json(oldResult);
      }
      return json(executed);
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const { client, server } of connections.splice(0)) {
      await client.close();
      await server.close();
    }
    clearPendingPreviews();
    clearKnownSecrets();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function connect(overrides: Partial<Config> = {}) {
    const { server } = await createServer(makeBaseConfig(overrides));
    const client = new Client({ name: 'update-gate-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
  }

  async function preview(
    client: Client,
    name = 'run_updates_v1',
    args: Record<string, unknown> = batchArgs
  ) {
    const response = await call(client, name, { ...args, confirm: true });
    expect(response.result.isError).toBeUndefined();
    expect(response.data.status).toBe('CONFIRMATION_REQUIRED');
    expect(response.data.confirmation_token).toEqual(expect.any(String));
    return response.data;
  }

  function confirmation(args: Record<string, unknown>, token: string) {
    return { ...args, user_confirmed: true, confirmation_token: token };
  }

  it.each(UPDATE_ABILITIES)(
    'previews %s with plan_summary and only dry_run upstream',
    async ability => {
      const client = await connect();
      const batch = ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1];
      const args = batch ? batchArgs : { site_id_or_domain: 1 };
      const data = await preview(client, toolName(ability), args);
      expect(data.preview.dry_run).toBe(true);
      expect(data.plan_summary).toEqual(
        expect.arrayContaining([
          'Versions are the ones pending now. If a newer version syncs before you confirm, the newer one is applied.',
        ])
      );
      expect(data.plan_summary.length).toBeGreaterThan(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        ability,
        method: 'POST',
        input: { ...args, dry_run: true },
      });
      expect(requests[0].input).toEqual({ ...args, dry_run: true });
    }
  );

  it('summarizes the multi-site preview, empty translation version and held-only site exactly', async () => {
    const data = await preview(await connect());
    expect(data.preview).toEqual(makeUpdatePreview());
    expect(data.preview.would_affect.summary.site_count).toBe(2);
    expect(data.plan_summary).toEqual([
      'Alpine Bakery: WordPress 6.8.1 → 6.9',
      'Alpine Bakery: Akismet 5.3.6 → 5.3.7',
      'Alpine Bakery: Bakehouse 2.4.0 → 2.5.0',
      'Alpine Bakery: Akismet translation → 5.3.7',
      'Beacon Studio: Akismet 5.3.5 → 5.3.7',
      'Held back: Yoast SEO on Alpine Bakery (ignored on this site)',
      'Held back: Yoast SEO on Cedar Nonprofit (ignored on this site)',
      'Major version: WordPress 6.8.1 → 6.9',
      'Core update on 1 site',
      'Versions are the ones pending now. If a newer version syncs before you confirm, the newer one is applied.',
    ]);
  });

  it.each(UPDATE_ABILITIES)(
    'confirms %s with the token, confirm true and no dry_run',
    async ability => {
      const client = await connect();
      const args =
        ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1]
          ? batchArgs
          : { site_id_or_domain: 1 };
      const data = await preview(client, toolName(ability), args);
      const executed = await call(
        client,
        toolName(ability),
        confirmation(args, data.confirmation_token)
      );
      expect(executed.result.isError).toBeUndefined();
      expect(executed.data).toMatchObject({
        dry_run: false,
        errors: [],
        summary: { total_errors: 0 },
      });
      expect(executed.data.updated.length).toBeGreaterThan(0);
      expect(requests).toHaveLength(2);
      expect(requests[1].method).toBe('POST');
      expect(requests[1].input).toEqual({ ...args, confirm: true });
    }
  );

  it('relays the queued execution result after confirmation', async () => {
    const client = await connect();
    const data = await preview(client);
    queued = true;
    const executed = await call(
      client,
      'run_updates_v1',
      confirmation(batchArgs, data.confirmation_token)
    );
    expect(executed.result.isError).toBeUndefined();
    expect(executed.data).toEqual({
      dry_run: false,
      queued: true,
      job_id: 'fixture-job-1',
      status_url: '/wp-json/mainwp/v2/batch/jobs/fixture-job-1',
      updates_queued: 5,
      errors: [],
    });
    expect(requests[1].input).toEqual({ ...batchArgs, confirm: true });
  });

  it('rejects changed arguments with PREVIEW_REQUIRED without executing', async () => {
    const client = await connect();
    const data = await preview(client);
    const response = await call(
      client,
      'run_updates_v1',
      confirmation({ site_ids_or_domains: [2] }, data.confirmation_token)
    );
    expect(response.result.isError).toBe(true);
    expect(response.data.error).toBe('PREVIEW_REQUIRED');
    expect(requests).toHaveLength(1);
  });

  it('rejects a token expired past five minutes with PREVIEW_EXPIRED', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const client = await connect();
    const data = await preview(client);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    const response = await call(
      client,
      'run_updates_v1',
      confirmation(batchArgs, data.confirmation_token)
    );
    expect(response.result.isError).toBe(true);
    expect(response.data.error).toBe('PREVIEW_EXPIRED');
    expect(requests).toHaveLength(1);
  });

  it('rejects token reuse with PREVIEW_REQUIRED after one execution', async () => {
    const client = await connect();
    const data = await preview(client);
    const args = confirmation(batchArgs, data.confirmation_token);
    expect((await call(client, 'run_updates_v1', args)).result.isError).toBeUndefined();
    const reused = await call(client, 'run_updates_v1', args);
    expect(reused.result.isError).toBe(true);
    expect(reused.data.error).toBe('PREVIEW_REQUIRED');
    expect(requests).toHaveLength(2);
  });

  it.each(['run_updates_v1', 'unignore_site_updates_v1'])(
    'safe mode blocks preview and confirm for %s without upstream execution',
    async name => {
      const args = name === 'run_updates_v1' ? batchArgs : unignoreArgs;
      const data = await preview(await connect(), name, args);
      const client = await connect({ safeMode: true });
      requests.length = 0;
      for (const input of [
        { ...args, confirm: true },
        confirmation(args, data.confirmation_token),
      ]) {
        const blocked = await call(client, name, input);
        expect(blocked.result.isError).toBe(true);
        expect(blocked.data.error).toBe('SAFE_MODE_BLOCKED');
      }
      expect(requests).toHaveLength(0);
    }
  );

  it('confirmation off passes confirm directly through in one call', async () => {
    const client = await connect({ requireUserConfirmation: false });
    const response = await call(client, 'run_updates_v1', { ...batchArgs, confirm: true });
    expect(response.result.isError).toBeUndefined();
    expect(response.data).toEqual(makeExecutedUpdates());
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual({ ...batchArgs, confirm: true });
  });

  it('confirmation off without confirm relays the Dashboard 400 and upstream_code', async () => {
    const client = await connect({ requireUserConfirmation: false });
    const response = await call(client, 'run_updates_v1', batchArgs);
    expect(response.result.isError).toBe(true);
    expect(response.data.error.code).toBe(-32000);
    expect(response.data.error.data?.upstream_code).toBe('mainwp_confirmation_required');
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual(batchArgs);
  });

  it('confirmation off relays both flags as mainwp_invalid_input', async () => {
    const response = await call(
      await connect({ requireUserConfirmation: false }),
      'run_updates_v1',
      { ...batchArgs, dry_run: true, confirm: true }
    );
    expect(response.result.isError).toBe(true);
    expect(response.data.error.data?.upstream_code).toBe('mainwp_invalid_input');
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual({ ...batchArgs, dry_run: true, confirm: true });
  });

  it.each(UPDATE_ABILITIES)('old Dashboard executes %s unconfirmed in one call', async ability => {
    catalog = makeOldDashboardAbilities();
    const args =
      ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1]
        ? batchArgs
        : { site_id_or_domain: 1 };
    const response = await call(await connect(), toolName(ability), args);
    expect(response.result.isError).toBeUndefined();
    expect(response.data.updated.length).toBeGreaterThan(0);
    expect(response.data).not.toHaveProperty('confirmation_token');
    expect(response.data).not.toHaveProperty('plan_summary');
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual(args);
  });

  it('unignore previews and confirms over DELETE with slug arrays and boolean query values', async () => {
    const client = await connect();
    const data = await preview(client, 'unignore_site_updates_v1', unignoreArgs);
    expect(data.preview).toEqual(makeUnignorePreview());
    expect(data).not.toHaveProperty('plan_summary');
    const response = await call(client, 'unignore_site_updates_v1', {
      ...confirmation(unignoreArgs, data.confirmation_token),
      dry_run: false,
    });
    expect(response.result.isError).toBeUndefined();
    expect(response.data).toEqual({
      dry_run: false,
      removed: [unignoreArgs.slugs[0]],
      not_held: [unignoreArgs.slugs[1]],
      count: 1,
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe('DELETE');
      expect(request.body).toBeUndefined();
      expect(request.url.searchParams.getAll('input[slugs][]')).toEqual(unignoreArgs.slugs);
      expect(request.url.searchParams.get('input[site_id_or_domain]')).toBe('1');
      expect(request.url.searchParams.get('input[type]')).toBe('plugin');
      expect(request.url.searchParams.has('input[user_confirmed]')).toBe(false);
      expect(request.url.searchParams.has('input[confirmation_token]')).toBe(false);
    }
    expect(requests[0].url.searchParams.get('input[dry_run]')).toBe('1');
    expect(requests[0].url.searchParams.has('input[confirm]')).toBe(false);
    expect(requests[1].url.searchParams.get('input[confirm]')).toBe('1');
    expect(requests[1].url.searchParams.has('input[dry_run]')).toBe(false);
    // With confirmation disabled, an explicit false remains a PHP boolean query value.
    const automated = await connect({ requireUserConfirmation: false });
    await call(automated, 'unignore_site_updates_v1', {
      ...unignoreArgs,
      confirm: true,
      dry_run: false,
    });
    expect(requests[2].url.searchParams.get('input[confirm]')).toBe('1');
    expect(requests[2].url.searchParams.get('input[dry_run]')).toBe('0');
  });

  it.each(['upstream_code', 'replacement'])(
    'moved ignore path returns isError with %s',
    async field => {
      const response = await call(await connect(), 'set_ignored_updates_v1', {
        site_id_or_domain: 1,
        type: 'plugin',
        slug: 'wordpress-seo/wp-seo.php',
        action: 'unignore',
      });
      expect(response.result.isError).toBe(true);
      expect(response.data.error.data?.[field]).toBe(
        field === 'upstream_code' ? 'mainwp_unignore_moved' : 'unignore_site_updates_v1'
      );
      expect(requests).toHaveLength(1);
      expect(requests[0].input.action).toBe('unignore');
    }
  );

  const hostileCases: Array<{
    label: string;
    corrupt: (preview: ReturnType<typeof makeUpdatePreview>) => unknown;
  }> = [
    { label: 'wrong count type', corrupt: value => ({ ...value, count: '5' }) },
    {
      label: 'required summary fields hidden under __proto__',
      corrupt: value => ({
        ...value,
        would_affect: {
          ...value.would_affect,
          summary: JSON.parse(JSON.stringify({ ['__proto__']: value.would_affect.summary })),
        },
      }),
    },
    {
      label: '10 KB item name',
      corrupt: value => {
        value.would_affect.sites[0].items[0].name = 'x'.repeat(10 * 1024);
        return value;
      },
    },
    {
      label: 'control characters in site name',
      corrupt: value => {
        value.would_affect.sites[0].site_name = 'Alpine\u0000\u001b[31m\u202e';
        return value;
      },
    },
    {
      label: 'missing would_affect fields',
      corrupt: value => ({ ...value, would_affect: { sites: value.would_affect.sites } }),
    },
    { label: 'count mismatch', corrupt: value => ({ ...value, count: value.count + 1 }) },
    {
      label: 'site count includes held-only site',
      corrupt: value => {
        value.would_affect.summary.site_count = 3;
        return value;
      },
    },
  ];
  it.each(hostileCases)(
    'hostile preview ($label) omits plan_summary and relays raw preview',
    async ({ corrupt }) => {
      hostilePreview = corrupt(makeUpdatePreview());
      const data = await preview(await connect());
      expect(data).not.toHaveProperty('plan_summary');
      expect(data.preview).toEqual(hostilePreview);
      expect(JSON.stringify(data.preview)).toBe(JSON.stringify(hostilePreview));
      expect(requests).toHaveLength(1);
      expect(requests[0].input).toEqual({ ...batchArgs, dry_run: true });
    }
  );
});
