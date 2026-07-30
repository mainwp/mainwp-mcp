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

/** Relative paths of every file under `dir`, POSIX-separated and sorted. */
export function listRelativeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

export function compareTrees(canonicalDir: string, mirrorDir: string): TreeComparison {
  const canonical = new Set(listRelativeFiles(canonicalDir));
  const mirror = new Set(listRelativeFiles(mirrorDir));

  const missing = [...canonical].filter(file => !mirror.has(file));
  const extra = [...mirror].filter(file => !canonical.has(file));
  const differing = [...canonical]
    .filter(file => mirror.has(file))
    .filter(
      file =>
        !fs
          .readFileSync(path.join(canonicalDir, file))
          .equals(fs.readFileSync(path.join(mirrorDir, file)))
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
  if (!fs.existsSync(CANONICAL_SKILL_DIR)) {
    console.error(`Canonical skill directory is missing: ${CANONICAL_SKILL_DIR}`);
    process.exit(1);
  }
  const problems = describeComparison(compareTrees(CANONICAL_SKILL_DIR, MIRROR_SKILL_DIR));
  if (problems.length > 0) {
    console.error(`Skill copies are out of sync (${problems.length} problem(s)):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Run `npm run sync-skill` to make the plugin copy match .agents/.');
    process.exit(1);
  }
  const count = listRelativeFiles(CANONICAL_SKILL_DIR).length;
  console.log(`Skill copies are in sync: ${count} file(s) identical.`);
}
