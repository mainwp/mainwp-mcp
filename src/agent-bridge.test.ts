import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateInput } from './security.js';
import { executeTool, clearToolsCache, getTools } from './tools.js';
import {
  clearCache,
  initRateLimiter,
  configIdentityHash,
  executeAbility,
  type Ability,
} from './abilities.js';
import { agentOutcomeFields, clearAgentGrants, getAgentGrant } from './agent-bridge.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

const mutations = [
  'run-site-php',
  'run-site-wpcli',
  'write-site-files',
  'run-site-ability-write',
  'run-site-ability-destructive',
];
const abilities: Ability[] = mutations.map(name => ({
  name: `mainwp/${name}-v1`,
  label: name,
  description: name,
  category: 'mainwp-agent-bridge',
  input_schema: {
    type: 'object',
    properties: {
      site_id: { type: 'integer' },
      code: { type: 'string', maxLength: 60000 },
      operation_id: { type: 'string' },
      confirm: { type: 'boolean' },
    },
  },
  meta: {
    annotations: {
      readonly: false,
      destructive: name !== 'run-site-ability-write',
      idempotent: false,
    },
  },
}));
const fetchMock = vi.fn();
const readProxy: Ability = {
  ...abilities[0],
  name: 'mainwp/run-site-ability-read-v1',
  input_schema: {
    type: 'object',
    properties: {
      site_id: { type: 'integer' },
      input: { type: 'object', 'x-mainwp-passthrough': true },
    },
  },
  meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
};
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  clearCache();
  clearToolsCache();
  initRateLimiter(0);
  fetchMock.mockReset();
  clearAgentGrants();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(abilities)));
});

describe('bounded read proxy transport', () => {
  it('preserves a typical plugin read with nested JSON, booleans and null', async () => {
    const args = {
      site_id: 1,
      input: { element_id: 'a1b2c3', include: [1, 2], filters: { drafts: false, cursor: null } },
    };
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([readProxy])));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_ability_read_v1',
      args,
      makeMockLogger()
    );
    expect(result.isError).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
    expect(JSON.parse(new URL(fetchMock.mock.calls[1][0]).searchParams.get('input_json')!)).toEqual(
      args
    );
  });
  it('accepts a read at the existing total URL limit', async () => {
    const config = makeBaseConfig();
    const empty = { site_id: 1, input: { text: '' } };
    const prefix = `${config.dashboardUrl}/wp-json/wp-abilities/v1/abilities/${readProxy.name}/run?input_json=`;
    const args = {
      site_id: 1,
      input: {
        text: 'x'.repeat(8000 - prefix.length - encodeURIComponent(JSON.stringify(empty)).length),
      },
    };
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    await expect(
      executeAbility(config, readProxy.name, args, undefined, readProxy)
    ).resolves.toEqual({ success: true });
    expect(fetchMock.mock.calls[0][0]).toHaveLength(8000);
  });
  it.each([8192, 8193])('checks a %i-byte JSON read before sending a request', async size => {
    const empty = { site_id: 1, input: { text: '' } };
    const args = {
      site_id: 1,
      input: { text: 'x'.repeat(size - Buffer.byteLength(JSON.stringify(empty))) },
    };
    expect(Buffer.byteLength(JSON.stringify(args))).toBe(size);
    fetchMock.mockReset();
    await expect(
      executeAbility(makeBaseConfig(), readProxy.name, args, undefined, readProxy)
    ).rejects.toThrow(
      size === 8193
        ? /8193.*8192.*[Ll]arger read payloads are not supported yet/
        : /8000.*[Ll]arger read payloads are not supported yet/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps 200 KB plugin input on write POST calls', async () => {
    const writeProxy: Ability = {
      ...readProxy,
      name: 'mainwp/run-site-ability-write-v1',
      meta: { annotations: { readonly: false, destructive: false, idempotent: false } },
    };
    const args = {
      site_id: 1,
      input: { element_id: 'a1b2c3', text: 'x'.repeat(200000), filters: { drafts: false } },
    };
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([writeProxy])));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_ability_write_v1',
      args,
      makeMockLogger()
    );
    expect(result.isError).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ input: args });
  });
});

