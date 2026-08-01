/**
 * Tree-walker gates for the skill mirror.
 *
 * The canonical `.agents/` copy and the plugin mirror are compared file by
 * file, so anything the walker cannot see compares clean in both trees. These
 * tests drive the exported helpers against temporary trees containing the
 * entries the walker must refuse: symlinks, and an empty canonical tree that
 * would otherwise report "0 file(s) identical" as success.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertUsableCanonicalTree,
  compareTrees,
  listRelativeFiles,
} from '../../scripts/check-skill-sync.js';
import { syncTree } from '../../scripts/sync-skill.js';

const created: string[] = [];

function tmpTree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-skill-sync-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('listRelativeFiles', () => {
  it('lists regular files in nested directories', () => {
    const root = tmpTree();
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'body');
    fs.mkdirSync(path.join(root, 'references'));
    fs.writeFileSync(path.join(root, 'references', 'errors.md'), 'body');
    expect(listRelativeFiles(root)).toEqual(['SKILL.md', 'references/errors.md']);
  });

  it('fails on a symlinked file instead of ignoring it', () => {
    const root = tmpTree();
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'body');
    fs.symlinkSync(path.join(root, 'SKILL.md'), path.join(root, 'linked.md'));
    expect(() => listRelativeFiles(root)).toThrow(/linked\.md/);
  });

  it('fails on a symlinked directory instead of ignoring it', () => {
    const root = tmpTree();
    const outside = tmpTree();
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'body');
    fs.writeFileSync(path.join(outside, 'outside.md'), 'body');
    fs.mkdirSync(path.join(root, 'references'));
    fs.symlinkSync(outside, path.join(root, 'references', 'elsewhere'));
    expect(() => listRelativeFiles(root)).toThrow(/elsewhere/);
  });
});

describe('assertUsableCanonicalTree', () => {
  it('returns the file list for a usable tree', () => {
    const root = tmpTree();
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'body');
    expect(assertUsableCanonicalTree(root)).toEqual(['SKILL.md']);
  });

  it('fails on an empty tree instead of reporting zero files in sync', () => {
    expect(() => assertUsableCanonicalTree(tmpTree())).toThrow(/SKILL\.md/);
  });

  it('fails on a missing tree', () => {
    const missing = path.join(tmpTree(), 'nope');
    expect(() => assertUsableCanonicalTree(missing)).toThrow(/nope/);
  });

  it('fails on an empty SKILL.md', () => {
    const root = tmpTree();
    fs.writeFileSync(path.join(root, 'SKILL.md'), '');
    expect(() => assertUsableCanonicalTree(root)).toThrow(/empty/);
  });
});

describe('compareTrees', () => {
  it('reports a real content difference', () => {
    const canonical = tmpTree();
    const mirror = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'new');
    fs.writeFileSync(path.join(mirror, 'SKILL.md'), 'old');
    expect(compareTrees(canonical, mirror)).toEqual({
      missing: [],
      extra: [],
      differing: ['SKILL.md'],
    });
  });

  it('fails on a symlink in the mirror instead of reporting the trees identical', () => {
    const canonical = tmpTree();
    const mirror = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');
    fs.writeFileSync(path.join(mirror, 'SKILL.md'), 'body');
    fs.symlinkSync(path.join(mirror, 'SKILL.md'), path.join(mirror, 'shadow.md'));
    expect(() => compareTrees(canonical, mirror)).toThrow(/shadow\.md/);
  });
});

describe('syncTree', () => {
  it('copies missing files and removes extra ones', () => {
    const canonical = tmpTree();
    const mirror = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');
    fs.writeFileSync(path.join(mirror, 'stale.md'), 'body');
    expect(syncTree(canonical, mirror)).toEqual({ copied: ['SKILL.md'], removed: ['stale.md'] });
    expect(listRelativeFiles(mirror)).toEqual(['SKILL.md']);
  });

  it('refuses to sync a mirror holding a symlink, leaving it in place', () => {
    const canonical = tmpTree();
    const mirror = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');
    fs.symlinkSync(path.join(canonical, 'SKILL.md'), path.join(mirror, 'shadow.md'));
    expect(() => syncTree(canonical, mirror)).toThrow(/shadow\.md/);
    expect(fs.existsSync(path.join(mirror, 'SKILL.md'))).toBe(false);
  });

  it('refuses to sync a symlink out of the canonical tree', () => {
    const canonical = tmpTree();
    const mirror = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');
    fs.symlinkSync(path.join(canonical, 'SKILL.md'), path.join(canonical, 'shadow.md'));
    expect(() => syncTree(canonical, mirror)).toThrow(/shadow\.md/);
  });
});
