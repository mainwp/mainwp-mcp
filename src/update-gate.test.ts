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
  makeSafeUpdateAbility,
  makeSafeUpdatePreview,
  SAFE_UPDATE_ABILITY,
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

const backupSkips = [
  { reason: 'backup_missing', phrase: 'no recent backup' },
  { reason: 'backup_pending_offsite', phrase: 'latest backup not in offsite storage yet' },
] as const;

function makeBackupGatePreview(ability: string, reason: (typeof backupSkips)[number]['reason']) {
  const type = ability.includes('-core-')
    ? 'core'
    : ability.includes('-themes-')
      ? 'theme'
      : ability.includes('-translations-')
        ? 'translation'
        : 'plugin';
  const item = {
    core: { slug: 'wordpress', name: 'WordPress', from: '6.8.1', to: '6.9' },
    plugin: { slug: 'hello-dolly/hello.php', name: 'Hello Dolly', from: '1.6', to: '1.7.2' },
    theme: { slug: 'twentytwentyfive', name: 'Twenty Twenty-Five', from: '1.1', to: '1.2' },
    translation: { slug: 'default', name: 'WordPress core', from: '', to: '6.8.1' },
  }[type];
  return {
    dry_run: true,
    would_affect: {
      sites: [
        {
          site_id: 3,
          site_url: 'https://example-shop.test/',
          site_name: 'Example Shop',
          backup_gate: {
            applies: true,
            verdict: reason === 'backup_missing' ? 'missing' : 'pending_offsite',
            overridden: false,
          },
          items: [],
          skipped: [{ type, ...item, requested: false, reason }],
        },
      ],
      by_item: [],
      summary: {
        site_count: 0,
        item_count: 0,
        skipped_count: 1,
        all_sites: false,
        queued: false,
        truncated: false,
        has_core: false,
        has_major: false,
        has_unknown_version: false,
        backup_gate_blocked_sites: 1,
        backup_gate_overridden_sites: 0,
        requested_not_found: [],
      },
    },
    count: 0,
    warnings: [
      '1 site has no backup that meets the pre-update backup setting and will be skipped. Pass ignore_backup_gate: true to update it anyway.',
    ],
    errors: [],
  };
}

