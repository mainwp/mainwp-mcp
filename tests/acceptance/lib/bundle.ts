import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { vAny } from '@anthropic-ai/mcpb/schemas';
import type { CommandRunner } from './commands.js';
import type { AcceptanceCredentials } from './env.js';

export interface BundleLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  entry: string;
}

export interface ExtractedBundle {
  filename: string;
  sha256: string;
  extractDir: string;
  launch: BundleLaunch;
  cleanup(): void;
}

export function substituteBundleVariables(
  value: string,
  extractDir: string,
  userConfig: Record<string, string>
): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
    if (key === '__dirname') return extractDir;
    if (key.startsWith('user_config.')) {
      const name = key.slice('user_config.'.length);
      if (Object.hasOwn(userConfig, name)) return userConfig[name];
    }
    throw new Error(`Unsupported bundle placeholder: ${key}`);
  });
}

function assertContained(root: string, filename: string): void {
  const relative = path.relative(root, filename);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Bundle entry point escapes the extraction directory');
  }
}

export function resolveBundleLaunch(
  rawManifest: unknown,
  extractDir: string,
  credentials: AcceptanceCredentials
): BundleLaunch {
  const parsed = vAny.McpbManifestSchema.safeParse(rawManifest);
  if (!parsed.success) throw new Error('Invalid bundle manifest');
  const manifest = parsed.data;
  const userConfig = {
    dashboard_url: credentials.dashboardUrl,
    username: credentials.username,
    app_password: credentials.appPassword,
  };
  const substitute = (value: string) => substituteBundleVariables(value, extractDir, userConfig);
  const root = path.resolve(extractDir);
  const entry = path.resolve(root, substitute(manifest.server.entry_point));
  assertContained(root, entry);
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw new Error('Bundle entry point is missing or is not a file');
  }
  assertContained(fs.realpathSync(root), fs.realpathSync(entry));
  const config = manifest.server.mcp_config;
  if (!config) throw new Error('Bundle manifest is missing server.mcp_config');
  const override = config.platform_overrides?.[process.platform];
  const args = (override?.args ?? config.args ?? []).map(substitute);
  if (!args.includes(entry)) {
    throw new Error('Bundle launch arguments do not reference the extracted entry point');
  }
  return {
    entry,
    command: substitute(override?.command ?? config.command),
    args,
    env: Object.fromEntries(
      Object.entries({ ...config.env, ...override?.env }).map(([key, value]) => [
        key,
        substitute(value),
      ])
    ),
  };
}

export async function extractBundle(
  bundlePath: string,
  credentials: AcceptanceCredentials,
  runner: CommandRunner,
  keepConsumer: boolean
): Promise<ExtractedBundle> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcpb-acceptance-'));
  const extractDir = path.join(tempRoot, 'bundle');
  const cleanup = () => {
    if (!keepConsumer) fs.rmSync(tempRoot, { recursive: true, force: true });
  };
  try {
    const content = fs.readFileSync(bundlePath);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const archive = path.join(tempRoot, 'input.mcpb');
    fs.writeFileSync(archive, content);
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve('@anthropic-ai/mcpb/cli')), 'cli/cli.js');
    await runner.run([process.execPath, cli, 'unpack', archive, extractDir], tempRoot, {
      timeoutMs: 60_000,
    });
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8')
    );
    return {
      filename: path.basename(bundlePath),
      sha256,
      extractDir,
      launch: resolveBundleLaunch(manifest, extractDir, credentials),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
