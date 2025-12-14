#!/usr/bin/env node
/**
 * Version Consistency Check Script
 *
 * Ensures that the version in package.json matches the SERVER_VERSION constant
 * in src/index.ts. This is a CI quality gate to prevent version drift.
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
 * Main version check
 */
function main() {
  try {
    const packageVersion = getPackageVersion();
    const sourceVersion = getSourceVersion();

    console.log(`package.json version: ${packageVersion}`);
    console.log(`src/index.ts version: ${sourceVersion}`);

    if (packageVersion === sourceVersion) {
      console.log('\n✓ Versions match');
      process.exit(0);
    } else {
      console.error('\n✗ Version mismatch detected!');
      console.error('Please update both package.json and src/index.ts to have the same version.');
      console.error('\nLocations to update:');
      console.error('  - package.json: "version" field');
      console.error('  - src/index.ts: SERVER_VERSION constant');
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error checking versions: ${error.message}`);
    process.exit(1);
  }
}

main();
