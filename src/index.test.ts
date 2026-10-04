import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createServer,
  createStdioTransport,
  SERVER_INSTRUCTIONS,
  STDIO_MAX_BUFFER_SIZE,
} from './index.js';
import { MAX_DECLARED_STRING_LENGTH, clearKnownSecrets } from './security.js';
import { clearCache, fetchAbilities, initRateLimiter, type Ability } from './abilities.js';
import type { Config } from './config.js';
import { clearToolsCache } from './tools.js';
import { ConfigState, checkStartupCredentials } from './setup.js';
import { trustedSettingsPath } from './settings-writer.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

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

describe('validated upstream 4xx through MCP handlers', () => {
  const original: Ability = {
    ...sampleAbilities[0],
    name: 'mainwp/set-ignored-updates-v1',
    input_schema: {
      type: 'object',
      properties: { private_value: { type: 'string', writeOnly: true } },
    },
    meta: { annotations: { readonly: false, destructive: false, idempotent: true } },
  };
  const replacement: Ability = {
    ...sampleAbilities[1],
    name: 'mainwp/unignore-site-updates-v1',
  };
  const moved = {
    code: 'mainwp_unignore_moved',
    message:
      'Removing an item from the ignored list needs confirmation. Use mainwp/unignore-site-updates-v1.',
    data: { status: 400, replacement: replacement.name },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearToolsCache();
    clearKnownSecrets();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    clearKnownSecrets();
    vi.restoreAllMocks();
  });

  async function call(
    body: unknown,
    status = 400,
    overrides: Partial<Config> = {},
    abilities = [original, replacement],
    args: Record<string, unknown> = {}
  ) {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(abilities)));
    mockFetch.mockResolvedValueOnce(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        statusText: status >= 500 ? 'Server Error' : 'Bad Request',
      })
    );
    const { client, server } = await connectedClient(makeBaseConfig(overrides));
    try {
      const result = await client.callTool({ name: 'set_ignored_updates_v1', arguments: args });
      const text = (result.content as Array<{ text: string }>)[0].text;
      return { result, text, parsed: JSON.parse(text) };
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('keeps mainwp_confirmation_required as SERVER_ERROR with sanitized text', async () => {
    const { result, parsed } = await call({
      code: 'mainwp_confirmation_required',
      message: 'Needs\u0000 confirmation\u202e. /Users/alice/private.txt password=exposed',
      data: { status: 400, extra: 'never copied' },
    });
    expect(result.isError).toBe(true);
    expect(parsed.error).toEqual({
      code: -32000,
      message:
        'Ability execution failed: mainwp_confirmation_required - Needs confirmation . [path] password=[redacted]',
      data: { upstream_code: 'mainwp_confirmation_required' },
    });
  });

  it.each([false, true])(
    'converts an allowed replacement from the original snapshot (safeMode=%s)',
    async safeMode => {
      const { result, parsed } = await call(moved, 400, { safeMode });
      expect(result.isError).toBe(true);
      expect(parsed.error.code).toBe(-32000);
      expect(parsed.error.data).toEqual({
        upstream_code: moved.code,
        replacement: 'unignore_site_updates_v1',
      });
    }
  );

  it.each([
    { label: 'blockedTools', overrides: { blockedTools: ['unignore_site_updates_v1'] } },
    { label: 'allowedTools', overrides: { allowedTools: ['set_ignored_updates_v1'] } },
    { label: 'unknown', name: 'mainwp/missing-v1' },
    { label: 'unconfigured namespace', name: 'other/unignore-site-updates-v1' },
    { label: 'malformed', name: 'mainwp/../unignore-site-updates-v1' },
    { label: 'non-string', name: 123 },
  ])(
    'omits a replacement excluded by $label without dropping the error',
    async ({ overrides, name }) => {
      const { result, parsed } = await call(
        { ...moved, data: { status: 400, replacement: name ?? replacement.name } },
        400,
        overrides
      );
      expect(result.isError).toBe(true);
      expect(parsed.error.code).toBe(-32000);
      expect(parsed.error.data).toEqual({ upstream_code: moved.code });
    }
  );

  it('uses the configured primary namespace for a secondary replacement', async () => {
    const secondary = { ...replacement, name: 'acme/unignore-site-updates-v1' };
    const { parsed } = await call(
      { ...moved, data: { replacement: secondary.name } },
      400,
      { abilityNamespaces: ['mainwp', 'acme'] },
      [original, secondary]
    );
    expect(parsed.error.data.replacement).toBe('acme__unignore_site_updates_v1');
  });

  it.each([true, false])(
    'binds replacement lookup to the original snapshot (initially present=%s)',
    async present => {
      const config = makeBaseConfig();
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(present ? [original, replacement] : [original]))
      );
      mockFetch.mockImplementationOnce(async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify(present ? [original] : [original, replacement]))
        );
        await fetchAbilities(config, true);
        return new Response(JSON.stringify(moved), { status: 400 });
      });
      const { client, server } = await connectedClient(config);
      try {
        const result = await client.callTool({ name: 'set_ignored_updates_v1', arguments: {} });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(parsed.error.data.upstream_code).toBe(moved.code);
        expect(parsed.error.data.replacement).toBe(
          present ? 'unignore_site_updates_v1' : undefined
        );
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        await client.close();
        await server.close();
      }
    }
  );

  it.each(['credential', 'write-only'])(
    'omits reflected %s metadata and keeps the secret out of output',
    async kind => {
      const secret = 'reflectedprivate';
      const { result, text, parsed } = await call(
        {
          code: `mainwp_${secret}`,
          message: `Rejected ${secret}`,
          data: { replacement: `mainwp/${secret}-v1` },
        },
        400,
        kind === 'credential' ? { appPassword: secret } : {},
        [original, { ...replacement, name: `mainwp/${secret}-v1` }],
        kind === 'write-only' ? { private_value: secret } : {}
      );
      expect(result.isError).toBe(true);
      expect(parsed.error.code).toBe(-32000);
      expect(parsed.error.data).toBeUndefined();
      expect(text).not.toContain(secret);
      if (kind === 'write-only')
        expect(parsed.error.message).toContain('upstream message is withheld');
    }
  );

  it('omits a registered secret in the replacement while preserving upstream_code', async () => {
    const { text, parsed } = await call(moved, 400, { appPassword: 'unignore-site' });
    expect(parsed.error.data).toEqual({ upstream_code: moved.code });
    expect(text).not.toContain('unignore-site');
  });

  it('omits a write-only replacement while preserving an unrelated upstream_code', async () => {
    const { text, parsed } = await call(
      { ...moved, code: 'mainwp_confirmation_required' },
      400,
      {},
      undefined,
      { private_value: 'unignore' }
    );
    expect(parsed.error.data).toEqual({ upstream_code: 'mainwp_confirmation_required' });
    expect(text).not.toContain('unignore');
    expect(parsed.error.message).toContain('upstream message is withheld');
  });

  it('redacts a registered password spanning the message cap', async () => {
    const secret = 'abcd efgh ijkl mnop qrst uvwx';
    const { text, parsed } = await call(
      {
        code: 'mainwp_confirmation_required',
        message: `${'x'.repeat(450)} ${secret}${'x'.repeat(10000)}`,
      },
      400,
      { appPassword: secret }
    );
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.message.length).toBeLessThanOrEqual(500);
    expect(text).not.toContain('abcd');
    expect(parsed.error.data.upstream_code).toBe('mainwp_confirmation_required');
  });

  it('ignores hostile __proto__ and constructor data without copying it', async () => {
    const { parsed } = await call(
      '{"code":"mainwp_unignore_moved","message":"Rejected","__proto__":{"code":"rest_no_route"},"constructor":{"polluted":true},"data":{"replacement":"mainwp/unignore-site-updates-v1","__proto__":{"polluted":true},"constructor":"bad","status":400,"extra":"bad"}}'
    );
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.data).toEqual({
      upstream_code: moved.code,
      replacement: 'unignore_site_updates_v1',
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it.each([
    { label: 'array', body: [], code: -32603 },
    { label: 'null', body: null, code: -32603 },
    { label: 'number', body: 42, code: -32603 },
    { label: 'unparseable', body: '{invalid json', code: -32602 },
    {
      label: '__proto__ only',
      body: '{"__proto__":{"code":"mainwp_confirmation_required","message":"invalid"}}',
      code: -32603,
    },
    {
      label: 'data array',
      body: { code: 'mainwp_confirmation_required', message: 'invalid input', data: [] },
      code: -32602,
    },
    {
      label: 'data string',
      body: { code: 'mainwp_confirmation_required', message: 'invalid input', data: 'bad' },
      code: -32602,
    },
    {
      label: 'data null',
      body: { code: 'mainwp_confirmation_required', message: 'invalid input', data: null },
      code: -32602,
    },
    {
      label: 'invalid slug',
      body: { code: 'unsafe/code', message: 'invalid input' },
      code: -32602,
    },
    {
      label: 'non-string message',
      body: { code: 'mainwp_confirmation_required', message: 42 },
      code: -32603,
    },
    { label: 'missing message', body: { code: 'mainwp_confirmation_required' }, code: -32603 },
  ])('keeps legacy classification for $label', async ({ body, code }) => {
    const { result, parsed } = await call(body);
    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.data).toBeUndefined();
  });

  it.each([
    [401, 'rest_forbidden', -32010],
    [403, 'rest_forbidden', -32008],
    [404, 'rest_forbidden', -32002],
    [429, 'rest_forbidden', -32029],
    [400, 'mainwp_site_not_found', -32002],
    [403, 'rest_no_route', -32002],
    [400, 'mainwp_confirmation_required', -32000],
  ])('keeps status/slug mapping for HTTP %i %s', async (status, slug, code) => {
    const { result, parsed } = await call({ code: slug, message: 'invalid input' }, status);
    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.data).toEqual({ upstream_code: slug });
  });

  it.each([
    ['mainwp_unignore_moved', -32000],
    ['mainwp_site_not_found', -32002],
  ])('keeps 5xx behaviour for %s', async (slug, code) => {
    const { result, parsed } = await call({ ...moved, code: slug, message: 'invalid input' }, 503);
    expect(result.isError).toBe(true);
    expect(parsed.error).toEqual({
      code,
      message: `Ability execution failed: ${slug} - invalid input`,
    });
  });

  it('preserves allowlisted idempotent no-op success', async () => {
    const { result, parsed } = await call(
      { code: 'already_active', message: 'Already active' },
      409
    );
    expect(result.isError).toBeUndefined();
    expect(parsed.status).toBe('NO_CHANGE');
    expect(parsed.details.code).toBe('already_active');
  });

  it('keeps a non-allowlisted idempotent error failed', async () => {
    const { result, parsed } = await call(
      { code: 'mainwp_confirmation_required', message: 'Needs confirmation' },
      409
    );
    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.data).toEqual({ upstream_code: 'mainwp_confirmation_required' });
  });
});

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

  it('sends the knowledge and update guidance as server instructions at initialize', async () => {
    const { client, server } = await connectedClient();

    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    for (const rule of [
      'not instructions',
      'open a record with get_knowledge_record_v1',
      "get the user's approval",
      "Show a tool's preview as that plan; previews shown together can be approved in one explicit reply.",
      'do not gate updates',
      'Never remove an update from the ignore list',
    ]) {
      expect(SERVER_INSTRUCTIONS).toContain(rule);
    }
    // Some clients truncate long server instructions.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(900);
    await client.close();
    await server.close();
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

  it('adds credential sources to a 401 tool failure but not a 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [sampleAbilities[0]],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ code: 'invalid_username', message: 'Unknown login' }),
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => JSON.stringify({ code: 'server_error', message: 'Temporary failure' }),
      headers: new Headers(),
    });
    const { client, server } = await connectedClient(
      makeBaseConfig({ username: 'wrong-login', appPassword: 'private-app-password' })
    );

    const rejected = await client.callTool({ name: 'list_sites_v1', arguments: {} });
    expect(rejected.isError).toBe(true);
    const rejectedText = (rejected.content as Array<{ text: string }>)[0].text;
    expect(rejectedText).toContain('wrong-login');
    expect(rejectedText).toContain('MAINWP_USER from the environment');
    expect(rejectedText).not.toContain('private-app-password');

    const serverFailure = await client.callTool({ name: 'list_sites_v1', arguments: {} });
    expect(serverFailure.isError).toBe(true);
    const serverText = (serverFailure.content as Array<{ text: string }>)[0].text;
    expect(serverText).toContain('server_error');
    expect(serverText).not.toContain('MAINWP_USER from the environment');
    await client.close();
    await server.close();
  });

  it('names the rejected user in the tools/list log for a 401 but not a 500', async () => {
    const { client, server } = await connectedClient(
      makeBaseConfig({ username: 'wrong-login', appPassword: 'private-app-password' })
    );
    const logged: string[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
      logged.push(JSON.stringify(notification.params.data));
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ code: 'invalid_username', message: 'Unknown login' }),
      headers: new Headers(),
    });
    expect((await client.listTools()).tools).toEqual([]);
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toContain('wrong-login');
    expect(logged[0]).toContain('MAINWP_USER from the environment');
    expect(logged[0]).not.toContain('private-app-password');

    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => JSON.stringify({ code: 'server_error', message: 'Temporary failure' }),
      headers: new Headers(),
    });
    expect((await client.listTools()).tools).toEqual([]);
    await vi.waitFor(() => expect(logged).toHaveLength(2));
    expect(logged[1]).toContain('Error listing tools');
    expect(logged[1]).not.toContain('MAINWP_USER from the environment');
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

  it('sends the site resource id as site_id_or_domain', async () => {
    // get-site-v1 requires site_id_or_domain; the Dashboard rejects a
    // request that carries site_id instead.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ...getSiteAbility({ readonly: true, destructive: false, idempotent: true }),
          input_schema: {
            type: 'object',
            properties: { site_id_or_domain: { type: ['integer', 'string'] } },
            required: ['site_id_or_domain'],
          },
        },
      ],
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 7, name: 'Site 7' }),
      headers: new Headers(),
    });
    const { client, server } = await connectedClient();

    const result = await client.readResource({ uri: 'mainwp://site/7' });

    const text = (result.contents as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({ id: 7, name: 'Site 7' });
    expect(runUrls()).toHaveLength(1);
    expect(runUrls()[0]).toContain('input[site_id_or_domain]=7');
    expect(runUrls()[0]).not.toContain('input[site_id]');
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

  it("accepts a string up to the tool's declared maxLength through tools/call", async () => {
    // Issue #74: a third-party ability taking a plugin ZIP as base64 declares
    // maxLength 34952536, but the server capped every string at 10000.
    const uploadAbility = {
      name: 'mainwp/upload-package-v1',
      label: 'Upload Package',
      description: 'Upload a plugin package',
      category: 'mainwp-plugins',
      input_schema: {
        type: 'object',
        properties: { package_base64: { type: 'string', maxLength: 34952536 } },
      },
      meta: { annotations: { readonly: false, destructive: false, idempotent: false } },
    };
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.includes('/run') ? { uploaded: true } : [uploadAbility]),
      headers: new Headers(),
    }));
    const { client, server } = await connectedClient();
    const payload = 'A'.repeat(100000);

    const result = await client.callTool({
      name: 'upload_package_v1',
      arguments: { package_base64: payload },
    });

    expect(result.isError).toBeFalsy();
    const runCall = mockFetch.mock.calls.find(call => String(call[0]).includes('/run'));
    expect(JSON.parse(runCall?.[1].body)).toEqual({ input: { package_base64: payload } });

    const tooLong = await client.callTool({
      name: 'upload_package_v1',
      arguments: { package_base64: 'A'.repeat(34952537) },
    });
    expect(tooLong.isError).toBe(true);
    expect((tooLong.content as Array<{ text: string }>)[0].text).toContain(
      '34952536 characters, from the tool schema'
    );
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

