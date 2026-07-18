import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { Artifacts } from './artifacts.js';
import { AcceptanceClient } from './client.js';
import type { CommandRunner } from './commands.js';

class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: StdioClientTransport,
    private readonly scenario: string,
    private readonly artifacts: Artifacts
  ) {}

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = error => this.onerror?.(error);
    this.inner.onmessage = message => {
      this.artifacts.appendEvent(this.scenario, 'server-to-client', message);
      this.onmessage?.(message);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.artifacts.appendEvent(this.scenario, 'client-to-server', message);
    void options;
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export interface ServerLaunchOptions {
  scenario: string;
  entry: string;
  env: Record<string, string>;
  artifacts: Artifacts;
  runner: CommandRunner;
  settings?: Record<string, unknown>;
}

export interface ServerConnection {
  client: AcceptanceClient;
  cwd: string;
  home: string;
  close(): Promise<void>;
}

function isolatedEnvironment(home: string, values: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LOGNAME: '',
    SHELL: '',
    TERM: '',
    USER: '',
    ...values,
  };
}

export async function launchServer(options: ServerLaunchOptions): Promise<ServerConnection> {
  const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcp-server-'));
  const cwd = path.join(isolationRoot, 'cwd');
  const home = path.join(isolationRoot, 'home');
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  if (options.settings) {
    const settingsPath = path.join(cwd, 'settings.json');
    fs.writeFileSync(settingsPath, `${JSON.stringify(options.settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  const commandStarted = performance.now();
  let stderr = '';
  const inner = new StdioClientTransport({
    command: process.execPath,
    args: [options.entry],
    cwd,
    env: isolatedEnvironment(home, options.env),
    stderr: 'pipe',
  });
  inner.stderr?.on('data', chunk => {
    const text = Buffer.from(chunk).toString('utf8');
    stderr += text;
    options.artifacts.appendServerStderr(options.scenario, text);
  });
  const transport = new RecordingTransport(inner, options.scenario, options.artifacts);
  const rawClient = new Client({ name: 'mainwp-acceptance-harness', version: '1.0.0' });

  const closeResources = async (): Promise<void> => {
    let closeError: unknown;
    try {
      await rawClient.close();
    } catch (error) {
      closeError = error;
    }
    try {
      await transport.close();
    } catch (error) {
      closeError ??= error;
    }
    if (closeError) throw closeError;
  };

  try {
    await rawClient.connect(transport);
  } catch (error) {
    try {
      await closeResources();
    } catch {
      // Preserve the connection failure; both cleanup paths were attempted.
    } finally {
      options.artifacts.flushServerStderr(options.scenario);
      options.runner.record({
        argv: [process.execPath, options.entry],
        cwd,
        exitCode: 1,
        durationMs: Math.round(performance.now() - commandStarted),
        stdoutTail: '[MCP protocol stream; see events.jsonl]',
        stderrTail: stderr.slice(-12_000),
      });
      fs.rmSync(isolationRoot, { recursive: true, force: true });
    }
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    client: new AcceptanceClient(rawClient),
    cwd,
    home,
    close: async () => {
      closePromise ??= (async () => {
        let closeFailed = false;
        try {
          await closeResources();
        } catch (error) {
          closeFailed = true;
          throw error;
        } finally {
          options.artifacts.flushServerStderr(options.scenario);
          options.runner.record({
            argv: [process.execPath, options.entry],
            cwd,
            exitCode: closeFailed ? 1 : 0,
            durationMs: Math.round(performance.now() - commandStarted),
            stdoutTail: '[MCP protocol stream; see events.jsonl]',
            stderrTail: stderr.slice(-12_000),
          });
          fs.rmSync(isolationRoot, { recursive: true, force: true });
        }
      })();
      await closePromise;
    },
  };
}
