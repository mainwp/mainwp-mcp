import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';
import { clearCache, initRateLimiter } from './abilities.js';
import { clearToolsCache } from './tools.js';
import { ConfigState } from './setup.js';
import { makeBaseConfig } from '../tests/helpers/config.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Minimal ability fixtures: one readonly tool and one destructive tool in a
// distinct category, so policy filtering is observable in names, category
// lists, and counts.
const sampleAbilities = [
  {
    name: 'mainwp/list-sites-v1',
    label: 'List Sites',
    description: 'Get all managed sites',
    category: 'mainwp-sites',
    input_schema: { type: 'object', properties: {} },
    meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
  },
  {
    name: 'mainwp/delete-site-v1',
    label: 'Delete Site',
    description: 'Delete a site from MainWP Dashboard',
    category: 'mainwp-danger',
    input_schema: { type: 'object', properties: { site_id: { type: 'integer' } } },
    meta: { annotations: { readonly: false, destructive: true, idempotent: false } },
  },
];

async function connectedClient(config = makeBaseConfig()) {
  const { server } = await createServer(config);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP request handlers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['site_id', 'all'],
    ['site_ids', '1,2'],
  ])('accepts prompt argument %s=%s through prompts/get', async (key, value) => {
    const { client, server } = await connectedClient();

    const result = await client.getPrompt({
      name: 'performance-check',
      arguments: { [key]: value },
    });

    expect(result.messages).not.toHaveLength(0);
    await client.close();
    await server.close();
  });

  it('returns INVALID_PARAMS for malformed prompt arguments through prompts/get', async () => {
    const { client, server } = await connectedClient();

    await expect(
      client.getPrompt({ name: 'performance-check', arguments: { site_id: 'not-an-id' } })
    ).rejects.toMatchObject({ code: -32602 });
    await client.close();
    await server.close();
  });

  it('blocks the site resource before get-site reaches /run', async () => {
    const { client, server } = await connectedClient({
      ...makeBaseConfig(),
      blockedTools: ['get_site_v1'],
    });

    const result = await client.readResource({ uri: 'mainwp://site/1' });

    expect(result.contents[0]).toMatchObject({ text: expect.stringContaining('not allowed') });
    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  // Fixture builder for the execution-stage gate tests: a get-site ability
  // whose annotations vary per test. `annotations: undefined` omits meta
  // entirely (the fail-closed default-destructive case).
  const getSiteAbility = (annotations?: Record<string, unknown>) => ({
    name: 'mainwp/get-site-v1',
    label: 'Get Site',
    description: 'Get details for one site',
    category: 'mainwp-sites',
    input_schema: { type: 'object', properties: { site_id: { type: 'integer' } } },
    ...(annotations === undefined ? {} : { meta: { annotations } }),
  });

  const runUrls = () =>
    mockFetch.mock.calls.map(call => String(call[0])).filter(url => url.includes('/run'));

  it('blocks the site resource in safe mode when get-site is annotated destructive', async () => {
    // Execution-stage gate regression (2026-07-17 adversarial review): the
    // resource must classify the resolved ability, not just check allow/block.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [getSiteAbility({ readonly: false, destructive: true, idempotent: false })],
      headers: new Headers(),
    });
    const { client, server } = await connectedClient({ ...makeBaseConfig(), safeMode: true });

    const result = await client.readResource({ uri: 'mainwp://site/1' });

    expect(result.contents[0]).toMatchObject({ text: expect.stringContaining('safe mode') });
    expect(runUrls()).toHaveLength(0);
    await client.close();
    await server.close();
  });

  it('denies the site resource fail-closed when annotations are missing', async () => {
    // Default config has requireUserConfirmation on; missing annotations
    // classify destructive, and resources have no confirmation channel.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [getSiteAbility(undefined)],
      headers: new Headers(),
    });
    const { client, server } = await connectedClient();

    const result = await client.readResource({ uri: 'mainwp://site/1' });

    expect(result.contents[0]).toMatchObject({ text: expect.stringContaining('confirmation') });
    expect(runUrls()).toHaveLength(0);
    await client.close();
    await server.close();
  });

  it('treats a malformed falsy destructive annotation as destructive on the site resource', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [getSiteAbility({ readonly: false, destructive: 0, idempotent: false })],
      headers: new Headers(),
    });
    const { client, server } = await connectedClient({ ...makeBaseConfig(), safeMode: true });

    const result = await client.readResource({ uri: 'mainwp://site/1' });

    expect(result.contents[0]).toMatchObject({ text: expect.stringContaining('safe mode') });
    expect(runUrls()).toHaveLength(0);
    await client.close();
    await server.close();
  });

  it('still serves the site resource for a readonly ability under safe mode', async () => {
    // Over-blocking guard: safe mode only gates destructive classification.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [getSiteAbility({ readonly: true, destructive: false, idempotent: true })],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: 'Site 1' }),
      headers: new Headers(),
    });
    const { client, server } = await connectedClient({ ...makeBaseConfig(), safeMode: true });

    const result = await client.readResource({ uri: 'mainwp://site/1' });

    const text = (result.contents as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({ id: 1, name: 'Site 1' });
    expect(runUrls()).toHaveLength(1);
    await client.close();
    await server.close();
  });

  it('skips site-id completions instead of executing a destructive-annotated list-sites', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          name: 'mainwp/list-sites-v1',
          label: 'List Sites',
          description: 'Get all managed sites',
          category: 'mainwp-sites',
          input_schema: { type: 'object', properties: {} },
          meta: { annotations: { readonly: false, destructive: true, idempotent: false } },
        },
      ],
      headers: new Headers(),
    });
    const { client, server } = await connectedClient({ ...makeBaseConfig(), safeMode: true });

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'performance-check' },
      argument: { name: 'site_id', value: '' },
    });

    expect(result.completion.values).toEqual([]);
    expect(runUrls()).toHaveLength(0);
    await client.close();
    await server.close();
  });

  it('blocks site completions before list-sites reaches /run', async () => {
    const { client, server } = await connectedClient({
      ...makeBaseConfig(),
      blockedTools: ['list_sites_v1'],
    });

    await expect(
      client.complete({
        ref: { type: 'ref/prompt', name: 'performance-check' },
        argument: { name: 'site_id', value: '' },
      })
    ).rejects.toMatchObject({ code: -32008 });

    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('fails closed when a destructive tool declares no confirm parameter', async () => {
    // End-to-end regression (2026-07-18 external audit): the delete-site-v1
    // fixture is destructive but its schema declares no confirm parameter.
    // This shape used to skip the confirmation flow and execute directly
    // with no preview, token, or approval.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    const { client, server } = await connectedClient();

    const result = await client.callTool({ name: 'delete_site_v1', arguments: { site_id: 1 } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('CONFIRMATION_UNSUPPORTED');
    expect(runUrls()).toHaveLength(0);
    await client.close();
    await server.close();
  });

  it('rejects a blocked tool call without leaking the ability name', async () => {
    const { client, server } = await connectedClient({
      ...makeBaseConfig(),
      blockedTools: ['delete_site_v1'],
    });

    const result = await client.callTool({ name: 'delete_site_v1', arguments: { site_id: 1 } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text) as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32008);
    expect(parsed.error.message).toContain('not allowed');
    expect(text).not.toContain('mainwp/delete-site-v1');
    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('keeps the catalog when one ability carries a non-string instructions value', async () => {
    // Regression (2026-07-18 external audit round 2): instructions: 42 threw
    // TypeError inside abilityToTool, and the ListTools catch turned that
    // into an empty tool catalog for the whole server.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          ...sampleAbilities[0],
          meta: {
            annotations: { readonly: true, destructive: false, idempotent: true, instructions: 42 },
          },
        },
        sampleAbilities[1],
      ],
      headers: new Headers(),
    });
    const { client, server } = await connectedClient();

    const result = await client.listTools();

    expect(result.tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['list_sites_v1', 'delete_site_v1'])
    );
    const listTool = result.tools.find(tool => tool.name === 'list_sites_v1');
    expect(listTool?.description).not.toContain('42');
    await client.close();
    await server.close();
  });

  it('bounds hostile instructions and schema text on the help and abilities resources', async () => {
    // Round-3 regression: bounding lived only in the tools/list conversion,
    // so mainwp://help/tool/{name} and mainwp://abilities returned 13KB
    // instructions and schema descriptions verbatim from the cache.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          ...sampleAbilities[0],
          input_schema: {
            type: 'object',
            properties: {
              site_id: { type: 'integer', description: 'S'.repeat(13000) },
            },
          },
          meta: {
            annotations: {
              readonly: true,
              destructive: false,
              idempotent: true,
              instructions: 'I'.repeat(13000),
            },
          },
        },
      ],
      headers: new Headers(),
    });
    const { client, server } = await connectedClient();

    const help = await client.readResource({ uri: 'mainwp://help/tool/list_sites_v1' });
    const abilities = await client.readResource({ uri: 'mainwp://abilities' });

    for (const result of [help, abilities]) {
      const text = (result.contents as Array<{ text: string }>)[0].text;
      expect(text).not.toContain('I'.repeat(301));
      expect(text).not.toContain('S'.repeat(501));
    }
    await client.close();
    await server.close();
  });

  it('drops non-string presentation annotations instead of letting them smuggle text', async () => {
    // Round-5 regression: an object-valued description bypassed the
    // string-only sanitize branch. The malformed annotations sit NESTED
    // (below the top-level backfill that masks them in tools/list) and the
    // assertions cover both tools/list and the raw mainwp://abilities
    // resource, which serves the cached schema verbatim.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          ...sampleAbilities[0],
          input_schema: {
            type: 'object',
            properties: {
              settings: {
                type: 'object',
                title: { smuggled: 42 },
                properties: {
                  role: {
                    type: 'string',
                    description: { payload: 'SAFE\nFAKE:‮ hidden' },
                    $comment: { alsoSmuggled: true },
                  },
                },
              },
            },
          },
        },
      ],
      headers: new Headers(),
    });
    const { client, server } = await connectedClient();

    const toolsResult = await client.listTools();
    const abilitiesResult = await client.readResource({ uri: 'mainwp://abilities' });

    expect(toolsResult.tools.map(tool => tool.name)).toContain('list_sites_v1');
    const surfaces = [
      JSON.stringify(toolsResult.tools[0].inputSchema),
      (abilitiesResult.contents as Array<{ text: string }>)[0].text,
    ];
    for (const text of surfaces) {
      expect(text).not.toContain('payload');
      expect(text).not.toContain('‮');
      expect(text).not.toContain('smuggled');
      expect(text).not.toContain('alsoSmuggled');
    }
    await client.close();
    await server.close();
  });

  it('bounds hostile category text on the categories resource', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          slug: 'mainwp-sites',
          label: 'L'.repeat(9000),
          description: 'D'.repeat(9000),
        },
      ],
      headers: new Headers(),
    });
    const { client, server } = await connectedClient();

    const result = await client.readResource({ uri: 'mainwp://categories' });

    const text = (result.contents as Array<{ text: string }>)[0].text;
    expect(text).toContain('mainwp-sites');
    expect(text).not.toContain('L'.repeat(201));
    expect(text).not.toContain('D'.repeat(501));
    await client.close();
    await server.close();
  });

  it('omits blocked tools from tools/list', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    const { client, server } = await connectedClient({
      ...makeBaseConfig(),
      blockedTools: ['delete_site_v1'],
    });

    const result = await client.listTools();

    const names = result.tools.map(tool => tool.name);
    expect(names).toContain('list_sites_v1');
    expect(names).not.toContain('delete_site_v1');
    await client.close();
    await server.close();
  });

  it('blocks tool-help for a blocked tool before ability resolution', async () => {
    // Scope-2 regression: fails against pre-refactor main, where the
    // mainwp://help/tool/{name} branch resolved abilities with no policy check.
    const { client, server } = await connectedClient({
      ...makeBaseConfig(),
      blockedTools: ['delete_site_v1'],
    });

    const result = await client.readResource({ uri: 'mainwp://help/tool/delete_site_v1' });

    expect(result.contents[0]).toMatchObject({ text: expect.stringContaining('not allowed') });
    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('still reports resource-not-found for an unknown tool-help under an open policy', async () => {
    // Guard: the blocked-vs-nonexistent collapse applies only to
    // policy-excluded tools, not to every miss.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    const { client, server } = await connectedClient();

    const result = await client.readResource({ uri: 'mainwp://help/tool/nonexistent_tool' });

    const text = (result.contents as Array<{ text: string }>)[0].text;
    expect(text).toContain('Resource not found');
    expect(text).not.toContain('not allowed');
    await client.close();
    await server.close();
  });

  it('redacts blocked tools from the mainwp://abilities resource', async () => {
    // Scope-3 behavior change (2026-07-17): informational resources honor
    // allowedTools/blockedTools instead of describing the full catalog.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    const { client, server } = await connectedClient({
      ...makeBaseConfig(),
      blockedTools: ['delete_site_v1'],
    });

    const result = await client.readResource({ uri: 'mainwp://abilities' });

    const abilities = JSON.parse((result.contents as Array<{ text: string }>)[0].text) as Array<{
      name: string;
    }>;
    const names = abilities.map(ability => ability.name);
    expect(names).toContain('mainwp/list-sites-v1');
    expect(names).not.toContain('mainwp/delete-site-v1');
    await client.close();
    await server.close();
  });

  it('redacts blocked tools from the mainwp://help document', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    const { client, server } = await connectedClient({
      ...makeBaseConfig(),
      blockedTools: ['delete_site_v1'],
    });

    const result = await client.readResource({ uri: 'mainwp://help' });

    const text = (result.contents as Array<{ text: string }>)[0].text;
    const helpDoc = JSON.parse(text) as {
      overview: { totalTools: number; categories: string[] };
    };
    expect(helpDoc.overview.totalTools).toBe(sampleAbilities.length - 1);
    expect(helpDoc.overview.categories).not.toContain('mainwp-danger');
    expect(text).not.toContain('delete_site_v1');
    expect(text).toContain('list_sites_v1');
    await client.close();
    await server.close();
  });
});

