#!/usr/bin/env node
/**
 * Version Consistency Check Script
 *
 * Ensures that the version in package.json matches the SERVER_VERSION constant
 * in src/index.ts, manifest.json and both versions in server.json. This is a CI quality gate
 * to prevent version drift. mcp-publisher publishes whatever server.json says,
 * so a stale entry would list a version that npm does not have.
 *
 * Usage: node scripts/check-version.js
 * Exit codes: 0 = versions match, 1 = mismatch or error
 *
 * Note: This script uses ESM imports because the repository's package.json
 * has "type": "module", which makes Node.js treat all .js files as ES modules.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

/**
 * Extract version from package.json
 */
function getPackageVersion() {
  const packagePath = join(rootDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  return packageJson.version;
}

/**
 * Extract SERVER_VERSION constant from src/index.ts
 */
function getSourceVersion() {
  const indexPath = join(rootDir, 'src', 'index.ts');
  const content = readFileSync(indexPath, 'utf8');

  // Match: const SERVER_VERSION = '1.0.0-alpha.12'; or with double quotes
  // Allows optional whitespace around = and either quote style
  const match = content.match(/const SERVER_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/);
  if (!match) {
    throw new Error('Could not find SERVER_VERSION constant in src/index.ts');
  }

  return match[1];
}

/**
 * Extract the server and npm package versions from server.json
 */
function getRegistryVersions() {
  const serverPath = join(rootDir, 'server.json');
  const serverJson = JSON.parse(readFileSync(serverPath, 'utf8'));
  const npmPackage = (serverJson.packages ?? []).find(pkg => pkg.registryType === 'npm');
  if (!npmPackage) {
    throw new Error('Could not find the npm package entry in server.json');
  }

  return { server: serverJson.version, npmPackage: npmPackage.version };
}

/**
 * Main version check
 */
function main() {
  try {
    const packageVersion = getPackageVersion();
    const sourceVersion = getSourceVersion();
    const registryVersions = getRegistryVersions();
    const manifestVersion = JSON.parse(
      readFileSync(join(rootDir, 'manifest.json'), 'utf8')
    ).version;

    console.log(`package.json version: ${packageVersion}`);
    console.log(`src/index.ts version: ${sourceVersion}`);
    console.log(`server.json version: ${registryVersions.server}`);
    console.log(`server.json npm package version: ${registryVersions.npmPackage}`);
    console.log(`manifest.json version: ${manifestVersion}`);

    const versions = [
      sourceVersion,
      registryVersions.server,
      registryVersions.npmPackage,
      manifestVersion,
    ];
    if (versions.every(version => version === packageVersion)) {
      console.log('\n✓ Versions match');
      process.exit(0);
    } else {
      console.error('\n✗ Version mismatch detected!');
      console.error('Please update every location below to the same version.');
      console.error('\nLocations to update:');
      console.error('  - package.json: "version" field');
      console.error('  - src/index.ts: SERVER_VERSION constant');
      console.error('  - server.json: "version" field');
      console.error('  - server.json: "version" of the npm entry in "packages"');
      console.error('  - manifest.json: "version" field');
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error checking versions: ${error.message}`);
    process.exit(1);
  }
}

main();
