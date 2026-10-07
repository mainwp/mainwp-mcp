import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function runCheck(manifestVersion: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-version-test-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.copyFileSync(
    new URL('../scripts/check-version.js', import.meta.url),
    path.join(root, 'scripts/check-version.js')
  );
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module","version":"1.4.0"}');
  fs.writeFileSync(path.join(root, 'src/index.ts'), "const SERVER_VERSION = '1.4.0';");
  fs.writeFileSync(
    path.join(root, 'server.json'),
    '{"version":"1.4.0","packages":[{"registryType":"npm","version":"1.4.0"}]}'
  );
  if (manifestVersion !== null) {
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({ version: manifestVersion })
    );
  }
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-version.js')], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('bundle version consistency', () => {
  it('accepts a manifest matching the package version', () => {
    const result = runCheck('1.4.0');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('manifest.json version: 1.4.0');
  });

  it('fails when only the manifest version differs', () => {
    const result = runCheck('1.3.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest.json');
  });

  it('fails when the manifest is missing', () => {
    expect(runCheck(null).status).toBe(1);
  });
});
