#!/usr/bin/env tsx
/**
 * Verify the plugin's copy of the mainwp-dashboard skill is byte-identical to
 * the canonical copy in `.agents/`.
 *
 * The two trees exist because Claude Code loads the skill from the plugin
 * while other agent runtimes read `.agents/`. Editing one and forgetting the
 * other ships two different sets of safety instructions, which is worse than
 * shipping none, so drift is a build failure rather than a warning.
 *
 * Usage: npm run check-skill-sync   (npm run sync-skill fixes the drift)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const CANONICAL_SKILL_DIR = path.join(REPO_ROOT, '.agents', 'skills', 'mainwp-dashboard');
export const MIRROR_SKILL_DIR = path.join(
  REPO_ROOT,
  'plugins',
  'mainwp',
  'skills',
  'mainwp-dashboard'
);

export interface TreeComparison {
  /** Present in the canonical tree, absent from the mirror. */
  missing: string[];
  /** Present in the mirror, absent from the canonical tree. */
  extra: string[];
  /** Present in both with different bytes. */
  differing: string[];
}

/**
 * Absolute paths of every regular file under `dir`, sorted.
 *
 * Anything that is not a regular file or a real directory - a symlink first of
 * all, but also a socket, fifo, or device node - throws instead of being
 * skipped. A skipped entry is invisible to the byte comparison and to the
 * mirror cleanup, so both trees would compare clean while the plugin copy
 * pointed somewhere else entirely.
 *
 * That includes `dir` itself: resolving a symlinked root would walk (and let
 * the sync write into) a tree somewhere else, which is the same hole one level
 * up. Paths are returned under the resolved root, so callers never traverse
 * the link either.
 */
export function listFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const root = resolveTreeRoot(dir);
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(`Unsupported entry (not a regular file or directory): ${full}`);
      }
      if (entry.isDirectory()) {
        const real = fs.realpathSync(full);
        if (real !== root && !real.startsWith(root + path.sep)) {
          throw new Error(`Directory escapes the skill tree: ${full}`);
        }
        walk(full);
      } else {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Real path of a tree root, refusing a root that is itself a symlink. Callers
 * that read or write inside the tree use the result, not the given path.
 */
export function resolveTreeRoot(dir: string): string {
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error(`Skill tree root is a symlink: ${dir}`);
  }
  return fs.realpathSync(dir);
}

/** Relative paths of every file under `dir`, POSIX-separated and sorted. */
export function listRelativeFiles(dir: string): string[] {
  const files = listFilesUnder(dir);
  if (files.length === 0) return [];
  const root = resolveTreeRoot(dir);
  return files.map(full => path.relative(root, full).split(path.sep).join('/'));
}

/**
 * Fail before "in sync" can be reported for a tree that holds nothing worth
 * mirroring: an empty canonical directory and a missing mirror compare clean.
 * Returns the canonical file list so callers do not walk twice.
 */
export function assertUsableCanonicalTree(dir: string): string[] {
  const files = listRelativeFiles(dir);
  if (!files.includes('SKILL.md')) {
    throw new Error(`Canonical skill tree has no SKILL.md: ${dir}`);
  }
  const skillFile = path.join(resolveTreeRoot(dir), 'SKILL.md');
  if (fs.statSync(skillFile).size === 0) {
    throw new Error(`Canonical SKILL.md is empty: ${skillFile}`);
  }
  return files;
}

export function compareTrees(canonicalDir: string, mirrorDir: string): TreeComparison {
  const canonical = new Set(listRelativeFiles(canonicalDir));
  const mirror = new Set(listRelativeFiles(mirrorDir));

  const missing = [...canonical].filter(file => !mirror.has(file));
  const extra = [...mirror].filter(file => !canonical.has(file));
  const shared = [...canonical].filter(file => mirror.has(file));
  // Both roots exist and are not symlinks once a shared file was listed.
  const canonicalRoot = shared.length > 0 ? resolveTreeRoot(canonicalDir) : canonicalDir;
  const mirrorRoot = shared.length > 0 ? resolveTreeRoot(mirrorDir) : mirrorDir;
  const differing = shared.filter(
    file =>
      !fs
        .readFileSync(path.join(canonicalRoot, file))
        .equals(fs.readFileSync(path.join(mirrorRoot, file)))
  );

  return { missing, extra, differing };
}

export function describeComparison(comparison: TreeComparison): string[] {
  return [
    ...comparison.missing.map(file => `missing from plugin copy: ${file}`),
    ...comparison.extra.map(file => `only in plugin copy: ${file}`),
    ...comparison.differing.map(file => `content differs: ${file}`),
  ];
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
  let count: number;
  try {
    count = assertUsableCanonicalTree(CANONICAL_SKILL_DIR).length;
    const problems = describeComparison(compareTrees(CANONICAL_SKILL_DIR, MIRROR_SKILL_DIR));
    if (problems.length > 0) {
      console.error(`Skill copies are out of sync (${problems.length} problem(s)):`);
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('Run `npm run sync-skill` to make the plugin copy match .agents/.');
      process.exit(1);
    }
  } catch (error) {
    console.error(`Skill sync check failed: ${(error as Error).message}`);
    process.exit(1);
  }
  console.log(`Skill copies are in sync: ${count} file(s) identical.`);
}
