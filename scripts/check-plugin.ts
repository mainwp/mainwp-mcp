#!/usr/bin/env tsx
/**
 * Static gate for the Claude Code plugin content in `.claude-plugin/`,
 * `plugins/`, and `.agents/`.
 *
 * None of this ships in the npm package, so nothing else validates it: a
 * marketplace or plugin manifest that Claude Code refuses to load, a command
 * with no description, a skill whose `name` no longer matches its directory,
 * or a stale tool-name literal would all reach users unnoticed.
 *
 * The validators are exported as pure functions so `tests/plugin/manifest.test.ts`
 * can drive them with broken fixtures; the CLI below is only the file-reading
 * shell around them.
 *
 * Usage: npm run check-plugin
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared with the skill-sync gate so both walkers reject the same entries: a
// symlink that neither script can see would pass every check below.
import { listFilesUnder as listFiles } from './check-skill-sync.js';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The plugin's MCP config is byte-for-byte fixed by design. In particular it
 * carries no `env` map: the server inherits credentials from the user's own
 * environment, so any env block here would either be dead weight or a place
 * for a credential to get committed.
 */
export const EXPECTED_MCP_CONFIG = {
  mcpServers: {
    mainwp: {
      command: 'npx',
      args: ['-y', '@mainwp/mcp'],
    },
  },
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function join(prefix: string, key: string | number): string {
  return prefix === '' ? String(key) : `${prefix}.${key}`;
}

/**
 * Deep-compare `actual` against `expected` and describe every difference by
 * its path, so a failure says which key was added, removed, or changed rather
 * than dumping two blobs.
 */
export function diffJson(expected: unknown, actual: unknown, atPath = ''): string[] {
  const label = atPath === '' ? 'root' : `"${atPath}"`;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [`${label}: expected an array, got ${show(actual)}`];
    }
    if (expected.length !== actual.length) {
      return [`${label}: expected ${expected.length} entries, got ${actual.length}`];
    }
    return expected.flatMap((entry, index) => diffJson(entry, actual[index], join(atPath, index)));
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return [`${label}: expected an object, got ${show(actual)}`];
    }
    const problems: string[] = [];
    for (const [key, value] of Object.entries(expected)) {
      const childPath = join(atPath, key);
      if (!Object.prototype.hasOwnProperty.call(actual, key)) {
        problems.push(`missing key "${childPath}"`);
        continue;
      }
      problems.push(...diffJson(value, actual[key], childPath));
    }
    for (const key of Object.keys(actual)) {
      if (!Object.prototype.hasOwnProperty.call(expected, key)) {
        problems.push(`unexpected key "${join(atPath, key)}"`);
      }
    }
    return problems;
  }

  if (expected !== actual) {
    return [`${label}: expected ${show(expected)}, got ${show(actual)}`];
  }
  return [];
}

/**
 * Minimal frontmatter reader for the `key: value` block Claude Code commands
 * and skills use. Deliberately not a YAML parser: nothing here nests, and
 * pulling in a dependency for a check script is not worth it.
 */
export function parseFrontmatter(source: string): Record<string, string> | null {
  const normalized = source.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(normalized)) return null;
  const lines = normalized.split(/\r?\n/).slice(1);
  const end = lines.findIndex(line => line.trim() === '---');
  if (end === -1) return null;

  const fields: Record<string, string> = {};
  for (const line of lines.slice(0, end)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    fields[match[1]] = value;
  }
  return fields;
}

