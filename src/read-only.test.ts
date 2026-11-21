import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { clearCache, initRateLimiter } from './abilities.js';
import { clearToolsCache } from './tools.js';
import { makeBaseConfig } from '../tests/helpers/config.js';
import { resolveConfig, type Config } from './config.js';
import { ConfigState } from './setup.js';

const fetchMock = vi.fn();
const ability = (name: string, readonly: unknown) => ({
  name: `mainwp/${name}-v1`,
  label: name,
  description: name,
  category: 'mainwp-sites',
  input_schema: { type: 'object', properties: { dry_run: { type: 'boolean' } } },
  meta: { annotations: { ...(readonly === undefined ? {} : { readonly }), destructive: false } },
});
const text = (result: { contents: unknown[] }) => (result.contents[0] as { text: string }).text;

async function connect(readOnly: boolean, overrides: Partial<Config> = {}) {
  const config = { ...makeBaseConfig(overrides), readOnly };
  const { server } = await createServer(config);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('read-only access through MCP', () => {
  beforeEach(() => {
    clearCache();
    clearToolsCache();
    initRateLimiter(0);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([undefined, null, 'true', 1, false])(
    'hides and denies readonly=%s on every resolving surface',
    async readonly => {
      fetchMock.mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes('/run')
                ? [{ id: 7 }]
                : [
                    ability('list-sites', readonly),
                    ability('get-site', readonly),
                    ability('visible', true),
                  ]
            )
          )
      );
      const { client, close } = await connect(true, {
        allowedTools: ['list_sites_v1', 'get_site_v1', 'visible_v1'],
      });
      try {
        expect((await client.listTools()).tools.map(t => t.name)).toEqual(['visible_v1']);
        for (const uri of ['mainwp://abilities', 'mainwp://help']) {
          const body = text(await client.readResource({ uri }));
          expect(body).toContain('visible');
          expect(body).not.toContain('list-sites');
          expect(body).not.toContain('list_sites_v1');
        }
        for (const uri of ['mainwp://help/tool/list_sites_v1', 'mainwp://site/7']) {
          expect(text(await client.readResource({ uri }))).toContain('not allowed');
        }
        const result = await client.callTool({
          name: 'list_sites_v1',
          arguments: { dry_run: true },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain('not allowed');
        expect(
          (
            await client.complete({
              ref: { type: 'ref/prompt', name: 'performance-check' },
              argument: { name: 'site_id', value: '' },
            })
          ).completion.values
        ).toEqual([]);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/run'))).toHaveLength(
          0
        );
      } finally {
        await close();
      }
    }
  );

  it.each(['list', 'abilities', 'help', 'tool-help', 'site', 'call', 'completion'])(
    'denies a non-readonly ability through %s',
    async surface => {
      fetchMock.mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes('/run')
                ? [{ id: 7 }]
                : [ability('list-sites', false), ability('get-site', false)]
            )
          )
      );
      const { client, close } = await connect(true);
      try {
        if (surface === 'list')
          expect((await client.listTools()).tools.map(t => t.name)).not.toContain('list_sites_v1');
        if (surface === 'abilities' || surface === 'help')
          expect(text(await client.readResource({ uri: `mainwp://${surface}` }))).not.toContain(
            'list-sites'
          );
        if (surface === 'tool-help' || surface === 'site')
          expect(
            text(
              await client.readResource({
                uri: surface === 'site' ? 'mainwp://site/7' : 'mainwp://help/tool/list_sites_v1',
              })
            )
          ).toContain('not allowed');
        if (surface === 'call')
          expect(
            (await client.callTool({ name: 'list_sites_v1', arguments: { dry_run: true } })).isError
          ).toBe(true);
        if (surface === 'completion')
          expect(
            (
              await client.complete({
                ref: { type: 'ref/prompt', name: 'performance-check' },
                argument: { name: 'site_id', value: '' },
              })
            ).completion.values
          ).toEqual([]);
      } finally {
        await close();
      }
    }
  );

  it('allows literal true, intersects block lists and keeps setup tools available', async () => {
    fetchMock.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/run')
              ? { ok: true }
              : [ability('visible', true), ability('blocked', true)]
          )
        )
    );
    const { client, close } = await connect(true, {
      blockedTools: ['blocked_v1'],
      allowedTools: ['visible_v1', 'blocked_v1', 'mainwp_configure', 'mainwp_get_setup_status'],
    });
    try {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toContain('visible_v1');
      expect(names).not.toContain('blocked_v1');

      expect((await client.callTool({ name: 'visible_v1', arguments: {} })).isError).not.toBe(true);
      expect(client.getInstructions()).toContain('You have read-only access');
    } finally {
      await close();
    }
  });

  it('keeps both setup tools available before configuration', async () => {
    // A developer's own ~/.config/mainwp-mcp/settings.json or a settings.json in
    // the working directory would configure the server and skip setup mode.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcp-read-only-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    vi.stubEnv('HOME', root);
    expect(os.homedir()).toBe(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.stubEnv('MAINWP_READ_ONLY', 'true');
    vi.stubEnv('MAINWP_URL', '');
    vi.stubEnv('MAINWP_USER', '');
    vi.stubEnv('MAINWP_APP_PASSWORD', '');
    vi.stubEnv('MAINWP_TOKEN', '');
    const { server } = await createServer(ConfigState.fromResolution(resolveConfig()));
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(
        expect.arrayContaining(['mainwp_configure', 'mainwp_get_setup_status'])
      );
      expect(
        (await client.callTool({ name: 'mainwp_get_setup_status', arguments: {} })).isError
      ).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])('isolates cached tool lists when readOnly starts as %s', async first => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([ability('visible', true), ability('write', false)]))
    );
    // Reading mainwp://status here would refresh the catalog and clear the
    // tool-list cache, which would hide a cache shared across the two modes.
    for (const readOnly of [first, !first]) {
      const { client, close } = await connect(readOnly);
      try {
        const names = (await client.listTools()).tools.map(t => t.name);
        expect(names.includes('write_v1')).toBe(!readOnly);
        expect(client.getInstructions()?.includes('You have read-only access')).toBe(readOnly);
      } finally {
        await close();
      }
    }
  });

  it('keeps the status ability count unfiltered', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([ability('visible', true), ability('write', false)]))
    );
    const { client, close } = await connect(true);
    try {
      const status = JSON.parse(text(await client.readResource({ uri: 'mainwp://status' })));
      expect(status.abilitiesCount).toBe(2);
    } finally {
      await close();
    }
  });

  it.each([
    ['marked destructive', { readonly: true, destructive: true }],
    ['without a destructive flag', { readonly: true }],
  ])('hides and denies a readonly ability %s', async (_label, annotations) => {
    fetchMock.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/run')
              ? { ok: true }
              : [{ ...ability('wipe', true), meta: { annotations } }, ability('visible', true)]
          )
        )
    );
    const { client, close } = await connect(true, { requireUserConfirmation: false });
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['visible_v1']);
      const result = await client.callTool({ name: 'wipe_v1', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('not allowed');
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/run'))).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('keeps categories unfiltered', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            { slug: 'mainwp-writes', label: 'Writes', description: 'Write operations' },
          ])
        )
    );
    const { client, close } = await connect(true);
    try {
      expect(text(await client.readResource({ uri: 'mainwp://categories' }))).toContain(
        'mainwp-writes'
      );
    } finally {
      await close();
    }
  });

  it('denies update dry runs even when safe mode permits previews', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              ...ability('update-all', false),
              meta: { annotations: { readonly: false, destructive: true } },
            },
          ])
        )
    );
    const { client, close } = await connect(true, { safeMode: true });
    try {
      const result = await client.callTool({ name: 'update_all_v1', arguments: { dry_run: true } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('not allowed');
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/run'))).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('uses the same error code for hidden and unknown tools', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([ability('hidden', false)]))
    );
    const { client, close } = await connect(true);
    try {
      for (const name of ['hidden_v1', 'unknown_v1']) {
        const help = JSON.parse(
          text(await client.readResource({ uri: `mainwp://help/tool/${name}` }))
        );
        const call = await client.callTool({ name, arguments: {} });
        expect(help.error.message).toBe(`Tool is not allowed: ${name}`);
        expect(JSON.parse((call.content as Array<{ text: string }>)[0].text).error).toEqual(
          help.error
        );
      }
    } finally {
      await close();
    }
  });

  it('suppresses a replacement whose annotation does not allow read-only access', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/run')
        ? new Response(
            JSON.stringify({
              code: 'moved',
              message: 'Use the replacement.',
              data: { status: 400, replacement: 'mainwp/write-v1' },
            }),
            { status: 400 }
          )
        : new Response(JSON.stringify([ability('visible', true), ability('write', false)]))
    );
    const { client, close } = await connect(true);
    try {
      const result = await client.callTool({ name: 'visible_v1', arguments: {} });
      expect(result.isError).toBe(true);
      expect(
        JSON.parse((result.content as Array<{ text: string }>)[0].text).error.data
      ).not.toHaveProperty('replacement');
    } finally {
      await close();
    }
  });
});
