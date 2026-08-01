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
  listRelativeFiles,
  resolveTreeRoot,
} from './check-skill-sync.js';

export interface SyncResult {
  copied: string[];
  removed: string[];
}

/**
 * Rebuild the mirror from the canonical tree.
 *
 * The new copy is staged in a sibling directory and only swapped in once it
 * compares equal to the canonical tree, so a copy that fails partway through
 * (a target colliding with a file, an unwritable path) leaves the old mirror
 * exactly as it was instead of a half-written mixture of both.
 */
export function syncTree(canonicalDir: string, mirrorDir: string): SyncResult {
  const comparison = compareTrees(canonicalDir, mirrorDir);
  const copied = [...comparison.missing, ...comparison.differing].sort();
  const removed = [...comparison.extra].sort();
  if (copied.length === 0 && removed.length === 0) return { copied, removed };

  const canonicalRoot = resolveTreeRoot(canonicalDir);
  const parent = path.dirname(mirrorDir);
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(mirrorDir)}-sync-`));
  try {
    for (const file of listRelativeFiles(canonicalRoot)) {
      const target = path.join(staging, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(canonicalRoot, file), target);
    }
    const staged = describeComparison(compareTrees(canonicalRoot, staging));
    if (staged.length > 0) {
      throw new Error(`Staged skill copy does not match the canonical tree: ${staged.join('; ')}`);
    }
    swapIn(staging, mirrorDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return { copied, removed };
}

/** Move `staging` into place, restoring the previous mirror if the move fails. */
function swapIn(staging: string, mirrorDir: string): void {
  const hadMirror = fs.existsSync(mirrorDir);
  const previous = `${mirrorDir}.replaced-${process.pid}`;
  if (hadMirror) fs.renameSync(mirrorDir, previous);
  try {
    fs.renameSync(staging, mirrorDir);
  } catch (error) {
    if (hadMirror) fs.renameSync(previous, mirrorDir);
    throw error;
  }
  if (hadMirror) fs.rmSync(previous, { recursive: true, force: true });
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
    // The new copy is staged and verified before it replaces the mirror, so a
    // failed run leaves the previous mirror in place.
    console.error(`Skill sync failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
