/**
 * CLI entry-point tests
 *
 * Spawns the real entry point (src/index.ts via tsx) to verify first-run
 * behavior a user sees from `npx -y @mainwp/mcp`: --help and --version
 * answer on stdout with exit 0, and a completely unconfigured start prints
 * setup guidance instead of a fatal error.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(REPO_ROOT, 'src', 'index.ts');

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, ENTRY, ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

/**
 * Environment with all MAINWP_* variables removed and HOME pointed at an
 * empty directory, so neither env vars nor a real settings.json (CWD or
 * ~/.config/mainwp-mcp) can configure the server.
 */
function unconfiguredEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('MAINWP_')) env[key] = value;
  }
  env.HOME = home;
  return env;
}

describe('CLI entry point', () => {
  it('--help prints usage with setup instructions and exits 0', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('MAINWP_URL');
    expect(result.stdout).toContain('MAINWP_APP_PASSWORD');
    expect(result.stdout).toContain('https://github.com/mainwp/mainwp-mcp');
    expect(result.stdout).not.toContain('Fatal error');
  }, 30000);

  it('--version prints the version and exits 0', async () => {
    const result = await runCli(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  }, 30000);

  it('unconfigured start prints setup guidance to stderr, not a fatal error', async () => {
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcp-cli-test-'));
    try {
      const result = await runCli([], { cwd: tempHome, env: unconfiguredEnv(tempHome) });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not configured yet');
      expect(result.stderr).toContain('MAINWP_URL');
      expect(result.stderr).toContain('MAINWP_APP_PASSWORD');
      expect(result.stderr).toContain('Setup guide:');
      expect(result.stderr).not.toContain('Fatal error');
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30000);
});
