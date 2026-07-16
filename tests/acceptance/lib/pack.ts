import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Artifacts } from './artifacts.js';
import type { CommandRunner } from './commands.js';
import { startLocalDependencyRegistry } from './local-registry.js';

interface NpmPackResult {
  id: string;
  name: string;
  version: string;
  filename: string;
  shasum: string;
  integrity: string;
}

export interface PackChecks {
  requiredFilesPresent: boolean;
  forbiddenFilesAbsent: boolean;
  installedEntryPresent: boolean;
  mainwpBinPresent: boolean;
  mcpBinPresent: boolean;
  installedVersionMatches: boolean;
}

export interface PackedPackage {
  tempRoot: string;
  consumerDir: string;
  tarballPath: string;
  filename: string;
  sha256: string;
  npmShasum: string;
  integrity: string;
  installedEntry: string;
  mainwpBin: string;
  mcpBin: string;
  version: string;
  checks: PackChecks;
  cleanup(): void;
}

export async function packAndInstall(
  repoRoot: string,
  runner: CommandRunner,
  artifacts: Artifacts,
  keepConsumer: boolean
): Promise<PackedPackage> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcp-acceptance-'));
  const packResult = await runner.run(
    ['npm', 'pack', '--json', '--pack-destination', tempRoot],
    repoRoot
  );
  const parsed = JSON.parse(packResult.stdout) as NpmPackResult[];
  if (parsed.length !== 1) throw new Error(`npm pack produced ${parsed.length} package records`);
  const packed = parsed[0];
  const tarballPath = path.join(tempRoot, packed.filename);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex');
  const listingResult = await runner.run(['tar', '-tzf', tarballPath], repoRoot);
  const entries = new Set(listingResult.stdout.split(/\r?\n/).filter(Boolean));
  const requiredFiles = [
    'package/dist/index.js',
    'package/settings.schema.json',
    'package/README.md',
    'package/LICENSE',
  ];
  const forbiddenPrefixes = ['package/settings.json', 'package/src/', 'package/src'];
  const requiredFilesPresent = requiredFiles.every(filename => entries.has(filename));
  const forbiddenFilesAbsent = [...entries].every(
    filename =>
      !forbiddenPrefixes.some(prefix => filename === prefix || filename.startsWith(prefix))
  );
  if (!requiredFilesPresent || !forbiddenFilesAbsent) {
    throw new Error('Packed tarball content assertions failed');
  }

  const consumerDir = path.join(tempRoot, 'consumer');
  fs.mkdirSync(consumerDir);
  const npmCache = path.join(tempRoot, 'npm-cache');
  fs.mkdirSync(npmCache);
  await runner.run(['npm', 'init', '-y'], consumerDir, {
    env: { ...process.env, npm_config_cache: npmCache },
  });

  const registry = await startLocalDependencyRegistry(repoRoot, tempRoot, runner);
  try {
    await runner.run(
      ['npm', 'install', tarballPath, '--no-audit', '--no-fund', '--registry', registry.url],
      consumerDir,
      { env: { ...process.env, npm_config_cache: npmCache } }
    );
  } finally {
    await registry.close();
  }

  const packageDir = path.join(consumerDir, 'node_modules', '@mainwp', 'mcp');
  const installedEntry = fs.realpathSync(path.join(packageDir, 'dist', 'index.js'));
  const mainwpBin = path.join(consumerDir, 'node_modules', '.bin', 'mainwp-mcp');
  const mcpBin = path.join(consumerDir, 'node_modules', '.bin', 'mcp');
  const installedPackage = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
  ) as { version: string };
  const repoPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  const checks: PackChecks = {
    requiredFilesPresent,
    forbiddenFilesAbsent,
    installedEntryPresent: fs.existsSync(installedEntry),
    mainwpBinPresent: fs.existsSync(mainwpBin),
    mcpBinPresent: fs.existsSync(mcpBin),
    installedVersionMatches: installedPackage.version === repoPackage.version,
  };
  if (Object.values(checks).some(check => !check)) {
    throw new Error(`Installed package assertions failed: ${JSON.stringify(checks)}`);
  }
  artifacts.setTarball({ filename: packed.filename, sha256, integrity: packed.integrity });

  return {
    tempRoot,
    consumerDir,
    tarballPath,
    filename: packed.filename,
    sha256,
    npmShasum: packed.shasum,
    integrity: packed.integrity,
    installedEntry,
    mainwpBin,
    mcpBin,
    version: installedPackage.version,
    checks,
    cleanup: () => {
      if (!keepConsumer) fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}
