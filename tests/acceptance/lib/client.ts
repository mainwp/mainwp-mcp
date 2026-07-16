import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export class AcceptanceClient {
  constructor(readonly raw: Client) {}

  get serverInfo() {
    return this.raw.getServerVersion();
  }

  get capabilities() {
    return this.raw.getServerCapabilities();
  }

  listTools() {
    return this.raw.listTools();
  }

  listResources() {
    return this.raw.listResources();
  }

  readResource(uri: string) {
    return this.raw.readResource({ uri });
  }

  listPrompts() {
    return this.raw.listPrompts();
  }

  complete(ref: { type: 'ref/prompt'; name: string }, name: string, value: string) {
    return this.raw.complete({ ref, argument: { name, value } });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const result = await this.raw.callTool({ name, arguments: args });
    if (!Array.isArray((result as { content?: unknown }).content)) {
      throw new Error(`Tool ${name} returned an asynchronous task instead of a completed result`);
    }
    return result as CallToolResult;
  }

  async callToolJson(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<{ result: CallToolResult; data: unknown }> {
    const result = await this.callTool(name, args);
    return { result, data: parseToolJson(result) };
  }
}

export function parseToolJson(result: CallToolResult): unknown {
  const text = result.content.find(
    (content): content is Extract<(typeof result.content)[number], { type: 'text' }> =>
      content.type === 'text'
  );
  if (!text) throw new Error('Tool result did not contain text content');
  try {
    return JSON.parse(text.text);
  } catch (error) {
    throw new Error(`Tool result was not JSON: ${text.text}`, { cause: error });
  }
}
