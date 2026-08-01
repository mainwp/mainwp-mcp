#!/usr/bin/env tsx
/**
 * Make the plugin's copy of the mainwp-dashboard skill byte-identical to the
 * canonical copy in `.agents/`. One-way on purpose: `.agents/` is the source,
 * the plugin copy is generated, and edits made only to the plugin copy are
 * discarded rather than merged back.
 *
 * Usage: npm run sync-skill   (npm run check-skill-sync reports drift)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_SKILL_DIR,
  MIRROR_SKILL_DIR,
  assertUsableCanonicalTree,
  compareTrees,
  describeComparison,
} from './check-skill-sync.js';

export interface SyncResult {
  copied: string[];
  removed: string[];
}

/** Copy every canonical file over the mirror and delete anything else there. */
export function syncTree(canonicalDir: string, mirrorDir: string): SyncResult {
  const comparison = compareTrees(canonicalDir, mirrorDir);
  const copied = [...comparison.missing, ...comparison.differing].sort();

  for (const file of copied) {
    const target = path.join(mirrorDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(canonicalDir, file), target);
  }

  for (const file of comparison.extra) {
    fs.rmSync(path.join(mirrorDir, file), { force: true });
  }
  pruneEmptyDirs(mirrorDir);

  return { copied, removed: [...comparison.extra].sort() };
}

/** Remove directories left behind by deleted files, but keep the root. */
function pruneEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    pruneEmptyDirs(child);
    if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    const count = assertUsableCanonicalTree(CANONICAL_SKILL_DIR).length;
    fs.mkdirSync(MIRROR_SKILL_DIR, { recursive: true });
    const { copied, removed } = syncTree(CANONICAL_SKILL_DIR, MIRROR_SKILL_DIR);

    if (copied.length === 0 && removed.length === 0) {
      console.log(`Skill copies already in sync: ${count} file(s), nothing to do.`);
    } else {
      for (const file of copied) console.log(`copied  ${file}`);
      for (const file of removed) console.log(`removed ${file}`);
      console.log(`Synced plugin skill copy: ${copied.length} copied, ${removed.length} removed.`);
    }

    const remaining = describeComparison(compareTrees(CANONICAL_SKILL_DIR, MIRROR_SKILL_DIR));
    if (remaining.length > 0) {
      console.error('Sync did not converge:');
      for (const problem of remaining) console.error(`  - ${problem}`);
      process.exit(1);
    }
  } catch (error) {
    // Refuse to leave a half-written mirror behind: the comparison throws
    // before anything is copied, so an aborted run changes nothing.
    console.error(`Skill sync failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
