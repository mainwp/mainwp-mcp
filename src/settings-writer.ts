/**
 * Persistence for first-run setup.
 *
 * The only file-writing module in src/. It writes exactly the three connection
 * fields, only to the trusted per-user config path, and never to the
 * working-directory settings.json (which the loader would prefer and which is
 * untrusted input).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getErrorMessage } from './errors.js';

/** The three fields setup is allowed to write. Nothing else is touchable. */
export interface ConnectionSettings {
  dashboardUrl: string;
  username: string;
  appPassword: string;
}

/** Refusal to write, carrying a message safe to show the user. */
export class SettingsWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SettingsWriteError';
  }
}

/** Directory holding the trusted per-user configuration file. */
export function trustedSettingsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, '.config', 'mainwp-mcp');
}

/** Path of the trusted per-user configuration file. */
export function trustedSettingsPath(homeDir = os.homedir()): string {
  return path.join(trustedSettingsDir(homeDir), 'settings.json');
}

function ensureDirectory(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new SettingsWriteError(
      `Could not create the configuration directory (${getErrorMessage(error)})`,
      { cause: error }
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(dir);
  } catch (error) {
    throw new SettingsWriteError(
      `Could not inspect the configuration directory (${getErrorMessage(error)})`,
      { cause: error }
    );
  }
  if (!stats.isDirectory()) {
    throw new SettingsWriteError(
      'The configuration directory path exists but is not a directory. Move it aside and try again.'
    );
  }
  // mkdir's mode applies only to directories it creates, so an existing
  // group/world-accessible directory would keep a credential file readable by
  // other local accounts. Tighten it, and refuse if that fails.
  if (stats.mode & 0o077) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (error) {
      throw new SettingsWriteError(
        `The configuration directory is readable by other users and its permissions could not be tightened (${getErrorMessage(error)})`,
        { cause: error }
      );
    }
  }
}

/**
 * Identity of the target as observed at one moment, or null when it does not
 * exist. Compared again just before the rename so a file another process
 * created or replaced in between is not silently clobbered.
 */
interface TargetStamp {
  ino: number;
  mtimeMs: number;
  size: number;
}

function stampTarget(target: string): TargetStamp | null {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return null;
  }
  // lstat, not stat: a symlink here would redirect the write to a file the
  // attacker chose, and a fifo would block the process.
  if (!stats.isFile()) {
    throw new SettingsWriteError(
      'The configuration file path is not a regular file (symlink, directory, or device). Remove it and try again.'
    );
  }
  return { ino: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size };
}

function sameTarget(before: TargetStamp | null, now: TargetStamp | null): boolean {
  if (before === null || now === null) {
    return before === now;
  }
  return before.ino === now.ino && before.mtimeMs === now.mtimeMs && before.size === now.size;
}

function readExistingSettings(target: string): Record<string, unknown> {
  let content: string;
  try {
    content = fs.readFileSync(target, 'utf-8');
  } catch (error) {
    throw new SettingsWriteError(
      `The existing configuration file could not be read (${getErrorMessage(error)})`,
      { cause: error }
    );
  }
  if (content.trim() === '') {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new SettingsWriteError(
      'The existing configuration file is not valid JSON. Nothing was changed; fix or remove the file and try again.'
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsWriteError(
      'The existing configuration file does not contain a JSON object. Nothing was changed; fix or remove the file and try again.'
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Write the three connection fields to the trusted per-user settings file,
 * preserving every other key already in it.
 *
 * Creates the file 0600 through an exclusively created temp file in the same
 * directory followed by a rename, so a reader never observes a half-written
 * credential file and no pre-existing temp path can be hijacked.
 *
 * @returns The path written.
 * @throws SettingsWriteError with a user-facing message; the file is unchanged.
 */
export function writeConnectionSettings(
  settings: ConnectionSettings,
  homeDir = os.homedir()
): string {
  const dir = trustedSettingsDir(homeDir);
  const target = trustedSettingsPath(homeDir);

  ensureDirectory(dir);
  const before = stampTarget(target);
  const existing = before === null ? {} : readExistingSettings(target);

  const merged = {
    ...existing,
    dashboardUrl: settings.dashboardUrl,
    username: settings.username,
    appPassword: settings.appPassword,
  };

  const tempPath = path.join(dir, `.settings.json.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle: number | undefined;
  try {
    // 'wx' fails if the path exists, so this never follows a planted symlink.
    handle = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8' });
    fs.closeSync(handle);
    handle = undefined;
    // The mutex around setup is per-process, so a second first-run server can
    // validate its own tuple and land here at the same time. Rename is atomic
    // but last-writer-wins, and each process would report success for a file
    // only one of them owns. Compare the target against what the merge was
    // built from and refuse rather than clobber. This closes the realistic
    // window (two servers started by the same user), not every interleaving:
    // a rename in the microseconds after this check still wins silently.
    if (!sameTarget(before, stampTarget(target))) {
      throw new SettingsWriteError(
        before === null
          ? 'Another process created the configuration file while this setup was running, so nothing was written. Check the file and try again if it does not already hold the right settings.'
          : 'The configuration file changed while this setup was running, so nothing was written. Check the file and try again if it does not already hold the right settings.'
      );
    }
    fs.renameSync(tempPath, target);
  } catch (error) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Nothing further to do; the unlink below is the cleanup that matters.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temp file may never have been created.
    }
    // A refusal raised above already carries a user-facing message; only real
    // filesystem failures need wrapping.
    if (error instanceof SettingsWriteError) {
      throw error;
    }
    throw new SettingsWriteError(
      `The configuration file could not be saved (${getErrorMessage(error)})`,
      { cause: error }
    );
  }

  return target;
}
