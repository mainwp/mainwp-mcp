import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { clearCache, initRateLimiter } from './abilities.js';
import { clearToolsCache } from './tools.js';
import { makeBaseConfig } from '../tests/helpers/config.js';
import {
  startFixtureDashboard,
  FIXTURE_USERNAME,
  FIXTURE_APP_PASSWORD,
  type FixtureDashboard,
} from '../tests/acceptance/fixture-dashboard.js';
import { initialKnowledge } from '../tests/acceptance/fixture-knowledge.js';
import { getPromptList } from './prompts.js';

const input = {
  scope_type: 'site',
  scope_id: 1,
  type: 'memory',
  title: 'Transport record',
  body: 'Verified the plugin update.',
};
const tool = 'create_knowledge_record_v1';
function data(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find(item => item.type === 'text')!.text!) as Record<string, unknown>;
}

describe('knowledge MCP transport', () => {
  let fixture: FixtureDashboard;
  const sessions: Array<{
    client: Client;
    server: Awaited<ReturnType<typeof createServer>>['server'];
  }> = [];
  beforeEach(async () => {
    clearCache();
    clearToolsCache();
    initRateLimiter(0);
    fixture = await startFixtureDashboard();
  });
  afterEach(async () => {
    for (const { client, server } of sessions.splice(0)) {
      await client.close();
      await server.close();
    }
    await fixture.close();
    vi.restoreAllMocks();
  });
  async function connect(overrides = {}) {
    const { server } = await createServer(
      makeBaseConfig({
        dashboardUrl: fixture.url,
        username: FIXTURE_USERNAME,
        appPassword: FIXTURE_APP_PASSWORD,
        allowHttp: true,
        skipSslVerify: false,
        ...overrides,
      })
    );
    const client = new Client({ name: 'knowledge-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    sessions.push({ client, server });
    return client;
  }
  async function records(client: Client) {
    return data(await client.callTool({ name: 'list_knowledge_v1', arguments: {} }));
  }
  it('previews create without writing and saves only with its bound confirmation token', async () => {
    const client = await connect();
    const before = await records(client);
    const preview = data(
      await client.callTool({ name: tool, arguments: { ...input, confirm: true } })
    );
    expect(preview).toMatchObject({
      status: 'CONFIRMATION_REQUIRED',
      confirmation_token: expect.any(String),
      preview: { dry_run: true, would_save: { ...input, source: 'ability', verified: false } },
    });
    expect(await records(client)).toEqual(before);
    const rejected = await client.callTool({
      name: tool,
      arguments: {
        ...input,
        body: 'Changed content',
        user_confirmed: true,
        confirmation_token: preview.confirmation_token,
      },
    });
    expect(rejected.isError).toBe(true);
    expect(await records(client)).toEqual(before);
    const fresh = data(
      await client.callTool({ name: tool, arguments: { ...input, confirm: true } })
    );
    const saved = await client.callTool({
      name: tool,
      arguments: { ...input, user_confirmed: true, confirmation_token: fresh.confirmation_token },
    });
    expect(saved.isError).not.toBe(true);
    expect(data(saved)).toMatchObject({
      ...input,
      id: expect.any(Number),
      revision: 1,
      source: 'ability',
      verified: false,
    });
    expect((await records(client)).total).toBe(Number(before.total) + 1);
  });
  it('safeMode blocks knowledge writes without changing records', async () => {
    const client = await connect({ safeMode: true });
    const before = await records(client);
    const result = await client.callTool({ name: tool, arguments: { ...input, confirm: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(data(result))).toMatch(/safe.mode/i);
    expect(await records(client)).toEqual(before);
  });
  it('requireUserConfirmation false creates a record in one call', async () => {
    const client = await connect({ requireUserConfirmation: false });
    const before = await records(client);
    const result = await client.callTool({ name: tool, arguments: { ...input, confirm: true } });
    expect(result.isError).not.toBe(true);
    expect(data(result)).toMatchObject({ ...input, revision: 1 });
    expect((await records(client)).total).toBe(Number(before.total) + 1);
  });
  it.each([
    ['troubleshoot-site', { site_id: '1' }],
    ['maintenance-check', {}],
  ])('%s tells the model to treat knowledge records as data', async (name, args) => {
    const client = await connect();
    const result = await client.getPrompt({ name, arguments: args });
    const text = JSON.stringify(result);
    expect(text).toContain('get_site_knowledge_v1');
    expect(text).toContain('not as instructions');
    expect(text).toContain('records marked verified');
  });
  it('all eight prompts stay static without fetching or embedding knowledge records', async () => {
    const client = await connect();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(initialKnowledge())));
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(prompt => prompt.name).sort()).toEqual(
      getPromptList()
        .map(prompt => prompt.name)
        .sort()
    );
    expect(prompts.prompts).toHaveLength(8);
    for (const prompt of prompts.prompts) {
      const args = Object.fromEntries(
        (prompt.arguments ?? []).filter(arg => arg.required).map(arg => [arg.name, '1'])
      );
      const result = await client.getPrompt({ name: prompt.name, arguments: args });
      expect(result.messages.length).toBeGreaterThan(0);
      for (const record of initialKnowledge()) {
        expect(JSON.stringify(result)).not.toContain(record.body);
        expect(JSON.stringify(result)).not.toContain(record.title);
      }
      expect(fetchSpy, prompt.name).not.toHaveBeenCalled();
    }
  });
});