describe('setup mode handlers', () => {
  const savedEnv = new Map<string, string | undefined>();
  let root: string;
  let home: string;
  let cwd: string;

  // Individual keys, never a wholesale process.env replacement: os.homedir()
  // reads the real environment, and the settings writer follows it.
  function setEnv(key: string, value: string | undefined): void {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  function unconfiguredState(): ConfigState {
    const {
      dashboardUrl: _dashboardUrl,
      authType: _authType,
      username: _username,
      appPassword: _appPassword,
      apiToken: _apiToken,
      ...policy
    } = makeBaseConfig();
    return ConfigState.fromResolution({
      status: 'unconfigured',
      missing: 'credentials',
      message: 'Authentication required',
      policy,
    });
  }

  async function connectState(state: ConfigState) {
    const { server } = await createServer(state);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearToolsCache();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    savedEnv.clear();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MAINWP_')) setEnv(key, undefined);
    }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcp-setup-mode-'));
    home = path.join(root, 'home');
    cwd = path.join(root, 'cwd');
    fs.mkdirSync(home);
    fs.mkdirSync(cwd);
    setEnv('HOME', home);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    // The configure test writes a credential file into this tree, so it cannot
    // be left in the OS temp directory. Removed after the env and cwd mocks are
    // restored, so nothing still resolves paths inside it.
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists only the setup tools while unconfigured', async () => {
    const { client, server } = await connectState(unconfiguredState());

    const result = await client.listTools();

    expect(result.tools.map(tool => tool.name)).toEqual([
      'mainwp_get_setup_status',
      'mainwp_configure',
    ]);
    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('denies a direct call to a Dashboard tool name while unconfigured', async () => {
    // Execution boundary, not a listing filter: a client replaying a name it
    // remembers from an earlier session must not reach the ability path.
    const { client, server } = await connectState(unconfiguredState());

    const result = await client.callTool({ name: 'list_sites_v1', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('not_configured');
    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('returns empty or safe results from every other surface while unconfigured', async () => {
    const { client, server } = await connectState(unconfiguredState());

    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect((await client.listPrompts()).prompts).toEqual([]);

    const resource = await client.readResource({ uri: 'mainwp://abilities' });
    expect((resource.contents as Array<{ text: string }>)[0].text).toContain('not_configured');

    const completion = await client.complete({
      ref: { type: 'ref/prompt', name: 'performance-check' },
      argument: { name: 'site_id', value: '' },
    });
    expect(completion.completion.values).toEqual([]);

    await expect(
      client.getPrompt({ name: 'performance-check', arguments: {} })
    ).rejects.toMatchObject({ code: -32008 });

    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('swaps to the full tool surface after a successful configure', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    const { client, server } = await connectState(unconfiguredState());
    const changed: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed.push('tools');
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      changed.push('resources');
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      changed.push('prompts');
    });

    const configured = await client.callTool({
      name: 'mainwp_configure',
      arguments: {
        dashboard_url: 'https://dashboard.example.com',
        username: 'admin',
        application_password: 'abcd efgh ijkl mnop qrst uvwx',
      },
    });

    expect(configured.isError).toBeUndefined();
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['list_sites_v1', 'delete_site_v1']));
    expect(names).not.toContain('mainwp_configure');
    expect(names).not.toContain('mainwp_get_setup_status');
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
    expect((await client.listResources()).resources.length).toBeGreaterThan(0);
    expect(changed).toEqual(['tools', 'resources', 'prompts']);

    const listed = await client.callTool({ name: 'list_sites_v1', arguments: {} });
    expect(listed.isError).toBeUndefined();

    await client.close();
    await server.close();
  });

  it('refuses configure once the server is connected', async () => {
    const { client, server } = await connectState(ConfigState.fromConfig(makeBaseConfig()));

    const result = await client.callTool({
      name: 'mainwp_configure',
      arguments: {
        dashboard_url: 'https://dashboard.example.com',
        username: 'admin',
        application_password: 'abcd efgh ijkl mnop qrst uvwx',
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('ALREADY_CONFIGURED');
    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('keeps the setup tools listed in the degraded state', async () => {
    const state = ConfigState.fromConfig(makeBaseConfig());
    state.markDegraded('Network error: Cannot reach MAINWP_URL.');
    const { client, server } = await connectState(state);

    const result = await client.listTools();

    expect(result.tools.map(tool => tool.name)).toEqual([
      'mainwp_get_setup_status',
      'mainwp_configure',
    ]);
    await client.close();
    await server.close();
  });
});
