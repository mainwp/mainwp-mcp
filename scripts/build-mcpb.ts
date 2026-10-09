import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repoRoot, 'test-results/mcpb/mainwp-mcp.mcpb');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcpb-build-'));
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@anthropic-ai/mcpb/cli')), 'cli/cli.js');

try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dev?: boolean; version?: string }>;
  };
  for (const filename of [
    'dist',
    'manifest.json',
    'LICENSE',
    'README.md',
    'settings.schema.json',
  ]) {
    fs.cpSync(path.join(repoRoot, filename), path.join(stage, filename), { recursive: true });
  }
  fs.cpSync(path.join(repoRoot, manifest.icon), path.join(stage, manifest.icon), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        type: packageJson.type,
        main: packageJson.main,
        license: packageJson.license,
        engines: packageJson.engines,
        dependencies: packageJson.dependencies,
      },
      null,
      2
    )}\n`
  );

  // Reuse the locked installation so staging needs neither network nor lifecycle scripts.
  const dependencies = Object.entries(lock.packages).filter(
    ([location, metadata]) => location.startsWith('node_modules/') && !metadata.dev
  );
  for (const [location, metadata] of dependencies) {
    const source = path.join(repoRoot, location);
    const installed = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (installed.version !== metadata.version) {
      throw new Error(`Installed dependency does not match package-lock.json: ${location}`);
    }
    fs.cpSync(source, path.join(stage, location), {
      recursive: true,
      dereference: true,
      // Nested packages are selected separately from the lockfile.
      filter: filename => filename === source || path.basename(filename) !== 'node_modules',
    });
  }
  console.log(`Staged ${dependencies.length} production dependencies offline`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(process.execPath, [cli, 'validate', path.join(stage, 'manifest.json')], {
    stdio: 'inherit',
    timeout: 60_000,
  });
  execFileSync(process.execPath, [cli, 'pack', stage, output], {
    stdio: 'inherit',
    timeout: 120_000,
  });
  const bundle = fs.readFileSync(output);
  console.log(`Bundle: ${output}`);
  console.log(`SHA256: ${crypto.createHash('sha256').update(bundle).digest('hex')}`);
  console.log(`Size: ${bundle.length} bytes`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