describe('stdio transport buffer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sizes the read buffer for the largest string validation can accept', async () => {
    expect(STDIO_MAX_BUFFER_SIZE).toBeGreaterThan(MAX_DECLARED_STRING_LENGTH);
    const stdin = new PassThrough();
    const transport = createStdioTransport(stdin, new PassThrough());
    const failure = new Promise<Error>(resolve => {
      transport.onerror = resolve;
    });
    await transport.start();

    stdin.write(Buffer.alloc(STDIO_MAX_BUFFER_SIZE + 1, 0x41));

    expect((await failure).message).toBe(
      `ReadBuffer exceeded maximum size of ${STDIO_MAX_BUFFER_SIZE} bytes`
    );
  });

  it('returns a validation error for an oversized string instead of dropping the connection', async () => {
    // A 20M-character string is over the SDK's 10 MiB default, so before the
    // buffer was raised this message closed the transport with no response.
    const declared = 20_000_000;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          name: 'mainwp/upload-package-v1',
          label: 'Upload Package',
          description: 'Upload a plugin package',
          category: 'mainwp-plugins',
          input_schema: {
            type: 'object',
            properties: { package_base64: { type: 'string', maxLength: declared } },
          },
          meta: { annotations: { readonly: false, destructive: false, idempotent: false } },
        },
      ],
      headers: new Headers(),
    });
    const { server } = await createServer(makeBaseConfig());
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const response = new Promise<{ result: { isError: boolean; content: { text: string }[] } }>(
      (resolve, reject) => {
        let buffered = '';
        stdout.on('data', chunk => {
          buffered += String(chunk);
          // Only complete lines are messages; a chunk may end mid-line.
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines.filter(Boolean)) {
            const message = JSON.parse(line);
            if (message.id === 2) resolve(message);
          }
        });
        server.onclose = () => reject(new Error('transport closed'));
      }
    );
    await server.connect(createStdioTransport(stdin, stdout));

    const send = (message: unknown) => stdin.write(JSON.stringify(message) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'upload_package_v1',
        arguments: { package_base64: 'A'.repeat(declared + 1) },
      },
    });

    const { result } = await response;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`${declared} characters, from the tool schema`);
    expect(mockFetch.mock.calls.map(call => String(call[0]))).not.toContainEqual(
      expect.stringContaining('/run')
    );
    await server.close();
  }, 30_000);
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

  async function startupState(config = makeBaseConfig()): Promise<ConfigState> {
    const state = ConfigState.fromConfig(config);
    await checkStartupCredentials(state, config, makeMockLogger());
    return state;
  }

  function toolText(result: unknown): string {
    return (result as { content: Array<{ text: string }> }).content[0].text;
  }

  function setupStatus(text: string): Record<string, unknown> {
    return JSON.parse(text) as Record<string, unknown>;
  }

  function rejectedResponse(code: string) {
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ code, message: 'Authentication failed' }),
      headers: new Headers(),
    };
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
    const state = unconfiguredState();
    const { client, server } = await connectState(state);
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
    expect(state.retainedConfig?.connectionSources).toEqual({
      MAINWP_URL: 'settings.json',
      MAINWP_USER: 'settings.json',
      MAINWP_APP_PASSWORD: 'settings.json',
    });

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

    // Degraded keeps the operator's config retained, so the execution boundary
    // has to hold on its own rather than on the config being absent.
    const denied = await client.callTool({ name: 'list_sites_v1', arguments: {} });

    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0].text).toContain('not_configured');
    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('shows the wrong env username and its source after startup rejection', async () => {
    mockFetch.mockResolvedValueOnce(rejectedResponse('invalid_username'));
    const config = makeBaseConfig({ username: 'Display Name' });
    const state = await startupState(config);
    const { client, server } = await connectState(state);

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'mainwp_get_setup_status',
      'mainwp_configure',
    ]);
    const status = setupStatus(
      toolText(await client.callTool({ name: 'mainwp_get_setup_status' }))
    );
    expect(status).toMatchObject({
      state: 'credentials_rejected',
      dashboardHost: 'test.local',
      username: 'Display Name',
      connectionSources: config.connectionSources,
      overriddenSettingsKeys: [],
    });
    expect(status.problem).toContain('MAINWP_USER from the environment');
    expect(status.problem).toContain('login name or email address, not the display name');
    expect(status.problem).not.toContain('overrides a different value');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await client.close();
    await server.close();
  });

  it('names an env username that overrode a different settings.json value', async () => {
    mockFetch.mockResolvedValueOnce(rejectedResponse('invalid_username'));
    const config = makeBaseConfig({
      username: 'env-user',
      connectionSources: {
        MAINWP_URL: 'settings.json',
        MAINWP_USER: 'env',
        MAINWP_APP_PASSWORD: 'settings.json',
      },
      overriddenSettingsKeys: ['MAINWP_USER'],
    });
    const state = await startupState(config);
    const { client, server } = await connectState(state);

    const status = setupStatus(
      toolText(await client.callTool({ name: 'mainwp_get_setup_status' }))
    );
    expect(status).toMatchObject({
      state: 'credentials_rejected',
      overriddenSettingsKeys: ['MAINWP_USER'],
    });
    expect(status.problem).toContain(
      'MAINWP_USER from the environment overrides a different value in settings.json; correcting only the file has no effect.'
    );
    await client.close();
    await server.close();
  });

  it('shows the wrong application password after startup rejection', async () => {
    mockFetch.mockResolvedValueOnce(rejectedResponse('incorrect_password'));
    const config = makeBaseConfig({ appPassword: 'private-app-password' });
    const state = await startupState(config);
    const { client, server } = await connectState(state);

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'mainwp_get_setup_status',
      'mainwp_configure',
    ]);
    const statusText = toolText(await client.callTool({ name: 'mainwp_get_setup_status' }));
    const status = setupStatus(statusText);
    expect(status).toMatchObject({ state: 'credentials_rejected', username: 'admin' });
    expect(status.problem).toContain('MAINWP_APP_PASSWORD from the environment');
    expect(statusText).not.toContain(config.appPassword);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await client.close();
    await server.close();
  });

  it('keeps a network failure degraded and marks a rejected retry', async () => {
    mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND test.local'));
    const state = await startupState();
    const { client, server } = await connectState(state);

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'mainwp_get_setup_status',
      'mainwp_configure',
    ]);
    mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND test.local'));
    const networkStatus = setupStatus(
      toolText(await client.callTool({ name: 'mainwp_get_setup_status' }))
    );
    expect(networkStatus).toMatchObject({ state: 'degraded', dashboardHost: 'test.local' });
    expect(networkStatus.problem).toContain('Network error');

    mockFetch.mockResolvedValueOnce(rejectedResponse('invalid_username'));
    const rejectedStatus = setupStatus(
      toolText(await client.callTool({ name: 'mainwp_get_setup_status' }))
    );
    expect(rejectedStatus).toMatchObject({ state: 'credentials_rejected', username: 'admin' });
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'mainwp_get_setup_status',
      'mainwp_configure',
    ]);
    await client.close();
    await server.close();
  });

  it('lists MainWP tools after valid startup and diagnoses a later 401', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });
    const state = await startupState();
    const { client, server } = await connectState(state);

    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('list_sites_v1');
    expect(names).not.toContain('mainwp_get_setup_status');
    const status = setupStatus(
      toolText(await client.callTool({ name: 'mainwp_get_setup_status' }))
    );
    expect(status.state).toBe('ready');

    mockFetch.mockResolvedValueOnce(rejectedResponse('invalid_username'));
    const result = await client.callTool({ name: 'list_sites_v1', arguments: {} });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('MAINWP_USER from the environment');
    await client.close();
    await server.close();
  });

  it('does not retry a rejected login when setup status is requested again', async () => {
    mockFetch.mockResolvedValueOnce(rejectedResponse('invalid_username'));
    const state = await startupState();
    const { client, server } = await connectState(state);
    mockFetch.mockClear();

    for (let attempt = 0; attempt < 2; attempt++) {
      const status = setupStatus(
        toolText(await client.callTool({ name: 'mainwp_get_setup_status' }))
      );
      expect(status.state).toBe('credentials_rejected');
    }
    expect(mockFetch).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it('refuses configure while degraded and after the Dashboard rejected the credentials', async () => {
    const state = ConfigState.fromConfig(makeBaseConfig());
    state.markDegraded('Network error: Cannot reach MAINWP_URL.');
    const { client, server } = await connectState(state);
    const arguments_ = {
      dashboard_url: 'https://dashboard.example.com',
      username: 'correct-login',
      application_password: 'abcd efgh ijkl mnop qrst uvwx',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const degraded = await client.callTool({ name: 'mainwp_configure', arguments: arguments_ });
    expect(degraded.isError).toBe(true);
    expect(toolText(degraded)).toContain('ALREADY_CONFIGURED');

    state.markRejected('The Dashboard rejected the credentials');
    const rejected = await client.callTool({ name: 'mainwp_configure', arguments: arguments_ });

    expect(rejected.isError).toBe(true);
    expect(toolText(rejected)).toContain('ALREADY_CONFIGURED');
    expect(state.state).toBe('credentials_rejected');
    expect(state.retainedConfig?.username).toBe('admin');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(false);
    await client.close();
    await server.close();
  });

  it('offers no chat paste after a startup rejection and keeps configure refused', async () => {
    mockFetch.mockResolvedValueOnce(rejectedResponse('incorrect_password'));
    const state = await startupState();
    const { client, server } = await connectState(state);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => sampleAbilities,
      headers: new Headers(),
    });

    const status = setupStatus(
      toolText(await client.callTool({ name: 'mainwp_get_setup_status' }))
    );
    expect(status.state).toBe('credentials_rejected');
    expect(status).not.toHaveProperty('chatSetupAvailable');
    expect(String(status.guidance)).not.toMatch(/paste/i);
    expect(String(status.relayInstructions)).toContain('Do not ask for credentials in chat');

    const result = await client.callTool({
      name: 'mainwp_configure',
      arguments: {
        dashboard_url: 'https://dashboard.example.com',
        username: 'correct-login',
        application_password: 'abcd efgh ijkl mnop qrst uvwx',
      },
    });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('ALREADY_CONFIGURED');
    expect(toolText(result)).toContain('which user was rejected');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'mainwp_get_setup_status',
      'mainwp_configure',
    ]);
    await client.close();
    await server.close();
  });
});
