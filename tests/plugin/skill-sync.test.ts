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
  listFilesUnder,
  listRelativeFiles,
  resolveTreeRootWithin,
} from '../../scripts/check-skill-sync.js';
import { syncTree } from '../../scripts/sync-skill.js';

/**
 * Anchor for the fixture trees below. Every path component under the anchor is
 * symlink-checked, so the fixtures must anchor here and not at the repository
 * root: on macOS the temp directory itself sits behind the /var -> /private/var
 * link, which is above the anchor and therefore legitimately resolved.
 */
const ANCHOR = os.tmpdir();

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

  it('fails on a symlinked tree root instead of following it', () => {
    const real = tmpTree();
    fs.writeFileSync(path.join(real, 'SKILL.md'), 'body');
    const link = path.join(tmpTree(), 'linked-root');
    fs.symlinkSync(real, link);
    expect(() => listFilesUnder(link)).toThrow(/linked-root/);
    expect(() => listRelativeFiles(link)).toThrow(/linked-root/);
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

describe('resolveTreeRootWithin', () => {
  it('resolves a tree that exists under the anchor', () => {
    const anchor = tmpTree();
    const dir = path.join(anchor, 'skills', 'mainwp-dashboard');
    fs.mkdirSync(dir, { recursive: true });
    expect(resolveTreeRootWithin(anchor, dir)).toBe(
      path.join(fs.realpathSync(anchor), 'skills', 'mainwp-dashboard')
    );
  });

  it('resolves a path that does not exist yet', () => {
    const anchor = tmpTree();
    expect(resolveTreeRootWithin(anchor, path.join(anchor, 'skills', 'mainwp-dashboard'))).toBe(
      path.join(fs.realpathSync(anchor), 'skills', 'mainwp-dashboard')
    );
  });

  it('rejects a symlinked intermediate component', () => {
    const anchor = tmpTree();
    const outside = tmpTree();
    fs.mkdirSync(path.join(outside, 'mainwp-dashboard'));
    fs.symlinkSync(outside, path.join(anchor, 'skills'));
    expect(() =>
      resolveTreeRootWithin(anchor, path.join(anchor, 'skills', 'mainwp-dashboard'))
    ).toThrow(/skills/);
  });

  it('rejects a path outside the anchor', () => {
    const anchor = tmpTree();
    expect(() => resolveTreeRootWithin(anchor, tmpTree())).toThrow(/outside/);
  });
});

describe('syncTree', () => {
  it('copies missing files and removes extra ones', () => {
    const canonical = tmpTree();
    const mirror = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');
    fs.writeFileSync(path.join(mirror, 'stale.md'), 'body');
    expect(syncTree(canonical, mirror, ANCHOR)).toEqual({
      copied: ['SKILL.md'],
      removed: ['stale.md'],
      warnings: [],
    });
    expect(listRelativeFiles(mirror)).toEqual(['SKILL.md']);
  });

  it('refuses to sync a mirror holding a symlink, leaving it in place', () => {
    const canonical = tmpTree();
    const mirror = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');
    fs.symlinkSync(path.join(canonical, 'SKILL.md'), path.join(mirror, 'shadow.md'));
    expect(() => syncTree(canonical, mirror, ANCHOR)).toThrow(/shadow\.md/);
    expect(fs.existsSync(path.join(mirror, 'SKILL.md'))).toBe(false);
  });

  it('refuses to sync a symlink out of the canonical tree', () => {
    const canonical = tmpTree();
    const mirror = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');
    fs.symlinkSync(path.join(canonical, 'SKILL.md'), path.join(canonical, 'shadow.md'));
    expect(() => syncTree(canonical, mirror, ANCHOR)).toThrow(/shadow\.md/);
  });

  it('refuses to write through a symlinked mirror root', () => {
    const canonical = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');
    const target = tmpTree();
    const mirrorLink = path.join(tmpTree(), 'linked-mirror');
    fs.symlinkSync(target, mirrorLink);
    expect(() => syncTree(canonical, mirrorLink, ANCHOR)).toThrow(/linked-mirror/);
    expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(false);
  });

  it('replaces a colliding mirror wholesale instead of half-writing it', () => {
    const canonical = tmpTree();
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'new');
    fs.mkdirSync(path.join(canonical, 'references'));
    fs.writeFileSync(path.join(canonical, 'references', 'errors.md'), 'new');

    const mirror = tmpTree();
    fs.writeFileSync(path.join(mirror, 'SKILL.md'), 'old');
    // A file where the canonical tree has a directory: copying in place fails
    // partway through, after SKILL.md has already been overwritten.
    fs.writeFileSync(path.join(mirror, 'references'), 'not a directory');

    expect(syncTree(canonical, mirror, ANCHOR).copied).toEqual([
      'SKILL.md',
      'references/errors.md',
    ]);
    expect(listRelativeFiles(mirror)).toEqual(['SKILL.md', 'references/errors.md']);
    expect(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8')).toBe('new');
  });

  it('refuses to write through a symlinked ancestor of the mirror root', () => {
    const anchor = tmpTree();
    const canonical = path.join(anchor, 'canonical');
    fs.mkdirSync(canonical);
    fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'body');

    const outside = tmpTree();
    fs.mkdirSync(path.join(outside, 'mainwp-dashboard'));
    fs.symlinkSync(outside, path.join(anchor, 'skills'));

    const mirror = path.join(anchor, 'skills', 'mainwp-dashboard');
    expect(() => syncTree(canonical, mirror, anchor)).toThrow(/skills/);
    // Nothing staged, copied, or renamed on the far side of the link.
    expect(fs.readdirSync(path.join(outside, 'mainwp-dashboard'))).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual(['mainwp-dashboard']);
  });

  it('refuses to read through a symlinked ancestor of the canonical root', () => {
    const anchor = tmpTree();
    const mirror = path.join(anchor, 'mirror');
    fs.mkdirSync(mirror);

    const outside = tmpTree();
    fs.mkdirSync(path.join(outside, 'mainwp-dashboard'));
    fs.writeFileSync(path.join(outside, 'mainwp-dashboard', 'SKILL.md'), 'body');
    fs.symlinkSync(outside, path.join(anchor, 'agents'));

    const canonical = path.join(anchor, 'agents', 'mainwp-dashboard');
    expect(() => syncTree(canonical, mirror, anchor)).toThrow(/agents/);
    expect(fs.readdirSync(mirror)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports success with a warning when the replaced mirror cannot be removed',
    () => {
      const anchor = tmpTree();
      const canonical = path.join(anchor, 'canonical');
      fs.mkdirSync(canonical);
      fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'new');

      const mirror = path.join(anchor, 'mirror');
      fs.mkdirSync(mirror);
      fs.writeFileSync(path.join(mirror, 'SKILL.md'), 'old');
      // Read-only directory: it can still be renamed aside, but its contents
      // cannot be unlinked, so removing the replaced copy fails after the
      // swap has already committed.
      fs.chmodSync(mirror, 0o500);
      try {
        const result = syncTree(canonical, mirror, anchor);
        expect(result.copied).toEqual(['SKILL.md']);
        expect(result.warnings).toEqual([expect.stringContaining('.replaced-')]);
        expect(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8')).toBe('new');

        // A rerun still converges despite the leftover backup.
        fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'newer');
        expect(syncTree(canonical, mirror, anchor).copied).toEqual(['SKILL.md']);
        expect(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8')).toBe('newer');
      } finally {
        for (const entry of fs.readdirSync(anchor)) {
          const full = path.join(anchor, entry);
          if (fs.statSync(full).isDirectory()) fs.chmodSync(full, 0o700);
        }
      }
    }
  );

  it.skipIf(process.getuid?.() === 0)(
    'leaves the old mirror in place when the new copy cannot be staged',
    () => {
      const canonical = tmpTree();
      fs.writeFileSync(path.join(canonical, 'SKILL.md'), 'new');

      const parent = tmpTree();
      const mirror = path.join(parent, 'mainwp-dashboard');
      fs.mkdirSync(mirror);
      fs.writeFileSync(path.join(mirror, 'SKILL.md'), 'old');
      fs.chmodSync(parent, 0o500);
      try {
        expect(() => syncTree(canonical, mirror, ANCHOR)).toThrow();
        expect(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8')).toBe('old');
      } finally {
        fs.chmodSync(parent, 0o700);
      }
    }
  );
});
