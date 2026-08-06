/**
 * Settings writer tests.
 *
 * The only file-writing path in src/, and it writes credentials, so the
 * permission, atomicity, and refusal contracts get direct coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SettingsWriteError,
  trustedSettingsDir,
  trustedSettingsPath,
  writeConnectionSettings,
} from './settings-writer.js';

const CONNECTION = {
  dashboardUrl: 'https://dashboard.example.com',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
};

describe('writeConnectionSettings', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcp-writer-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore any permissions a test tightened so cleanup can remove the tree.
    const dir = trustedSettingsDir(home);
    if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  /**
   * Run the write with another process landing its own settings.json while our
   * temp file is being written — the window the per-process setup mutex cannot
   * cover.
   */
  function writeWithCompetingWriter(competing: string): void {
    const realWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      realWriteFileSync(file as never, data as never, options as never);
      realWriteFileSync(trustedSettingsPath(home), competing);
    });
    writeConnectionSettings(CONNECTION, home);
  }

  it('refuses when another process creates the config file mid-write', () => {
    const competing = JSON.stringify({ dashboardUrl: 'https://other.example.com' });

    expect(() => writeWithCompetingWriter(competing)).toThrow(/created the configuration file/);

    vi.restoreAllMocks();
    expect(fs.readFileSync(trustedSettingsPath(home), 'utf-8')).toBe(competing);
    expect(fs.readdirSync(trustedSettingsDir(home))).toEqual(['settings.json']);
  });

  it('refuses when the config file it read is replaced mid-write', () => {
    const dir = trustedSettingsDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(trustedSettingsPath(home), JSON.stringify({ safeMode: true }));
    const competing = JSON.stringify({
      dashboardUrl: 'https://other.example.com',
      safeMode: false,
    });

    expect(() => writeWithCompetingWriter(competing)).toThrow(
      /changed while this setup was running/
    );

    vi.restoreAllMocks();
    expect(fs.readFileSync(trustedSettingsPath(home), 'utf-8')).toBe(competing);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('creates the config file 0600 inside a 0700 directory', () => {
    const written = writeConnectionSettings(CONNECTION, home);

    expect(written).toBe(trustedSettingsPath(home));
    expect(fs.statSync(written).mode & 0o777).toBe(0o600);
    expect(fs.statSync(trustedSettingsDir(home)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(written, 'utf-8'))).toEqual(CONNECTION);
  });

  it('tightens an existing group- and world-readable config directory', () => {
    const dir = trustedSettingsDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);

    writeConnectionSettings(CONNECTION, home);

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('overwrites only the three connection fields and preserves the rest', () => {
    const dir = trustedSettingsDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      trustedSettingsPath(home),
      JSON.stringify({
        dashboardUrl: 'https://old.example.com',
        username: 'old',
        appPassword: 'old password value',
        safeMode: true,
        blockedTools: ['delete_site_v1'],
      })
    );

    writeConnectionSettings(CONNECTION, home);

    expect(JSON.parse(fs.readFileSync(trustedSettingsPath(home), 'utf-8'))).toEqual({
      ...CONNECTION,
      safeMode: true,
      blockedTools: ['delete_site_v1'],
    });
  });

  it('refuses to write when the existing file is malformed JSON and leaves it untouched', () => {
    const dir = trustedSettingsDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(trustedSettingsPath(home), '{ not json');

    expect(() => writeConnectionSettings(CONNECTION, home)).toThrow(SettingsWriteError);
    expect(fs.readFileSync(trustedSettingsPath(home), 'utf-8')).toBe('{ not json');
  });

  it('refuses a JSON array as the existing file', () => {
    const dir = trustedSettingsDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(trustedSettingsPath(home), '[]');

    expect(() => writeConnectionSettings(CONNECTION, home)).toThrow(/JSON object/);
  });

  it('refuses when the target is a symlink instead of a regular file', () => {
    const dir = trustedSettingsDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const decoy = path.join(home, 'decoy.json');
    fs.writeFileSync(decoy, '{}');
    fs.symlinkSync(decoy, trustedSettingsPath(home));

    expect(() => writeConnectionSettings(CONNECTION, home)).toThrow(/not a regular file/);
    expect(fs.readFileSync(decoy, 'utf-8')).toBe('{}');
  });

  it('refuses when the existing config file cannot be inspected', () => {
    const dir = trustedSettingsDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Only the target throws: the directory lstat in ensureDirectory has to
    // keep working, or the test would pass on the wrong refusal.
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (target === trustedSettingsPath(home)) {
        throw Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES' });
      }
      return realLstatSync(target as never, options as never);
    }) as typeof fs.lstatSync);

    const attempt = () => writeConnectionSettings(CONNECTION, home);
    expect(attempt).toThrow(SettingsWriteError);
    expect(attempt).toThrow(/could not be inspected.*EACCES/s);

    vi.restoreAllMocks();
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses when the config directory path is a symlink', () => {
    // A plain file there fails in mkdirSync instead, which is a different
    // refusal. mkdir -p is happy with a symlink that resolves to a directory,
    // so the lstat check is the only thing standing between a planted link and
    // a credential file written wherever it points.
    fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, trustedSettingsDir(home));

    expect(() => writeConnectionSettings(CONNECTION, home)).toThrow(
      /exists but is not a directory/
    );
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('leaves no temp file and no target behind when the write fails', () => {
    const dir = trustedSettingsDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Mocked rather than provoked with chmod: a suite running as root ignores
    // directory permissions, so the permission trick would not fail the write
    // at all. The failure lands after the temp file exists, which is the state
    // the cleanup path has to unwind.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied, write'), { code: 'EACCES' });
    });

    expect(() => writeConnectionSettings(CONNECTION, home)).toThrow(SettingsWriteError);

    vi.restoreAllMocks();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
