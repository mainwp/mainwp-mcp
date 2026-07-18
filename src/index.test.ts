import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { clearCache, initRateLimiter } from './abilities.js';
import { makeBaseConfig } from '../tests/helpers/config.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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
});
