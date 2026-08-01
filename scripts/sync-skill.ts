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
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_SKILL_DIR,
  MIRROR_SKILL_DIR,
  REPO_ROOT,
  assertUsableCanonicalTree,
  compareTrees,
  describeComparison,
  listRelativeFiles,
  resolveTreeRootWithin,
} from './check-skill-sync.js';

export interface SyncResult {
  copied: string[];
  removed: string[];
  /** Non-fatal problems after the mirror was already replaced. */
  warnings: string[];
}

/**
 * Rebuild the mirror from the canonical tree.
 *
 * The new copy is staged in a sibling directory and only swapped in once it
 * compares equal to the canonical tree, so a copy that fails partway through
 * (a target colliding with a file, an unwritable path) leaves the old mirror
 * exactly as it was instead of a half-written mixture of both.
 *
 * Every path component from `anchor` down is symlink-checked first, and the
 * staging, swap, and cleanup all run against the resolved parent, so a linked
 * directory anywhere in either path cannot redirect the rebuild elsewhere.
 */
export function syncTree(canonicalDir: string, mirrorDir: string, anchor = REPO_ROOT): SyncResult {
  const canonicalRoot = resolveTreeRootWithin(anchor, canonicalDir);
  const mirrorParent = resolveTreeRootWithin(anchor, path.dirname(mirrorDir));
  const mirrorName = path.basename(mirrorDir);
  const mirrorRoot = path.join(mirrorParent, mirrorName);
  if (fs.lstatSync(mirrorRoot, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Skill tree root is a symlink: ${mirrorRoot}`);
  }

  const comparison = compareTrees(canonicalRoot, mirrorRoot);
  const copied = [...comparison.missing, ...comparison.differing].sort();
  const removed = [...comparison.extra].sort();
  if (copied.length === 0 && removed.length === 0) return { copied, removed, warnings: [] };

  removeStaleArtifacts(mirrorParent, mirrorName);
  const staging = fs.mkdtempSync(path.join(mirrorParent, `.${mirrorName}-sync-`));
  let warnings: string[];
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
    warnings = swapIn(staging, mirrorRoot);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return { copied, removed, warnings };
}

/**
 * Move `staging` into place, restoring the previous mirror if the move fails.
 * Returns warnings for anything that went wrong after the swap committed: at
 * that point the new mirror is live, and reporting a failure would describe a
 * tree that is not what is on disk.
 */
function swapIn(staging: string, mirrorRoot: string): string[] {
  const hadMirror = fs.existsSync(mirrorRoot);
  const previous = `${mirrorRoot}.replaced-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  if (hadMirror) fs.renameSync(mirrorRoot, previous);
  try {
    fs.renameSync(staging, mirrorRoot);
  } catch (error) {
    if (hadMirror) fs.renameSync(previous, mirrorRoot);
    throw error;
  }
  if (!hadMirror) return [];

  try {
    fs.rmSync(previous, { recursive: true, force: true });
    return [];
  } catch (error) {
    return [
      `the skill copy was replaced, but the previous one could not be removed: ${previous} (${(error as Error).message})`,
    ];
  }
}

/** Drop staging and backup directories a previous run died before cleaning up. */
function removeStaleArtifacts(parent: string, name: string): void {
  for (const entry of fs.readdirSync(parent)) {
    if (!entry.startsWith(`${name}.replaced-`) && !entry.startsWith(`.${name}-sync-`)) continue;
    try {
      fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
    } catch {
      // A leftover we cannot delete is the previous run's problem, not this
      // one's: the rebuild below does not touch it.
      continue;
    }
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
    const canonicalRoot = resolveTreeRootWithin(REPO_ROOT, CANONICAL_SKILL_DIR);
    const count = assertUsableCanonicalTree(canonicalRoot).length;
    const mirrorRoot = resolveTreeRootWithin(REPO_ROOT, MIRROR_SKILL_DIR);
    fs.mkdirSync(mirrorRoot, { recursive: true });
    const { copied, removed, warnings } = syncTree(canonicalRoot, mirrorRoot);

    if (copied.length === 0 && removed.length === 0) {
      console.log(`Skill copies already in sync: ${count} file(s), nothing to do.`);
    } else {
      for (const file of copied) console.log(`copied  ${file}`);
      for (const file of removed) console.log(`removed ${file}`);
      console.log(`Synced plugin skill copy: ${copied.length} copied, ${removed.length} removed.`);
    }
    // Post-swap problems: the mirror is already correct, so these are warnings
    // on a successful run, not failures.
    for (const warning of warnings) console.error(`warning: ${warning}`);

    const remaining = describeComparison(compareTrees(canonicalRoot, mirrorRoot));
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