describe('Dashboard 6.3 update gates through MCP handlers', () => {
  let catalog = makeDashboard63Abilities();
  let hostilePreview: unknown;
  let queued: boolean;
  let backupGateBlocked: boolean;
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
    backupGateBlocked = false;
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
      if (ability === SAFE_UPDATE_ABILITY) {
        return json(
          input.dry_run
            ? (hostilePreview ?? makeSafeUpdatePreview())
            : {
                dry_run: false,
                run_id: 7,
                url: 'https://dashboard.test/wp-admin/admin.php?page=SafeUpdates&run_id=7',
                conflicts: [],
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
      if (backupGateBlocked)
        return json(
          {
            code: 'mainwp_backup_gate_blocked',
            message: 'The latest backup is not in offsite storage yet.',
            data: { status: 409, site_id: 3, verdict: 'pending_offsite' },
          },
          409
        );
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

  it.each(UPDATE_ABILITIES.flatMap(ability => backupSkips.map(skip => ({ ability, ...skip }))))(
    'confirm preview flow for $ability renders $reason in plan_summary',
    async ({ ability, reason, phrase }) => {
      const upstream = makeBackupGatePreview(ability, reason);
      hostilePreview = upstream;
      const client = await connect({ requireUserConfirmation: true });
      const batch = ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1];
      const args = batch ? { site_ids_or_domains: [3] } : { site_id_or_domain: 3 };
      const data = await preview(client, toolName(ability), args);
      expect(data.status).toBe('CONFIRMATION_REQUIRED');
      expect(data.preview).toEqual(upstream);
      const item = upstream.would_affect.sites[0].skipped[0];
      const name = item.type === 'translation' ? `${item.name} translation` : item.name;
      expect(data.plan_summary).toContain(`Held back: ${name} on Example Shop (${phrase})`);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ ability, method: 'POST' });
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

  describe('confirmed update with no response', () => {
    const unknownOutcome =
      'The server stopped waiting for the Dashboard, and the update may still be running. Assume it may have applied and re-read state before doing anything else.';
    let writes: number;

    // Previews answer normally; the confirmed write hangs or gets a gateway status.
    function stallWrites(gatewayStatus?: number) {
      const answer = mockFetch.getMockImplementation()!;
      writes = 0;
      mockFetch.mockImplementation(async (rawUrl: string, options: RequestInit) => {
        const confirmed = options.body
          ? JSON.parse(String(options.body)).input?.confirm === true
          : new URL(rawUrl).searchParams.get('input[confirm]') === '1';
        if (!rawUrl.includes('/run') || !confirmed) return answer(rawUrl, options);
        writes += 1;
        if (gatewayStatus !== undefined) {
          return new Response('<html>Gateway Timeout</html>', { status: gatewayStatus });
        }
        return new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        });
      });
    }

    it.each(['run_updates_v1', 'update_all_v1', 'update_site_plugins_v1'])(
      'reports a local timeout on %s as an unknown outcome after one write',
      async name => {
        const args = name === 'update_site_plugins_v1' ? { site_id_or_domain: 1 } : batchArgs;
        const client = await connect({ requestTimeout: 50, retryEnabled: true });
        const data = await preview(client, name, args);
        stallWrites();
        const response = await call(client, name, confirmation(args, data.confirmation_token));
        expect(response.result.isError).toBe(true);
        expect(response.data).toEqual({ error: { code: -32001, message: unknownOutcome } });
        expect(JSON.stringify(response.data)).not.toMatch(/job/i);
        expect(writes).toBe(1);
      }
    );

    it.each([504, 524])('reports HTTP %i on run_updates_v1 as an unknown outcome', async status => {
      const client = await connect({ retryEnabled: true });
      const data = await preview(client);
      stallWrites(status);
      const response = await call(
        client,
        'run_updates_v1',
        confirmation(batchArgs, data.confirmation_token)
      );
      expect(response.result.isError).toBe(true);
      expect(response.data.error.code).toBe(-32000);
      expect(response.data.error.message).toBe(unknownOutcome);
      expect(writes).toBe(1);
    });

    it('keeps the plain timeout message for tools outside the update list', async () => {
      const client = await connect({ requestTimeout: 50 });
      const data = await preview(client, 'unignore_site_updates_v1', unignoreArgs);
      stallWrites();
      const response = await call(
        client,
        'unignore_site_updates_v1',
        confirmation(unignoreArgs, data.confirmation_token)
      );
      expect(response.result.isError).toBe(true);
      expect(response.data.error.code).toBe(-32001);
      expect(response.data.error.message).toMatch(/^Request timeout after 50ms/);
    });

    it.each([
      ['a safe mode dry run', { safeMode: true }, { dry_run: true }],
      ['a confirm: true preview', {}, { confirm: true }],
      [
        "dry_run: 'true' with confirmation off",
        { requireUserConfirmation: false },
        { dry_run: 'true' },
      ],
    ])(
      'keeps the gateway message for %s, which applies nothing',
      async (_label, overrides, extra) => {
        const client = await connect({ ...overrides, retryEnabled: true });
        mockFetch.mockImplementation(async (rawUrl: string) =>
          rawUrl.includes('/run')
            ? new Response('<html>Gateway Timeout</html>', { status: 504 })
            : new Response(JSON.stringify(catalog))
        );
        const response = await call(client, 'run_updates_v1', { ...batchArgs, ...extra });
        expect(response.result.isError).toBe(true);
        expect(response.data.error.code).toBe(-32000);
        expect(response.data.error.message).not.toBe(unknownOutcome);
      }
    );
  });

  it('rejects changed arguments with PREVIEW_ARGS_MISMATCH without executing', async () => {
    const client = await connect();
    const data = await preview(client);
    const response = await call(
      client,
      'run_updates_v1',
      confirmation({ site_ids_or_domains: [2] }, data.confirmation_token)
    );
    expect(response.result.isError).toBe(true);
    expect(response.data.error).toBe('PREVIEW_ARGS_MISMATCH');
    expect(requests).toHaveLength(1);
  });

  describe('run_updates arguments equal to their declared defaults', () => {
    // Dashboard 6.5 declares these defaults on run-updates-v1.
    beforeEach(() => {
      const entry = catalog.find(candidate => candidate.name === 'mainwp/run-updates-v1')!;
      const properties = entry.input_schema!.properties as Record<string, unknown>;
      properties.specific_items = { type: 'array', items: { type: 'string' }, default: [] };
      properties.ignore_backup_gate = { type: 'boolean', default: false };
    });

    const explicitDefaults = { types: [], specific_items: [], ignore_backup_gate: false };

    it.each([
      [
        'preview omits them and confirm sends them',
        batchArgs,
        { ...batchArgs, ...explicitDefaults },
      ],
      [
        'preview sends them and confirm omits them',
        { ...batchArgs, ...explicitDefaults },
        batchArgs,
      ],
    ])('confirms when the %s', async (_label, previewArgs, confirmArgs) => {
      const client = await connect();
      const data = await preview(client, 'run_updates_v1', previewArgs);
      const response = await call(
        client,
        'run_updates_v1',
        confirmation(confirmArgs, data.confirmation_token)
      );
      expect(response.result.isError).toBeUndefined();
      expect(response.data).toEqual(makeExecutedUpdates());
      expect(requests).toHaveLength(2);
      expect(requests[1].input).toEqual({ ...confirmArgs, confirm: true });
    });

    it.each([
      ['string site IDs', { site_ids_or_domains: ['1', '2', '3'] }],
      ['reordered site IDs', { site_ids_or_domains: [3, 2, 1] }],
    ])(
      'rejects %s with PREVIEW_ARGS_MISMATCH and deletes the token',
      async (_label, confirmArgs) => {
        const client = await connect();
        const data = await preview(client, 'run_updates_v1', batchArgs);
        const response = await call(
          client,
          'run_updates_v1',
          confirmation(confirmArgs, data.confirmation_token)
        );
        expect(response.result.isError).toBe(true);
        expect(response.data.error).toBe('PREVIEW_ARGS_MISMATCH');
        const retry = await call(
          client,
          'run_updates_v1',
          confirmation(batchArgs, data.confirmation_token)
        );
        expect(retry.result.isError).toBe(true);
        expect(retry.data.error).toBe('PREVIEW_REQUIRED');
        expect(requests).toHaveLength(1);
      }
    );
  });

  it('pins ignore_backup_gate to the confirm preview and rejects adding the override without executing', async () => {
    const ability = 'mainwp/update-site-plugins-v1';
    const entry = catalog.find(candidate => candidate.name === ability)!;
    (entry.input_schema!.properties as Record<string, unknown>).ignore_backup_gate = {
      type: 'boolean',
      default: false,
    };
    hostilePreview = makeBackupGatePreview(ability, 'backup_pending_offsite');
    const client = await connect();
    const args = { site_id_or_domain: 3 };
    const data = await preview(client, toolName(ability), args);
    const response = await call(
      client,
      toolName(ability),
      confirmation({ ...args, ignore_backup_gate: true }, data.confirmation_token)
    );
    expect(response.result.isError).toBe(true);
    expect(response.data.error).toBe('PREVIEW_ARGS_MISMATCH');
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual({ ...args, dry_run: true });
  });

  it('pins single-site confirmed HTTP 409 backup-gate refusal to isError and upstream_code', async () => {
    const ability = 'mainwp/update-site-plugins-v1';
    hostilePreview = makeBackupGatePreview(ability, 'backup_pending_offsite');
    const client = await connect();
    const args = { site_id_or_domain: 3 };
    const data = await preview(client, toolName(ability), args);
    backupGateBlocked = true;
    const response = await call(
      client,
      toolName(ability),
      confirmation(args, data.confirmation_token)
    );
    expect(response.result.isError).toBe(true);
    expect(response.data.error.code).toBe(-32000);
    expect(response.data.error.data?.upstream_code).toBe('mainwp_backup_gate_blocked');
    expect(requests).toHaveLength(2);
    expect(requests[1].input).toEqual({ ...args, confirm: true });
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

  it('keeps PREVIEW_REQUIRED for an expired token sent with changed arguments', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const client = await connect();
    const data = await preview(client);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    const response = await call(
      client,
      'run_updates_v1',
      confirmation({ site_ids_or_domains: [2] }, data.confirmation_token)
    );
    expect(response.result.isError).toBe(true);
    expect(response.data.error).toBe('PREVIEW_REQUIRED');
    expect(requests).toHaveLength(1);
  });

  it('keeps defaults significant for destructive tools outside the update list', async () => {
    const entry = catalog.find(candidate => candidate.name === 'mainwp/unignore-site-updates-v1')!;
    (entry.input_schema!.properties as Record<string, unknown>).include_archived = {
      type: 'boolean',
      default: false,
    };
    const client = await connect();
    const data = await preview(client, 'unignore_site_updates_v1', unignoreArgs);
    const response = await call(
      client,
      'unignore_site_updates_v1',
      confirmation({ ...unignoreArgs, include_archived: false }, data.confirmation_token)
    );
    expect(response.result.isError).toBe(true);
    expect(response.data.error).toBe('PREVIEW_ARGS_MISMATCH');
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

  describe('safe mode dry runs', () => {
    const argsFor = (ability: string) =>
      ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1]
        ? batchArgs
        : { site_id_or_domain: 1 };

    it.each(UPDATE_ABILITIES)('lets literal dry_run: true preview %s', async ability => {
      const client = await connect({ safeMode: true });
      const args = argsFor(ability);
      const response = await call(client, toolName(ability), { ...args, dry_run: true });
      expect(response.result.isError).toBeUndefined();
      expect(response.data.dry_run).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ ability, method: 'POST' });
      expect(requests[0].input).toEqual({ ...args, dry_run: true });
    });

    it('strips confirm from a safe mode dry run', async () => {
      const client = await connect({ safeMode: true });
      const response = await call(client, 'run_updates_v1', {
        ...batchArgs,
        dry_run: true,
        confirm: true,
      });
      expect(response.result.isError).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0].input).toEqual({ ...batchArgs, dry_run: true });
    });

    it.each([
      ['dry_run: false', { dry_run: false }],
      ['no dry_run', {}],
      ["dry_run: 'true'", { dry_run: 'true' }],
      ['dry_run: 1', { dry_run: 1 }],
      ['dry_run with user_confirmed', { dry_run: true, user_confirmed: true }],
      ['dry_run with user_confirmed: false', { dry_run: true, user_confirmed: false }],
    ])('blocks run_updates_v1 with %s', async (_label, extra) => {
      const client = await connect({ safeMode: true });
      const response = await call(client, 'run_updates_v1', { ...batchArgs, ...extra });
      expect(response.result.isError).toBe(true);
      expect(response.data.error).toBe('SAFE_MODE_BLOCKED');
      expect(requests).toHaveLength(0);
    });

    it('blocks dry_run on a destructive tool outside the update list', async () => {
      const client = await connect({ safeMode: true });
      const response = await call(client, 'unignore_site_updates_v1', {
        ...unignoreArgs,
        dry_run: true,
      });
      expect(response.result.isError).toBe(true);
      expect(response.data.error).toBe('SAFE_MODE_BLOCKED');
      expect(requests).toHaveLength(0);
    });

    it('keeps the tool blocklist ahead of the dry run allowance', async () => {
      const client = await connect({ safeMode: true, blockedTools: ['run_updates_v1'] });
      const result = await client.callTool({
        name: 'run_updates_v1',
        arguments: { ...batchArgs, dry_run: true },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Tool is not allowed');
      expect(requests).toHaveLength(0);
    });

    it.each([
      ['no dry_run property', undefined],
      ['a non-boolean dry_run property', { type: 'string' }],
    ])('blocks an update tool whose schema has %s', async (_label, dryRunSchema) => {
      const entry = catalog.find(candidate => candidate.name === 'mainwp/run-updates-v1')!;
      const properties = entry.input_schema!.properties as Record<string, unknown>;
      delete properties.dry_run;
      if (dryRunSchema) properties.dry_run = dryRunSchema;
      const client = await connect({ safeMode: true });
      const result = await client.callTool({
        name: 'run_updates_v1',
        arguments: { ...batchArgs, dry_run: true },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('SAFE_MODE_BLOCKED');
      expect(requests).toHaveLength(0);
    });
  });

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

  describe('version caveat and preview_token', () => {
    const versionCaveat =
      'Versions are the ones pending now. If a newer version syncs before you confirm, the newer one is applied.';
    const sentToken = 'fixture_preview_token_0123456789';

    function declarePreviewToken(ability: string) {
      const entry = catalog.find(candidate => candidate.name === ability)!;
      (entry.input_schema!.properties as Record<string, unknown>).preview_token = {
        type: ['string', 'null'],
      };
    }

    // The Dashboard only pins versions through a token the confirmed call sends.
    it.each([
      { label: 'too short', declared: true, token: 'short-token' },
      { label: 'outside the character set', declared: true, token: `${sentToken}/` },
      { label: 'undeclared by the ability', declared: false, token: sentToken },
      { label: 'absent', declared: true, token: undefined },
    ])('keeps the caveat when the preview_token is $label', async ({ declared, token }) => {
      if (declared) declarePreviewToken('mainwp/run-updates-v1');
      if (token !== undefined) hostilePreview = { ...makeUpdatePreview(), preview_token: token };
      const client = await connect();
      const data = await preview(client);
      expect(data.plan_summary.at(-1)).toBe(versionCaveat);
      const executed = await call(
        client,
        'run_updates_v1',
        confirmation(batchArgs, data.confirmation_token)
      );
      expect(executed.result.isError).toBeUndefined();
      expect(requests[1].input).toEqual({ ...batchArgs, confirm: true });
    });

    it('keeps the caveat when MainWP is not the primary namespace', async () => {
      declarePreviewToken('mainwp/run-updates-v1');
      hostilePreview = { ...makeUpdatePreview(), preview_token: sentToken };
      const client = await connect({ abilityNamespaces: ['acme', 'mainwp'] });
      const data = await preview(client, 'mainwp__run_updates_v1');
      expect(data.plan_summary.at(-1)).toBe(versionCaveat);
    });

    it.each(UPDATE_ABILITIES)(
      'omits the caveat when %s sends the captured preview_token',
      async ability => {
        declarePreviewToken(ability);
        hostilePreview = { ...makeUpdatePreview(), preview_token: sentToken };
        const client = await connect();
        const batch = ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1];
        const args = batch ? batchArgs : { site_id_or_domain: 1 };
        const data = await preview(client, toolName(ability), args);
        expect(data.plan_summary.length).toBeGreaterThan(0);
        expect(data.plan_summary).not.toContain(versionCaveat);
        const executed = await call(
          client,
          toolName(ability),
          confirmation(args, data.confirmation_token)
        );
        expect(executed.result.isError).toBeUndefined();
        expect(requests[1].input).toEqual({ ...args, preview_token: sentToken, confirm: true });
      }
    );
  });

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

  describe('own dry_run', () => {
    async function dryRun(client: Client, name: string, args: Record<string, unknown>) {
      const response = await call(client, name, { ...args, dry_run: true });
      expect(response.result.isError).toBeUndefined();
      return response.data;
    }

    it.each(
      [true, false].flatMap(requireUserConfirmation =>
        UPDATE_ABILITIES.flatMap(ability =>
          backupSkips.map(skip => ({ requireUserConfirmation, ability, ...skip }))
        )
      )
    )(
      '$ability adds the confirm preview plan_summary beside the raw result (confirmation $requireUserConfirmation, $reason)',
      async ({ requireUserConfirmation, ability, reason }) => {
        const upstream = makeBackupGatePreview(ability, reason);
        hostilePreview = upstream;
        const batch = ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1];
        const args = batch ? { site_ids_or_domains: [3] } : { site_id_or_domain: 3 };
        const confirmed = await preview(
          await connect({ requireUserConfirmation: true }),
          toolName(ability),
          args
        );
        const { plan_summary: planSummary, ...raw } = await dryRun(
          await connect({ requireUserConfirmation }),
          toolName(ability),
          args
        );
        expect(raw).toEqual(upstream);
        expect(planSummary).toEqual(confirmed.plan_summary);
        expect(requests).toHaveLength(2);
        expect(requests[1].input).toEqual({ ...args, dry_run: true });
      }
    );

    it('summarizes the multi-site preview the same way as the confirm preview', async () => {
      const confirmed = await preview(await connect());
      const data = await dryRun(await connect(), 'run_updates_v1', batchArgs);
      expect(data).toEqual({ ...makeUpdatePreview(), plan_summary: confirmed.plan_summary });
      expect(data.plan_summary).toContain(
        'Held back: Yoast SEO on Cedar Nonprofit (ignored on this site)'
      );
    });

    it.each(hostileCases)('hostile result ($label) is relayed raw', async ({ corrupt }) => {
      hostilePreview = corrupt(makeUpdatePreview());
      const data = await dryRun(await connect(), 'run_updates_v1', batchArgs);
      expect(data).toEqual(hostilePreview);
    });

    it('keeps an upstream plan_summary field instead of replacing it', async () => {
      hostilePreview = { ...makeUpdatePreview(), plan_summary: 'from upstream' };
      const data = await dryRun(await connect(), 'run_updates_v1', batchArgs);
      expect(data).toEqual(hostilePreview);
    });

    it('relays a non-update dry_run result unchanged', async () => {
      const data = await dryRun(await connect(), 'unignore_site_updates_v1', unignoreArgs);
      expect(data).toEqual(makeUnignorePreview());
    });
  });

  describe('run_safe_update_v1', () => {
    const safeArgs = { site_ids_or_domains: [1, 2, 3], types: ['plugins'] };
    const safeSummary = [
      'Acme Corp: Akismet Anti-spam 5.3 → 5.4',
      'Acme Corp: WordPress 6.8.1 → 6.9',
      'Bramble Studio: WordPress core translation → 6.8.1',
      'Backup on Acme Corp: recent backup',
      'Checks on Acme Corp: http, monitor:12, child, regression not run (add-on not installed)',
      'Backup on Bramble Studio: will back up first',
      'Checks on Bramble Studio: http, monitor not run (No monitor configured), child not run (Not selected), regression (waiting for regression scan)',
      'Left out: Cedar Nonprofit (site suspended)',
      'Versions are the ones pending now. If a newer version syncs before you confirm, the newer one is applied.',
    ];

    beforeEach(() => {
      catalog = [...makeDashboard63Abilities(), makeSafeUpdateAbility()];
    });

    it('adds plan_summary to the confirm preview and keeps the raw preview', async () => {
      const data = await preview(await connect(), 'run_safe_update_v1', safeArgs);
      expect(data.preview).toEqual(makeSafeUpdatePreview());
      expect(data.plan_summary).toEqual(safeSummary);
      expect(requests).toHaveLength(1);
      expect(requests[0].ability).toBe(SAFE_UPDATE_ABILITY);
      expect(requests[0].input).toEqual({ ...safeArgs, dry_run: true });
    });

    it('confirms the previewed selection and relays the run result unchanged', async () => {
      const client = await connect();
      const { confirmation_token: token } = await preview(client, 'run_safe_update_v1', safeArgs);
      const { result, data } = await call(
        client,
        'run_safe_update_v1',
        confirmation({ ...safeArgs, confirm: true }, token)
      );
      expect(result.isError).toBeUndefined();
      expect(data).toEqual({
        dry_run: false,
        run_id: 7,
        url: 'https://dashboard.test/wp-admin/admin.php?page=SafeUpdates&run_id=7',
        conflicts: [],
      });
      expect(requests[1].input).toEqual({ ...safeArgs, confirm: true });
    });

    it.each([true, false])(
      'adds plan_summary beside the raw own dry_run result (confirmation %s)',
      async requireUserConfirmation => {
        const client = await connect({ requireUserConfirmation });
        const response = await call(client, 'run_safe_update_v1', { ...safeArgs, dry_run: true });
        expect(response.result.isError).toBeUndefined();
        const { plan_summary: planSummary, ...raw } = response.data;
        expect(raw).toEqual(makeSafeUpdatePreview());
        expect(planSummary).toEqual(safeSummary);
      }
    );

    it('relays a preview with an unexpected shape unchanged', async () => {
      const upstream = makeSafeUpdatePreview();
      (upstream.would_affect.sites[0] as Record<string, unknown>).checks = 'all';
      hostilePreview = upstream;
      const confirmed = await preview(await connect(), 'run_safe_update_v1', safeArgs);
      expect(confirmed.preview).toEqual(upstream);
      expect(confirmed).not.toHaveProperty('plan_summary');
      const dryRun = await call(await connect(), 'run_safe_update_v1', {
        ...safeArgs,
        dry_run: true,
      });
      expect(dryRun.data).toEqual(upstream);
    });

    it.each([
      ['an empty slug', { slug: '' }],
      ['an empty new_version', { new_version: '' }],
    ])('returns no plan_summary for an item with %s', async (_label, change) => {
      const upstream = makeSafeUpdatePreview();
      Object.assign(upstream.would_affect.sites[0].items[0], change);
      hostilePreview = upstream;
      const confirmed = await preview(await connect(), 'run_safe_update_v1', safeArgs);
      expect(confirmed.preview).toEqual(upstream);
      expect(confirmed).not.toHaveProperty('plan_summary');
      const dryRun = await call(await connect(), 'run_safe_update_v1', {
        ...safeArgs,
        dry_run: true,
      });
      expect(dryRun.data).toEqual(upstream);
    });

    it('leaves other update tools alone when they return the Safe Updates shape', async () => {
      hostilePreview = makeSafeUpdatePreview();
      const confirmed = await preview(await connect());
      expect(confirmed.preview).toEqual(makeSafeUpdatePreview());
      expect(confirmed).not.toHaveProperty('plan_summary');
      const dryRun = await call(await connect(), 'run_updates_v1', { ...batchArgs, dry_run: true });
      expect(dryRun.data).toEqual(makeSafeUpdatePreview());
    });

    it('keeps the run_updates_v1 summary when Safe Updates is offered', async () => {
      const data = await preview(await connect());
      expect(data.plan_summary).toContain(
        'Held back: Yoast SEO on Cedar Nonprofit (ignored on this site)'
      );
    });

    it('is not offered by a Dashboard without Safe Updates', async () => {
      catalog = makeDashboard63Abilities();
      const client = await connect();
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toContain('run_updates_v1');
      expect(tools.map(tool => tool.name)).not.toContain('run_safe_update_v1');
    });
  });
});
