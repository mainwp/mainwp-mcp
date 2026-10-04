import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';
import { clearCache, initRateLimiter, type Ability } from './abilities.js';
import {
  capturePreviewToken,
  clearPendingPreviews,
  getPendingPreviewCounts,
} from './confirmation.js';
import { clearToolsCache } from './tools.js';
import { clearKnownSecrets } from './security.js';
import { resetSessionData } from './session.js';
import { MCP_ERROR_CODES } from './errors.js';
import { abilityNameToToolName } from './naming.js';
import { makeBaseConfig } from '../tests/helpers/config.js';

const upstreamToken = 'example_preview_token_0123456789';
const differentToken = 'different_preview_token_0123456789';
const updateAbilityNames = [
  'mainwp/run-updates-v1',
  'mainwp/update-all-v1',
  'mainwp/update-site-core-v1',
  'mainwp/update-site-plugins-v1',
  'mainwp/update-site-themes-v1',
  'mainwp/update-site-translations-v1',
];

describe('capturePreviewToken', () => {
  const tokenSchema = { type: ['string', 'null'] };
  const rows: Array<[string, unknown, Record<string, unknown>, string | undefined]> = [
    ['valid token', { preview_token: upstreamToken }, tokenSchema, upstreamToken],
    [
      'own token on null prototype',
      Object.assign(Object.create(null), { preview_token: upstreamToken }),
      tokenSchema,
      upstreamToken,
    ],
    [
      'allowed punctuation',
      { preview_token: 'Aa09._~-'.repeat(2) },
      tokenSchema,
      'Aa09._~-'.repeat(2),
    ],
    ['missing token', {}, tokenSchema, undefined],
    ['null token', { preview_token: null }, tokenSchema, undefined],
    ['boolean token', { preview_token: true }, tokenSchema, undefined],
    ['number token', { preview_token: 1234567890123456 }, tokenSchema, undefined],
    ['array token', { preview_token: [upstreamToken] }, tokenSchema, undefined],
    ['object token', { preview_token: { value: upstreamToken } }, tokenSchema, undefined],
    ['null result', null, tokenSchema, undefined],
    ['array result', [{ preview_token: upstreamToken }], tokenSchema, undefined],
    ['string result', upstreamToken, tokenSchema, undefined],
    ['number result', 1, tokenSchema, undefined],
    ['boolean result', true, tokenSchema, undefined],
    ['inherited token', Object.create({ preview_token: upstreamToken }), tokenSchema, undefined],
    [
      'token under __proto__',
      JSON.parse(`{"__proto__":{"preview_token":"${upstreamToken}"}}`),
      tokenSchema,
      undefined,
    ],
    [
      'token under constructor',
      { constructor: { preview_token: upstreamToken } },
      tokenSchema,
      undefined,
    ],
    ['15 characters', { preview_token: 'a'.repeat(15) }, tokenSchema, undefined],
    ['16 characters', { preview_token: 'a'.repeat(16) }, tokenSchema, 'a'.repeat(16)],
    ['256 characters', { preview_token: 'a'.repeat(256) }, tokenSchema, 'a'.repeat(256)],
    ['257 characters', { preview_token: 'a'.repeat(257) }, tokenSchema, undefined],
    ['empty token', { preview_token: '' }, tokenSchema, undefined],
    ['space', { preview_token: `${upstreamToken} ` }, tokenSchema, undefined],
    ['newline', { preview_token: `${upstreamToken}\n` }, tokenSchema, undefined],
    ['slash', { preview_token: `${upstreamToken}/` }, tokenSchema, undefined],
    ['plus', { preview_token: `${upstreamToken}+` }, tokenSchema, undefined],
    ['equals', { preview_token: `${upstreamToken}=` }, tokenSchema, undefined],
    ['unicode', { preview_token: `${upstreamToken}é` }, tokenSchema, undefined],
    ['redaction marker', { preview_token: `${upstreamToken}[redacted]` }, tokenSchema, undefined],
    [
      'declared minimum excludes token',
      { preview_token: upstreamToken },
      { minLength: 43 },
      undefined,
    ],
    [
      'declared maximum excludes token',
      { preview_token: upstreamToken },
      { maxLength: 16 },
      undefined,
    ],
    ['zero maximum', { preview_token: upstreamToken }, { maxLength: 0 }, undefined],
    [
      'inclusive declared bounds',
      { preview_token: upstreamToken },
      { minLength: upstreamToken.length, maxLength: upstreamToken.length },
      upstreamToken,
    ],
    [
      'inherited bounds',
      { preview_token: upstreamToken },
      Object.create({ minLength: 256, maxLength: 0 }),
      upstreamToken,
    ],
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '16', null, true, [], {}].map(
      (bound, index): [string, unknown, Record<string, unknown>, string] => [
        `invalid bounds ${index + 1}`,
        { preview_token: upstreamToken },
        { minLength: bound, maxLength: bound },
        upstreamToken,
      ]
    ),
  ];

  it.each(rows)('%s', (_label, result, schema, expected) => {
    expect(capturePreviewToken(result, schema)).toBe(expected);
  });
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const abilityName = 'mainwp/replace-example-settings-v1';
const toolName = 'replace_example_settings_v1';
const previewArgs = { request_id: 'request-1', setting: 'example-value', preview_token: null };

function exampleAbility(): Ability {
  return {
    name: abilityName,
    label: 'Replace Example Settings',
    description: 'Replace example settings',
    category: 'mainwp-settings',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        setting: { type: 'string' },
        confirm: { type: 'boolean' },
        dry_run: { type: 'boolean' },
        preview_token: { type: ['string', 'null'] },
      },
      required: ['request_id', 'setting', 'confirm', 'dry_run', 'preview_token'],
    },
    meta: { annotations: { readonly: false, destructive: true, idempotent: false } },
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rejectedToken(): Response {
  return jsonResponse({ code: 'invalid_preview_token', message: 'Preview token rejected' }, 400);
}

function responseData(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

function upstreamInputs(): Array<{ input: Record<string, unknown> }> {
  return mockFetch.mock.calls
    .filter(([url]) => String(url).includes('/run'))
    .map(([, options]) => JSON.parse(String(options.body)));
}

describe('preview_token confirmation flow', () => {
  let ability: Ability;
  let previewResult: unknown;
  let issuedToken: string;
  let failExecution: boolean;
  const connections: Array<{ client: Client; server: Server }> = [];

  async function connectedClient(config = makeBaseConfig()) {
    const { server, logger } = await createServer(config);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const connection = { client, server };
    connections.push(connection);
    return { ...connection, logger };
  }

  async function preview(
    client: Client,
    args: Record<string, unknown> = previewArgs,
    name = toolName
  ) {
    const result = await client.callTool({ name, arguments: { ...args, confirm: true } });
    expect(result.isError).toBeFalsy();
    const data = responseData(result);
    expect(data.status).toBe('CONFIRMATION_REQUIRED');
    expect(data.confirmation_token).toBeTypeOf('string');
    return data.confirmation_token as string;
  }

  async function confirm(
    client: Client,
    token: string,
    args: Record<string, unknown> = previewArgs,
    name = toolName
  ) {
    return client.callTool({
      name,
      arguments: { ...args, user_confirmed: true, confirmation_token: token },
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearToolsCache();
    clearPendingPreviews();
    clearKnownSecrets();
    resetSessionData();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ability = exampleAbility();
    issuedToken = upstreamToken;
    previewResult = { preview_token: issuedToken, would_update: true };
    failExecution = false;
    mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (!url.includes('/run')) return jsonResponse([ability]);
      const { input } = JSON.parse(String(options.body));
      if (input.dry_run === true) return jsonResponse(previewResult);
      if (failExecution || input.preview_token !== issuedToken) return rejectedToken();
      return jsonResponse({ updated: true });
    });
  });

  afterEach(async () => {
    for (const { client, server } of connections.splice(0)) {
      await client.close();
      await server.close();
    }
    clearKnownSecrets();
    vi.restoreAllMocks();
  });

  describe.each(updateAbilityNames)('MainWP update preview_token binding for %s', updateName => {
    const updateToolName = abilityNameToToolName(updateName, 'mainwp');
    const args = { request_id: 'request-1', setting: 'example-value' };

    beforeEach(() => {
      ability.name = updateName;
    });

    it.each([
      ['absent', {}],
      ['null', { preview_token: null }],
      ['equal', { preview_token: upstreamToken }],
    ])('sends the captured token when the caller token is %s', async (_label, sent) => {
      const { client } = await connectedClient();
      const token = await preview(client, previewArgs, updateToolName);
      const result = await confirm(client, token, { ...args, ...sent }, updateToolName);
      expect(result.isError).toBeFalsy();
      expect(responseData(result)).toEqual({ updated: true });
      expect(upstreamInputs()).toHaveLength(2);
      expect(upstreamInputs()[1]).toEqual({
        input: { ...args, preview_token: upstreamToken, confirm: true, dry_run: false },
      });
      expect(getPendingPreviewCounts()).toEqual({ previews: 0, tokens: 0 });
    });

    it.each([
      ['different string', differentToken],
      ['number', 7],
      ['boolean', true],
      ['array', [upstreamToken]],
      ['object', { value: upstreamToken }],
    ])('rejects %s caller tokens before execution', async (_label, sent) => {
      const { client, logger } = await connectedClient();
      const logSpies = (['debug', 'info', 'notice', 'warning', 'error', 'critical'] as const).map(
        level => vi.spyOn(logger, level)
      );
      const token = await preview(client, previewArgs, updateToolName);
      const result = await confirm(client, token, { ...args, preview_token: sent }, updateToolName);
      expect(result.isError).toBe(true);
      expect(responseData(result)).toMatchObject({
        error: 'PREVIEW_REQUIRED',
        details: {
          reason:
            'The preview token does not match this preview. Generate a new preview before confirming.',
        },
      });
      expect(upstreamInputs()).toHaveLength(1);
      expect(getPendingPreviewCounts()).toEqual({ previews: 0, tokens: 0 });
      expect(logger.warning).toHaveBeenCalledWith(
        'Confirmation failed - preview token does not match preview',
        expect.objectContaining({ toolName: updateToolName })
      );
      const logged = JSON.stringify(logSpies.flatMap(spy => spy.mock.calls));
      expect(logged).not.toContain(upstreamToken);
      expect(logged).not.toContain(differentToken);
      expect(logged).not.toContain(token);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(upstreamToken);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(differentToken);
    });

    it('refuses replay after a mismatched caller token with zero confirmed executions', async () => {
      const { client } = await connectedClient();
      const token = await preview(client, previewArgs, updateToolName);
      await confirm(client, token, { ...args, preview_token: differentToken }, updateToolName);
      const replay = await confirm(
        client,
        token,
        { ...args, preview_token: upstreamToken },
        updateToolName
      );
      expect(replay.isError).toBe(true);
      expect(responseData(replay).error).toBe('PREVIEW_REQUIRED');
      expect(upstreamInputs()).toHaveLength(1);
      expect(getPendingPreviewCounts()).toEqual({ previews: 0, tokens: 0 });
    });

    it('keeps caller-wins when MainWP is a secondary namespace', async () => {
      const config = makeBaseConfig({ abilityNamespaces: ['acme', 'mainwp'] });
      const secondaryToolName = abilityNameToToolName(updateName, 'acme');
      expect(secondaryToolName).toBe(`mainwp__${updateToolName}`);
      const { client } = await connectedClient(config);
      const token = await preview(client, previewArgs, secondaryToolName);
      issuedToken = differentToken;
      const result = await confirm(
        client,
        token,
        { ...args, preview_token: differentToken },
        secondaryToolName
      );
      expect(result.isError).toBeFalsy();
      expect(responseData(result)).toEqual({ updated: true });
      expect(upstreamInputs()).toHaveLength(2);
      expect(upstreamInputs()[1]).toEqual({
        input: { ...args, preview_token: differentToken, confirm: true, dry_run: false },
      });
    });

    it.each([
      ['absent', {}],
      ['null', { preview_token: null }],
      ['different string', { preview_token: differentToken }],
      ['non-string', { preview_token: 7 }],
    ])('preserves %s caller tokens when no preview token was captured', async (_label, sent) => {
      previewResult = {};
      issuedToken = differentToken;
      const { client } = await connectedClient();
      const token = await preview(client, previewArgs, updateToolName);
      const result = await confirm(client, token, { ...args, ...sent }, updateToolName);
      expect(upstreamInputs()).toHaveLength(2);
      expect(upstreamInputs()[1]).toEqual({
        input: { ...args, ...sent, confirm: true, dry_run: false },
      });
      if ('preview_token' in sent && sent.preview_token === differentToken) {
        expect(result.isError).toBeFalsy();
        expect(responseData(result)).toEqual({ updated: true });
      } else {
        expect(result.isError).toBe(true);
        expect(JSON.stringify(responseData(result))).toContain('invalid_preview_token');
      }
    });
  });

  it.each([
    ['required', true],
    ['optional', false],
  ] as const)('normalizes %s preview_token on server-made previews', async (_label, required) => {
    if (!required) ability.input_schema!.required = ['request_id', 'setting', 'confirm', 'dry_run'];
    const { client } = await connectedClient();
    for (const sent of [
      {},
      { preview_token: null },
      { preview_token: upstreamToken },
      { preview_token: 7 },
      { preview_token: true },
      { preview_token: [] },
      { preview_token: {} },
    ]) {
      await preview(client, { request_id: 'request-1', setting: 'example-value', ...sent });
      expect(upstreamInputs().at(-1)).toEqual({
        input: {
          request_id: 'request-1',
          setting: 'example-value',
          dry_run: true,
          confirm: false,
          ...(required ? { preview_token: null } : {}),
        },
      });
    }
  });

  it.each([
    ['null', previewArgs],
    ['absent', { request_id: 'request-1', setting: 'example-value' }],
  ])(
    'injects the captured token when repeated arguments have %s preview_token',
    async (_label, args) => {
      const { client } = await connectedClient();
      const token = await preview(client, args);
      const result = await confirm(client, token, args);
      expect(upstreamInputs().at(-1)).toEqual({
        input: { ...args, preview_token: upstreamToken, confirm: true, dry_run: false },
      });
      expect(result.isError).toBeFalsy();
      expect(responseData(result)).toEqual({ updated: true });
    }
  );

  it('executes a confirmed call carrying the returned token', async () => {
    const { client } = await connectedClient();
    const token = await preview(client);
    const result = await confirm(client, token, { ...previewArgs, preview_token: upstreamToken });
    expect(upstreamInputs()).toHaveLength(2);
    expect(upstreamInputs()[1]).toEqual({
      input: { ...previewArgs, preview_token: upstreamToken, confirm: true, dry_run: false },
    });
    expect(result.isError).toBeFalsy();
    expect(responseData(result)).toEqual({ updated: true });
  });

  it('keeps the stored preview_token when a repeat preview fails session accounting', async () => {
    const { client } = await connectedClient(makeBaseConfig({ maxSessionData: 2048 }));
    const token = await preview(client);
    const before = getPendingPreviewCounts();
    previewResult = {
      preview_token: 'failed_preview_token_0123456789',
      payload: 'x'.repeat(4096),
    };
    const failed = await client.callTool({
      name: toolName,
      arguments: { ...previewArgs, confirm: true },
    });
    expect(failed.isError).toBe(true);
    expect(responseData(failed).error.code).toBe(MCP_ERROR_CODES.RESOURCE_EXHAUSTED);
    expect(getPendingPreviewCounts()).toEqual(before);

    resetSessionData();
    const confirmed = await confirm(client, token);
    expect(upstreamInputs()[2]).toEqual({
      input: { ...previewArgs, preview_token: upstreamToken, confirm: true, dry_run: false },
    });
    expect(confirmed.isError).toBeFalsy();
    expect(responseData(confirmed)).toEqual({ updated: true });
  });

  it('forwards a different caller token and fails closed upstream', async () => {
    const { client } = await connectedClient();
    const token = await preview(client);
    const sent = 'different_preview_token_0123456789';
    const result = await confirm(client, token, { ...previewArgs, preview_token: sent });
    expect(upstreamInputs()).toHaveLength(2);
    expect(upstreamInputs()[1]).toEqual({
      input: { ...previewArgs, preview_token: sent, confirm: true, dry_run: false },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(responseData(result))).toContain('invalid_preview_token');
  });

  it('prefers a fresh caller token after an explicit dry run', async () => {
    const { client } = await connectedClient();
    const token = await preview(client);
    issuedToken = 'fresh_preview_token_0123456789';
    previewResult = { preview_token: issuedToken };
    const dryRun = await client.callTool({
      name: toolName,
      arguments: { ...previewArgs, dry_run: true },
    });
    expect(responseData(dryRun)).toEqual({ preview_token: issuedToken });
    const result = await confirm(client, token, { ...previewArgs, preview_token: issuedToken });
    expect(upstreamInputs().at(-1)).toEqual({
      input: { ...previewArgs, preview_token: issuedToken, confirm: true, dry_run: false },
    });
    expect(result.isError).toBeFalsy();
    expect(responseData(result)).toEqual({ updated: true });
  });

  it.each([
    ['missing', {}],
    ['non-string', { preview_token: 123 }],
    ['oversized', { preview_token: 'a'.repeat(257) }],
    ['bad charset', { preview_token: 'invalid/token_0123456789' }],
    ['redaction-altered', { preview_token: 'prefix_private_password_0123456789_suffix' }],
  ])('issues confirmation without capturing a %s response token', async (label, result) => {
    previewResult = result;
    const config = makeBaseConfig(
      label === 'redaction-altered' ? { appPassword: 'private_password_0123456789' } : {}
    );
    const { client } = await connectedClient(config);
    const response = await client.callTool({
      name: toolName,
      arguments: { ...previewArgs, confirm: true },
    });
    const data = responseData(response);
    expect(response.isError).toBeFalsy();
    expect(data.status).toBe('CONFIRMATION_REQUIRED');
    expect(data.confirmation_token).toBeTypeOf('string');
    if (label === 'redaction-altered') {
      expect(JSON.stringify(data)).toContain('[redacted]');
      expect(JSON.stringify(data)).not.toContain('private_password_0123456789');
    }
    const confirmed = await confirm(client, data.confirmation_token);
    expect(upstreamInputs()[1]).toEqual({
      input: { ...previewArgs, confirm: true, dry_run: false },
    });
    expect(confirmed.isError).toBe(true);
    expect(JSON.stringify(responseData(confirmed))).toContain('invalid_preview_token');
  });

  it.each([
    ['setting', { ...previewArgs, setting: 'changed-value' }],
    ['request id', { ...previewArgs, request_id: 'request-2' }],
  ])('rejects a changed %s before execution', async (_label, args) => {
    const { client } = await connectedClient();
    const token = await preview(client);
    const result = await confirm(client, token, args);
    expect(result.isError).toBe(true);
    expect(responseData(result).error).toBe('PREVIEW_REQUIRED');
    expect(upstreamInputs()).toHaveLength(1);
  });

  it.each(['non-null string', 'no dry_run', 'no preview_token'])(
    'preserves full upstream payloads for %s',
    async shape => {
      const properties = ability.input_schema!.properties as Record<string, unknown>;
      if (shape === 'non-null string') properties.preview_token = { type: 'string' };
      if (shape === 'no dry_run') {
        delete properties.dry_run;
        ability.input_schema!.required = ['request_id', 'setting', 'confirm', 'preview_token'];
      }
      if (shape === 'no preview_token') {
        delete properties.preview_token;
        ability.input_schema!.required = ['request_id', 'setting', 'confirm', 'dry_run'];
      }
      const args = { ...previewArgs, preview_token: upstreamToken };
      const { client } = await connectedClient();
      const token = await preview(client, args);
      const result = await confirm(client, token, args);
      expect(result.isError).toBeFalsy();
      expect(upstreamInputs()).toEqual([
        ...(shape === 'no dry_run' ? [] : [{ input: { ...args, dry_run: true, confirm: false } }]),
        {
          input: { ...args, confirm: true, ...(shape === 'no dry_run' ? {} : { dry_run: false }) },
        },
      ]);
    }
  );

  it.each(['non-null string', 'no dry_run', 'no preview_token'])(
    'keeps preview_token in the key for %s',
    async shape => {
      const properties = ability.input_schema!.properties as Record<string, unknown>;
      if (shape === 'non-null string') properties.preview_token = { type: 'string' };
      if (shape === 'no dry_run') delete properties.dry_run;
      if (shape === 'no preview_token') delete properties.preview_token;
      const { client } = await connectedClient();
      const args = { ...previewArgs, preview_token: upstreamToken };
      const token = await preview(client, args);
      const before = upstreamInputs();
      const result = await confirm(client, token, {
        ...args,
        preview_token: 'changed_preview_token_0123456789',
      });
      expect(result.isError).toBe(true);
      expect(responseData(result).error).toBe('PREVIEW_REQUIRED');
      expect(upstreamInputs()).toEqual(before);
    }
  );

  it.each([
    ['number', 7],
    ['boolean', true],
    ['array', []],
    ['object', { value: 'caller-value' }],
  ])('preserves a caller %s value outside string/null', async (_label, sent) => {
    const { client } = await connectedClient();
    const args = { ...previewArgs, preview_token: sent };
    const token = await preview(client, args);
    const result = await confirm(client, token, args);
    expect(upstreamInputs().at(-1)).toEqual({
      input: { ...args, confirm: true, dry_run: false },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(responseData(result))).toContain('invalid_preview_token');
  });

  it.each(['success', 'upstream failure'])(
    'consumes the preview and stored token after %s',
    async outcome => {
      const { client } = await connectedClient();
      const token = await preview(client);
      failExecution = outcome === 'upstream failure';
      const result = await confirm(client, token);
      expect(upstreamInputs()[1]).toEqual({
        input: { ...previewArgs, preview_token: upstreamToken, confirm: true, dry_run: false },
      });
      expect(Boolean(result.isError)).toBe(failExecution);
      const repeated = await confirm(client, token);
      expect(repeated.isError).toBe(true);
      expect(responseData(repeated).error).toBe('PREVIEW_REQUIRED');
      expect(upstreamInputs()).toHaveLength(2);
      previewResult = {};
      const nextToken = await preview(client);
      await confirm(client, nextToken);
      expect(upstreamInputs().at(-1)).toEqual({
        input: { ...previewArgs, confirm: true, dry_run: false },
      });
    }
  );

  it.each(['replacement token', 'missing token'])(
    'overwrites a repeated preview with a %s',
    async replacement => {
      const { client } = await connectedClient();
      const oldToken = await preview(client);
      issuedToken = 'replacement_preview_token_0123456789';
      previewResult = replacement === 'replacement token' ? { preview_token: issuedToken } : {};
      const nextToken = await preview(client);
      const oldResult = await confirm(client, oldToken);
      expect(responseData(oldResult).error).toBe('PREVIEW_REQUIRED');
      expect(upstreamInputs()).toHaveLength(2);
      const result = await confirm(client, nextToken);
      expect(upstreamInputs()[2]).toEqual({
        input: {
          ...previewArgs,
          preview_token: replacement === 'replacement token' ? issuedToken : null,
          confirm: true,
          dry_run: false,
        },
      });
      expect(Boolean(result.isError)).toBe(replacement === 'missing token');
    }
  );

  it('expires a preview and refuses its token thereafter', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { client } = await connectedClient();
    const token = await preview(client);
    now += 5 * 60 * 1000 + 1;
    const expired = await confirm(client, token);
    expect(expired.isError).toBe(true);
    expect(responseData(expired).error).toBe('PREVIEW_EXPIRED');
    expect(responseData(await confirm(client, token)).error).toBe('PREVIEW_REQUIRED');
    expect(upstreamInputs()).toHaveLength(1);
  });

  it('removes expired entries when another preview is requested', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { client } = await connectedClient();
    const token = await preview(client);
    now += 5 * 60 * 1000 + 1;
    await preview(client, { ...previewArgs, request_id: 'request-2' });
    const result = await confirm(client, token);
    expect(result.isError).toBe(true);
    expect(responseData(result).error).toBe('PREVIEW_REQUIRED');
    expect(upstreamInputs()).toHaveLength(2);
  });

  it('evicts the oldest preview at the existing insertion limit', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { client } = await connectedClient();
    const tokens: string[] = [];
    for (let index = 0; index < 101; index++) {
      now++;
      tokens.push(
        await preview(client, {
          ...previewArgs,
          request_id: `request-${index}`,
          preview_token: upstreamToken,
        })
      );
    }
    const oldest = await confirm(client, tokens[0], {
      ...previewArgs,
      request_id: 'request-0',
      preview_token: upstreamToken,
    });
    expect(oldest.isError).toBe(true);
    expect(responseData(oldest).error).toBe('PREVIEW_REQUIRED');
    expect(upstreamInputs()).toHaveLength(101);
    const retained = await confirm(client, tokens[1], {
      ...previewArgs,
      request_id: 'request-1',
      preview_token: upstreamToken,
    });
    expect(retained.isError).toBeFalsy();
    expect(upstreamInputs()).toHaveLength(102);
    expect(upstreamInputs().at(-1)).toEqual({
      input: { ...previewArgs, preview_token: upstreamToken, confirm: true, dry_run: false },
    });
  });

  it('forwards an explicit dry run token without recording confirmation state', async () => {
    const { client } = await connectedClient();
    const args = {
      ...previewArgs,
      preview_token: 'caller_preview_token_0123456789',
      dry_run: true,
      confirm: true,
    };
    const result = await client.callTool({ name: toolName, arguments: args });
    expect(result.isError).toBeFalsy();
    expect(responseData(result)).toEqual(previewResult);
    expect(upstreamInputs()).toEqual([{ input: { ...args, confirm: false } }]);
    const confirmed = await confirm(client, '00000000-0000-4000-8000-000000000000');
    expect(confirmed.isError).toBe(true);
    expect(responseData(confirmed).error).toBe('PREVIEW_REQUIRED');
    expect(upstreamInputs()).toHaveLength(1);
  });

  it('blocks in safe mode before making a preview', async () => {
    const { client } = await connectedClient(makeBaseConfig({ safeMode: true }));
    const result = await client.callTool({
      name: toolName,
      arguments: { ...previewArgs, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(responseData(result).error).toBe('SAFE_MODE_BLOCKED');
    expect(upstreamInputs()).toHaveLength(0);
  });

  it('passes input through when confirmation is disabled', async () => {
    const { client } = await connectedClient(makeBaseConfig({ requireUserConfirmation: false }));
    const args = { ...previewArgs, preview_token: upstreamToken, confirm: true, dry_run: false };
    const result = await client.callTool({ name: toolName, arguments: args });
    expect(result.isError).toBeFalsy();
    expect(upstreamInputs()).toEqual([{ input: args }]);
    expect(responseData(result)).toEqual({ updated: true });
  });

  it('uses a named confirmation channel without preview or capture', async () => {
    const properties = ability.input_schema!.properties as Record<string, unknown>;
    delete properties.confirm;
    properties.confirm_changes = { type: 'boolean', const: true };
    ability.input_schema!.required = ['request_id', 'setting', 'confirm_changes', 'preview_token'];
    const { client } = await connectedClient();
    const response = await client.callTool({
      name: toolName,
      arguments: { ...previewArgs, confirm_changes: true },
    });
    const data = responseData(response);
    expect(response.isError).toBeFalsy();
    expect(data.status).toBe('CONFIRMATION_REQUIRED');
    expect(data.confirmation_token).toBeTypeOf('string');
    expect(upstreamInputs()).toHaveLength(0);
    const result = await confirm(client, data.confirmation_token);
    expect(result.isError).toBe(true);
    expect(upstreamInputs()).toEqual([{ input: { ...previewArgs, confirm_changes: true } }]);
  });

  it('keeps captured tokens within their configuration identity', async () => {
    const { client: first } = await connectedClient();
    const token = await preview(first);
    const { client: second } = await connectedClient(makeBaseConfig({ username: 'other-user' }));
    const rejected = await confirm(second, token);
    expect(rejected.isError).toBe(true);
    expect(responseData(rejected).error).toBe('PREVIEW_REQUIRED');
    expect(upstreamInputs()).toHaveLength(1);
    previewResult = {};
    const secondToken = await preview(second);
    const result = await confirm(second, secondToken);
    expect(result.isError).toBe(true);
    expect(upstreamInputs().at(-1)).toEqual({
      input: { ...previewArgs, confirm: true, dry_run: false },
    });
  });

  it('keeps the captured token out of server-generated log data', async () => {
    const { client } = await connectedClient();
    const logged: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
      logged.push(notification.params.data);
    });
    const token = await preview(client);
    const result = await confirm(client, token);
    expect(upstreamInputs()[1]).toEqual({
      input: { ...previewArgs, preview_token: upstreamToken, confirm: true, dry_run: false },
    });
    expect(result.isError).toBeFalsy();
    await vi.waitFor(() => {
      expect(logged).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'Preview generated for confirmation' }),
          expect.objectContaining({ message: 'User confirmation validated' }),
          expect.objectContaining({ message: 'Tool execution succeeded' }),
        ])
      );
    });
    expect(JSON.stringify(logged)).not.toContain(upstreamToken);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(upstreamToken);
  });
});
