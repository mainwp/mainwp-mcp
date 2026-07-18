import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { clearCache, initRateLimiter } from './abilities.js';
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