describe('Dashboard agent approvals', () => {
  it('rejects non-object outcome metadata before copying recovery references', () => {
    const array = Object.assign([], {
      operation_id: 'invalid-operation',
      request_id: 'invalid-request',
    });
    for (const metadata of [undefined, null, false, 0, '', 'invalid', array]) {
      expect(agentOutcomeFields(metadata, 'outcome_unknown', makeBaseConfig())).toEqual({});
    }
  });
  it.each([
    { site: 1, expected: [1] },
    { site: '01', expected: [1] },
    { site: 0, expected: undefined },
    { site: 'bad', expected: undefined },
    { site: 1.5, expected: undefined },
    { site: Number.MAX_SAFE_INTEGER + 1, expected: undefined },
  ])('keeps grant site validation for $site', async ({ site, expected }) => {
    const config = makeBaseConfig();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          task_grant: {
            grant_id: 'g',
            site_ids: [site],
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
        })
      )
    );
    await executeTool(config, 'run_site_php_v1', { site_id: 1 }, makeMockLogger());
    expect(getAgentGrant(configIdentityHash(config), 'g')?.site_ids).toEqual(expected);
  });
  it.each(mutations)(
    'preserves timeout recovery references for %s without retrying',
    async name => {
      const data = {
        operation_id: 'operation-original',
        request_id: '6daf7ae3-6203-4a49-b541-59fe424c0123',
        internal_field: 'not forwarded',
      };
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'outcome_unknown',
            message: 'The outcome is unknown. Resume this operation to read the receipt.',
            data,
          }),
          { status: 409 }
        )
      );
      const result = await executeTool(
        makeBaseConfig({ retryEnabled: true }),
        `${name.replaceAll('-', '_')}_v1`,
        { site_id: 1 },
        makeMockLogger()
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error.data).toEqual({
        upstream_code: 'outcome_unknown',
        operation_id: data.operation_id,
        request_id: data.request_id,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );
  it.each([200, 500])('retains the existing %i outcome handling', async status => {
    const data = { operation_id: 'operation-original', request_id: 'request-original' };
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'outcome_unknown', message: 'The outcome is unknown.', data }),
        { status }
      )
    );
    const result = await executeTool(
      makeBaseConfig({ retryEnabled: true }),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    if (status === 200)
      expect(JSON.parse(result.content[0].text)).toEqual({
        code: 'outcome_unknown',
        message: 'The outcome is unknown.',
        data,
      });
    else {
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).not.toHaveProperty('data');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('does not expose outcome references from an unrelated tool', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ ...abilities[3], name: 'mainwp/update-site-v1' }]))
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'outcome_unknown',
          message: 'The outcome is unknown.',
          data: { operation_id: 'private-operation', request_id: 'private-request' },
        }),
        { status: 409 }
      )
    );
    const result = await executeTool(
      makeBaseConfig(),
      'update_site_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    expect(JSON.parse(result.content[0].text).error.data).toEqual({
      upstream_code: 'outcome_unknown',
    });
  });
  it('lists destructive tools in Safe Mode and refuses their execution', async () => {
    const config = makeBaseConfig({ safeMode: true });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([readProxy, ...abilities])));
    const tools = await getTools(config);
    expect(tools.map(tool => tool.name)).toEqual([
      'run_site_ability_read_v1',
      ...mutations.map(name => `${name.replaceAll('-', '_')}_v1`),
    ]);
    const result = await executeTool(config, 'run_site_php_v1', { site_id: 1 }, makeMockLogger());
    expect(result.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([200, 409])('refreshes grant metadata on a %i backup response', async status => {
    const config = makeBaseConfig();
    const expires = new Date(Date.now() + 60000).toISOString();
    const data = {
      operation_id: 'backup-a',
      task_grant: { grant_id: 'g', site_ids: [1], expires_at: expires },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          status === 200
            ? { code: 'agent_backup_running', ...data }
            : { code: 'agent_backup_running', message: 'Backup running', data }
        ),
        { status }
      )
    );
    await executeTool(config, 'run_site_php_v1', { site_id: 1 }, makeMockLogger());
    expect(getAgentGrant(configIdentityHash(config), 'g')?.expires_at).toBe(Date.parse(expires));
  });
  it('keeps backup resume and polling data from HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'agent_backup_running',
          message: 'Backup running',
          data: { operation_id: 'backup-a', poll: { after_seconds: 5 } },
        }),
        { status: 409 }
      )
    );
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    expect(JSON.parse(result.content[0].text).error.data).toMatchObject({
      operation_id: 'backup-a',
      poll: { after_seconds: 5 },
    });
  });
  it('keeps the operation ID when an HTTP approval URL is withheld', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'agent_approval_required',
          message: 'Approval required',
          data: { operation_id: 'op-a', approval_url: 'https://elsewhere.local/approve' },
        }),
        { status: 403 }
      )
    );
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    expect(JSON.parse(result.content[0].text).error.data.operation_id).toBe('op-a');
  });
  it('withholds a foreign link in a nested successful error envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'agent_approval_required',
          data: { operation_id: 'op-a', approval_url: 'https://elsewhere.local/approve' },
        })
      )
    );
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.data).not.toHaveProperty('approval_url');
    expect(body.operation_id).toBe('op-a');
  });
  it('retains execution evidence when a gated write exceeds the session budget', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, output: 'x'.repeat(1000) }))
    );
    const result = await executeTool(
      makeBaseConfig({ maxSessionData: 100 }),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    expect(JSON.parse(result.content[0].text).error.data).toMatchObject({
      execution_attempted: true,
      upstream_response_received: true,
      result_omitted: true,
    });
  });
  it('accepts PHP grant scalars and describes a later covered call from cache', async () => {
    const config = makeBaseConfig();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          task_grant: {
            grant_id: 'g',
            site_ids: ['1'],
            expires_at: Math.floor(Date.now() / 1000) + 60,
          },
        })
      )
    );
    const first = await executeTool(config, 'run_site_php_v1', { site_id: 1 }, makeMockLogger());
    expect(JSON.parse(first.content[0].text).instructions).toContain('grant_id');
    expect(getAgentGrant(configIdentityHash(config), 'g')?.site_ids).toEqual([1]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    const second = await executeTool(
      config,
      'run_site_php_v1',
      { site_id: 1, task_grant: 'g' },
      makeMockLogger()
    );
    expect(JSON.parse(second.content[0].text).instructions).toContain('Dashboard');
  });
  it('withholds invalid approval links in successful envelopes too', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'agent_approval_required',
          operation_id: 'op-a',
          approval_url: 'https://elsewhere.local/approve',
        })
      )
    );
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    expect(JSON.parse(result.content[0].text)).not.toHaveProperty('approval_url');
  });
  it('preserves approval fields from a WordPress HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'agent_approval_required',
          message: 'Approval required',
          data: { operation_id: 'op-a', approval_url: 'https://test.local/wp-admin/approve' },
        }),
        { status: 403 }
      )
    );
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.error.data).toMatchObject({
      upstream_code: 'agent_approval_required',
      operation_id: 'op-a',
      approval_url: 'https://test.local/wp-admin/approve',
    });
    expect(body.error.data.instructions).toMatch(/user.*wait/i);
  });
  it('does not expose an approval URL pointing outside the Dashboard', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'agent_approval_required',
          message: 'Approval required',
          data: { operation_id: 'op-a', approval_url: 'https://elsewhere.local/approve' },
        }),
        { status: 403 }
      )
    );
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    expect(JSON.parse(result.content[0].text).error.data).not.toHaveProperty('approval_url');
  });
  it('runs an Allow response without asking locally', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    const result = await executeTool(
      makeBaseConfig(),
      'run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('retains the local token flow for other destructive abilities', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ ...abilities[0], name: 'mainwp/delete-site-v1' }]))
    );
    const result = await executeTool(
      makeBaseConfig(),
      'delete_site_v1',
      { site_id: 1, confirm: true },
      makeMockLogger()
    );
    expect(result.content[0].text).toContain('confirmation_token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('uses the canonical ability when mainwp is a secondary namespace', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    const result = await executeTool(
      makeBaseConfig({ abilityNamespaces: ['other', 'mainwp'] }),
      'mainwp__run_site_php_v1',
      { site_id: 1 },
      makeMockLogger()
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true });
  });
  it('does not skip local confirmation for another namespace with the same tool name', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ ...abilities[0], name: 'other/run-site-php-v1' }]))
    );
    const result = await executeTool(
      makeBaseConfig({ abilityNamespaces: ['other'] }),
      'run_site_php_v1',
      { site_id: 1, confirm: true },
      makeMockLogger()
    );
    expect(result.content[0].text).toContain('confirmation_token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('records and refreshes Dashboard grants, isolates identities, and works after restart', async () => {
    const config = makeBaseConfig();
    const identity = configIdentityHash(config);
    const expiry = new Date(Date.now() + 60000).toISOString();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ grant_id: 'g', site_ids: [1], expires_at: expiry }))
    );
    await executeTool(
      config,
      'run_site_php_v1',
      { site_id: 1, task_grant: 'forged' },
      makeMockLogger()
    );
    expect(getAgentGrant(identity, 'forged')).toBeUndefined();
    expect(getAgentGrant(identity, 'g')).toEqual({ site_ids: [1], expires_at: Date.parse(expiry) });
    expect(
      getAgentGrant(configIdentityHash({ ...config, username: 'someone' }), 'g')
    ).toBeUndefined();
    const refreshed = new Date(Date.now() + 120000).toISOString();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ grant_id: 'g', site_ids: [1], expires_at: refreshed }))
    );
    await executeTool(config, 'run_site_php_v1', { site_id: 1, task_grant: 'g' }, makeMockLogger());
    expect(getAgentGrant(identity, 'g')?.expires_at).toBe(Date.parse(refreshed));
    clearAgentGrants();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    expect(
      (await executeTool(config, 'run_site_php_v1', { operation_id: 'op-a' }, makeMockLogger()))
        .isError
    ).toBeUndefined();
  });
  it('returns one approval link for two writes on A and a new link on B', async () => {
    const config = makeBaseConfig();
    const pending = (id: string) => ({
      code: 'agent_approval_required',
      operation_id: id,
      approval_url: `https://test.local/wp-admin/approve?operation=${id}`,
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(pending('a'))));
    const first = JSON.parse(
      (
        await executeTool(
          config,
          'run_site_php_v1',
          { site_id: 1, code: 'first' },
          makeMockLogger()
        )
      ).content[0].text
    );
    expect(first.instructions).toMatch(/Never.*approve.*yourself/);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          grant_id: 'g',
          site_ids: [1],
          expires_at: new Date(Date.now() + 60000).toISOString(),
        })
      )
    );
    await executeTool(
      config,
      'run_site_php_v1',
      { operation_id: first.operation_id },
      makeMockLogger()
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    const second = JSON.parse(
      (
        await executeTool(
          config,
          'run_site_php_v1',
          { site_id: 1, code: 'second', task_grant: 'g' },
          makeMockLogger()
        )
      ).content[0].text
    );
    expect(second.approval_url).toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(pending('b'))));
    const third = JSON.parse(
      (
        await executeTool(
          config,
          'run_site_php_v1',
          { site_id: 2, code: 'third', task_grant: 'g' },
          makeMockLogger()
        )
      ).content[0].text
    );
    expect(third.approval_url).not.toBe(first.approval_url);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it.each(mutations)('sends %s directly to the Dashboard gate', async name => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'agent_approval_required',
          operation_id: 'op-a',
          approval_url: 'https://test.local/wp-admin/approve',
        })
      )
    );
    const result = await executeTool(
      makeBaseConfig(),
      `${name.replaceAll('-', '_')}_v1`,
      { site_id: 1 },
      makeMockLogger()
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('agent_approval_required');
    expect(body.instructions).toMatch(/user.*wait/i);
    expect(body.approval_url).toBe('https://test.local/wp-admin/approve');
  });
  it.each(mutations.filter(name => name !== 'run-site-ability-write'))(
    'safe mode blocks %s before execution',
    async name => {
      const result = await executeTool(
        makeBaseConfig({ safeMode: true }),
        `${name.replaceAll('-', '_')}_v1`,
        { site_id: 1 },
        makeMockLogger()
      );
      expect(result.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
  it('advertises Dashboard approval without local tokens', async () => {
    const tools = await getTools(makeBaseConfig());
    for (const tool of tools) {
      expect(tool.description).toMatch(/Dashboard/);
      expect(tool.inputSchema.properties).not.toHaveProperty('user_confirmed');
      expect(tool.inputSchema.properties).not.toHaveProperty('confirmation_token');
    }
  });
});

describe('proxy input passthrough', () => {
  const schema = { properties: { input: { type: 'object', 'x-mainwp-passthrough': true } } };
  it.each([NaN, Infinity, -Infinity])('keeps the serialization error for %s', value => {
    expect(() => validateInput({ input: { nested: [value] } }, schema)).toThrow(
      'Parameter "input" must be JSON serializable'
    );
  });
  it('accepts plugin IDs, deep objects and long strings within the byte cap', () => {
    const input = {
      element_id: 'a1b2c3',
      text: 'x'.repeat(200000),
      nested: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
    };
    expect(() => validateInput({ input }, schema)).not.toThrow();
    expect(() => validateInput({ input })).toThrow();
  });
  it('rejects more than 1 MiB of UTF-8 JSON', () => {
    expect(() => validateInput({ input: { text: 'é'.repeat(524288) } }, schema)).toThrow();
  });
  it('retains the ordinary outer validation', () => {
    expect(() => validateInput({ input: {}, site_id: 'bad' }, schema)).toThrow();
  });
  it('accepts declared PHP length and rejects the undeclared length', () => {
    expect(() =>
      validateInput({ code: 'x'.repeat(60000) }, abilities[0].input_schema)
    ).not.toThrow();
    expect(() => validateInput({ code: 'x'.repeat(60000) })).toThrow();
  });
});