function requireString(
  data: Record<string, unknown>,
  key: string,
  label: string,
  problems: string[]
): void {
  const value = data[key];
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${label}: "${key}" must be a non-empty string (got ${show(value)})`);
  }
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

const PLUGIN_SOURCE_PREFIX = './plugins/';

/**
 * A marketplace source must stay inside this repository's `plugins/`
 * directory. A URL, an absolute path, or a `..` hop would install plugin code
 * that nothing in this checkout reviews or gates.
 */
function isLocalPluginSource(source: string): boolean {
  // Sources are POSIX paths. A backslash is an ordinary character to the split
  // below but a separator on Windows, where "./plugins/..\outside" resolves
  // outside plugins/ entirely.
  if (source.includes('\\')) return false;
  if (!source.startsWith(PLUGIN_SOURCE_PREFIX)) return false;
  const segments = source.slice(PLUGIN_SOURCE_PREFIX.length).split('/');
  return segments.length > 0 && segments.every(segment => segment !== '' && segment !== '..');
}

export function validateMarketplace(data: unknown, label: string): string[] {
  if (!isPlainObject(data)) return [`${label}: expected a JSON object, got ${show(data)}`];

  const problems: string[] = [];
  requireString(data, 'name', label, problems);

  if (!isPlainObject(data.owner)) {
    problems.push(`${label}: "owner" must be an object with a "name" (got ${show(data.owner)})`);
  } else if (typeof data.owner.name !== 'string' || data.owner.name.trim() === '') {
    problems.push(`${label}: "owner.name" must be a non-empty string`);
  }

  if (!Array.isArray(data.plugins) || data.plugins.length === 0) {
    problems.push(`${label}: "plugins" must be a non-empty array`);
  } else {
    const seen = new Set<string>();
    data.plugins.forEach((entry, index) => {
      const at = `${label}: plugins[${index}]`;
      if (!isPlainObject(entry)) {
        problems.push(`${at} must be an object`);
        return;
      }
      // The entry name is the plugin's installed identity: it decides how the
      // plugin is referenced and, with the marketplace name, what prefix its
      // MCP tools get. An unnamed or renamed entry is a silent break.
      const name = entry.name;
      if (typeof name !== 'string' || name.trim() === '') {
        problems.push(`${at} "name" must be a non-empty string (got ${show(name)})`);
      } else if (seen.has(name)) {
        problems.push(`${at} duplicate plugin name "${name}"`);
      } else {
        seen.add(name);
      }

      if (typeof entry.source !== 'string' || entry.source.trim() === '') {
        problems.push(`${at} "source" must be a non-empty string`);
      } else if (!isLocalPluginSource(entry.source)) {
        problems.push(
          `${at} "source" must be a relative path under ${PLUGIN_SOURCE_PREFIX} (got ${show(entry.source)})`
        );
      }
    });
  }

  return problems;
}

export function validatePluginManifest(
  data: unknown,
  label: string,
  expectedName?: string
): string[] {
  if (!isPlainObject(data)) return [`${label}: expected a JSON object, got ${show(data)}`];

  const problems: string[] = [];
  for (const key of ['name', 'description', 'version', 'license']) {
    requireString(data, key, label, problems);
  }

  if (expectedName !== undefined && typeof data.name === 'string' && data.name !== expectedName) {
    problems.push(
      `${label}: "name" is ${show(data.name)} but the marketplace entry references it as "${expectedName}"`
    );
  }

  const author = data.author;
  const authorOk =
    (typeof author === 'string' && author.trim() !== '') ||
    (isPlainObject(author) && typeof author.name === 'string' && author.name.trim() !== '');
  if (!authorOk) {
    problems.push(`${label}: "author" must be a name string or an object with a "name"`);
  }

  return problems;
}

export function validateCommandFile(source: string, label: string): string[] {
  const fields = parseFrontmatter(source);
  if (!fields) return [`${label}: missing YAML frontmatter block`];
  if (!fields.description || fields.description.trim() === '') {
    return [`${label}: frontmatter "description" is missing or empty`];
  }
  return [];
}

export function validateSkillFile(source: string, dirName: string, label: string): string[] {
  const fields = parseFrontmatter(source);
  if (!fields) return [`${label}: missing YAML frontmatter block`];

  const problems: string[] = [];
  const name = fields.name?.trim() ?? '';
  const description = fields.description?.trim() ?? '';
  if (name === '') {
    problems.push(`${label}: frontmatter "name" is missing or empty`);
  } else if (name !== dirName) {
    problems.push(`${label}: frontmatter name "${name}" does not match directory "${dirName}"`);
  }
  if (description === '') {
    problems.push(`${label}: frontmatter "description" is missing or empty`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Content rules
// ---------------------------------------------------------------------------

/**
 * Tool names come from the live ability catalog at runtime. A hardcoded
 * `something_v1` in guidance is either already stale or teaches the agent to
 * guess names instead of listing them.
 */
const VERSIONED_TOOL_NAME = /\b[a-z0-9_]+_v\d+\b/;

/**
 * `/mcp__server__prompt` is the client-side slash form of an MCP prompt. A
 * command that tells the agent to invoke one is describing the plumbing the
 * command itself replaces.
 */
const MCP_SLASH_LITERAL = '/mcp__';

/**
 * Assignment-shaped credential literal: a secret-sounding key followed by `=`
 * or `:` and a value. Naming the variables in prose or frontmatter stays
 * unmatched, because neither assigns anything.
 */
const CREDENTIAL_ASSIGNMENT =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY)[A-Za-z0-9_]*)["'`]?\s*([:=])\s*("[^"\n]*"|'[^'\n]*'|[^\s\n]+)/gi;

/** Values that obviously stand in for a real secret rather than being one. */
const PLACEHOLDER_VALUE =
  /^(?:<[^>]*>?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{.*\}\}|x{3,}|\*{3,}|\.{3}|-|changeme|change_me|redacted|placeholder|example|unset|set|none|null|true|false|your[-_a-z]*)$/i;

export function scanContent(source: string, label: string): string[] {
  const problems: string[] = [];

  source.split(/\r?\n/).forEach((line, index) => {
    const at = `${label}:${index + 1}`;

    const versioned = VERSIONED_TOOL_NAME.exec(line);
    if (versioned) {
      problems.push(`${at}: versioned tool-name literal "${versioned[0]}"`);
    }

    if (line.includes(MCP_SLASH_LITERAL)) {
      problems.push(`${at}: "${MCP_SLASH_LITERAL}" slash-command literal`);
    }

    CREDENTIAL_ASSIGNMENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREDENTIAL_ASSIGNMENT.exec(line)) !== null) {
      const [full, key, operator, rawValue] = match;
      const value = rawValue.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
      if (value === '' || PLACEHOLDER_VALUE.test(value)) continue;
      // A colon in markdown is usually punctuation, not assignment. Treat it as
      // a leak only when the value ends the line and does not read like an
      // English word, so "`MAINWP_TOKEN`: compatibility input" stays prose.
      if (operator === ':') {
        const trailing = line.slice(match.index + full.length).trim();
        const quoted = /^['"]/.test(rawValue);
        if (!quoted && (trailing !== '' || /^[a-z]+$/.test(value))) continue;
      }
      problems.push(`${at}: credential-shaped literal assigned to "${key}"`);
    }
  });

  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SCANNED_TREES = ['plugins', '.agents'];
const SCANNED_EXTENSIONS = new Set(['.md', '.json', '.yml', '.yaml', '.txt']);

function rel(fullPath: string): string {
  return path.relative(REPO_ROOT, fullPath);
}

function readJson(fullPath: string, problems: string[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    problems.push(`${rel(fullPath)}: not valid JSON (${(error as Error).message})`);
    return undefined;
  }
}

export function checkRepository(repoRoot: string): string[] {
  const problems: string[] = [];

  const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(marketplacePath)) {
    problems.push(`${rel(marketplacePath)}: missing`);
    return problems;
  }

  const marketplace = readJson(marketplacePath, problems);
  problems.push(...validateMarketplace(marketplace, rel(marketplacePath)));

  // validateMarketplace already reported invalid sources; traversing them
  // anyway would resolve and stat paths outside the containment boundary.
  const entries =
    isPlainObject(marketplace) && Array.isArray(marketplace.plugins)
      ? marketplace.plugins
          .filter(isPlainObject)
          .filter(entry => typeof entry.source === 'string' && isLocalPluginSource(entry.source))
      : [];

  for (const entry of entries) {
    const source = entry.source as string;
    const expectedName = typeof entry.name === 'string' ? entry.name : undefined;
    const pluginDir = path.resolve(repoRoot, source);
    if (!fs.existsSync(pluginDir) || !fs.statSync(pluginDir).isDirectory()) {
      problems.push(`marketplace.json: source "${source}" is not a directory`);
      continue;
    }

    const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      problems.push(`marketplace.json: source "${source}" has no .claude-plugin/plugin.json`);
      continue;
    }
    problems.push(
      ...validatePluginManifest(readJson(manifestPath, problems), rel(manifestPath), expectedName)
    );

    const mcpPath = path.join(pluginDir, '.mcp.json');
    if (!fs.existsSync(mcpPath)) {
      problems.push(`${rel(mcpPath)}: missing`);
    } else {
      const mcpConfig = readJson(mcpPath, problems);
      if (mcpConfig !== undefined) {
        problems.push(
          ...diffJson(EXPECTED_MCP_CONFIG, mcpConfig).map(
            difference => `${rel(mcpPath)}: ${difference}`
          )
        );
      }
    }

    const commandsDir = path.join(pluginDir, 'commands');
    const commandFiles = listFiles(commandsDir).filter(file => file.endsWith('.md'));
    if (commandFiles.length === 0) {
      problems.push(`${rel(commandsDir)}: no command files found`);
    }
    for (const file of commandFiles) {
      problems.push(...validateCommandFile(fs.readFileSync(file, 'utf8'), rel(file)));
    }
  }

  const skillFiles = SCANNED_TREES.flatMap(tree =>
    listFiles(path.join(repoRoot, tree)).filter(file => path.basename(file) === 'SKILL.md')
  );
  if (skillFiles.length === 0) {
    problems.push('no SKILL.md found under plugins/ or .agents/');
  }
  for (const file of skillFiles) {
    const dirName = path.basename(path.dirname(file));
    problems.push(...validateSkillFile(fs.readFileSync(file, 'utf8'), dirName, rel(file)));
  }

  for (const tree of SCANNED_TREES) {
    for (const file of listFiles(path.join(repoRoot, tree))) {
      if (!SCANNED_EXTENSIONS.has(path.extname(file))) continue;
      problems.push(...scanContent(fs.readFileSync(file, 'utf8'), rel(file)));
    }
  }

  return problems;
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
  let problems: string[];
  try {
    problems = checkRepository(REPO_ROOT);
  } catch (error) {
    console.error(`Plugin check failed: ${(error as Error).message}`);
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(`Plugin check failed with ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('Plugin check passed: manifests, commands, skills, .mcp.json, and content rules.');
}
