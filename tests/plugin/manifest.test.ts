/**
 * Static gates for the Claude Code plugin content.
 *
 * Two layers:
 * 1. Structural assertions against the real files in `plugins/mainwp` — the
 *    command set is a fixed roster, and the eight wrapper commands only make
 *    sense while the server still publishes prompts of the same name.
 * 2. Negative unit tests for the validators in `scripts/check-plugin.ts`,
 *    driven by inline broken fixtures so a regression in the checker itself
 *    cannot pass silently.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPromptList } from '../../src/prompts.js';
import {
  EXPECTED_MCP_CONFIG,
  checkRepository,
  diffJson,
  scanContent,
  validateMarketplace,
  validatePluginManifest,
  validateCommandFile,
  validateSkillFile,
} from '../../scripts/check-plugin.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COMMANDS_DIR = path.join(REPO_ROOT, 'plugins', 'mainwp', 'commands');
const MARKETPLACE_PATH = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const PLUGIN_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'plugins',
  'mainwp',
  '.claude-plugin',
  'plugin.json'
);

/** The plugin identity the server registers under; a rename breaks tool names. */
const PLUGIN_NAME = 'mainwp';

function readJsonFile(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** Commands that wrap an MCP prompt of the same name published by the server. */
const PROMPT_WRAPPER_COMMANDS = [
  'maintenance-check',
  'network-summary',
  'security-audit',
  'backup-status',
  'update-workflow',
  'performance-check',
  'troubleshoot-site',
  'site-report',
];

/** Commands that are plugin-only and must never be treated as prompt wrappers. */
const STANDALONE_COMMANDS = ['setup', 'tools'];

function commandBasenames(): string[] {
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter(name => name.endsWith('.md'))
    .map(name => path.basename(name, '.md'))
    .sort();
}

describe('plugin command roster', () => {
  it('contains exactly the ten expected commands', () => {
    const expected = [...PROMPT_WRAPPER_COMMANDS, ...STANDALONE_COMMANDS].sort();
    expect(commandBasenames()).toEqual(expected);
  });

  it('backs every wrapper command with a server prompt of the same name', () => {
    const promptNames = new Set(getPromptList().map(prompt => prompt.name));
    for (const name of PROMPT_WRAPPER_COMMANDS) {
      expect(promptNames.has(name), `no MCP prompt named "${name}"`).toBe(true);
    }
  });

  it('keeps setup and tools as standalone commands, not prompt wrappers', () => {
    const promptNames = new Set(getPromptList().map(prompt => prompt.name));
    const names = commandBasenames();
    for (const name of STANDALONE_COMMANDS) {
      expect(names, `missing command file ${name}.md`).toContain(name);
      expect(promptNames.has(name), `"${name}" unexpectedly exists as an MCP prompt`).toBe(false);
    }
  });
});

describe('.mcp.json deep equality', () => {
  function actual(): Record<string, unknown> {
    return {
      mcpServers: { mainwp: { command: 'npx', args: ['-y', '@mainwp/mcp'] } },
    };
  }

  it('accepts the exact expected object', () => {
    expect(diffJson(EXPECTED_MCP_CONFIG, actual())).toEqual([]);
  });

  it('rejects an env map, naming the offending key', () => {
    const config = actual();
    (config.mcpServers as Record<string, Record<string, unknown>>).mainwp.env = {
      MAINWP_URL: 'https://example.com',
    };
    const problems = diffJson(EXPECTED_MCP_CONFIG, config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('mcpServers.mainwp.env');
    expect(problems[0]).toContain('unexpected');
  });

  it('rejects an empty env map', () => {
    const config = actual();
    (config.mcpServers as Record<string, Record<string, unknown>>).mainwp.env = {};
    expect(diffJson(EXPECTED_MCP_CONFIG, config)).toEqual([
      expect.stringContaining('mcpServers.mainwp.env'),
    ]);
  });

  it('rejects a swapped key', () => {
    const config = actual();
    const server = (config.mcpServers as Record<string, Record<string, unknown>>).mainwp;
    delete server.command;
    server.cmd = 'npx';
    const problems = diffJson(EXPECTED_MCP_CONFIG, config);
    expect(problems).toEqual([
      expect.stringContaining('mcpServers.mainwp.command'),
      expect.stringContaining('mcpServers.mainwp.cmd'),
    ]);
  });

  it('rejects an extra argument', () => {
    const config = actual();
    const server = (config.mcpServers as Record<string, Record<string, unknown>>).mainwp;
    server.args = ['-y', '@mainwp/mcp', '--verbose'];
    expect(diffJson(EXPECTED_MCP_CONFIG, config)).toEqual([
      expect.stringContaining('mcpServers.mainwp.args'),
    ]);
  });

  it('rejects a changed command value', () => {
    const config = actual();
    (config.mcpServers as Record<string, Record<string, unknown>>).mainwp.command = 'node';
    expect(diffJson(EXPECTED_MCP_CONFIG, config)).toEqual([
      expect.stringContaining('mcpServers.mainwp.command'),
    ]);
  });
});

describe('content rules', () => {
  it('accepts clean content', () => {
    expect(scanContent('Use `MAINWP_APP_PASSWORD` from your environment.', 'clean.md')).toEqual([]);
  });

  it('rejects a versioned tool-name literal', () => {
    const problems = scanContent('Call `mainwp_get_sites_v1` to list sites.', 'sample.md');
    expect(problems).toEqual([expect.stringContaining('mainwp_get_sites_v1')]);
  });

  it('rejects an /mcp__ slash-command literal', () => {
    const problems = scanContent('Run /mcp__mainwp__site-report instead.', 'sample.md');
    expect(problems).toEqual([expect.stringContaining('/mcp__')]);
  });

  it('rejects a credential-shaped literal', () => {
    const problems = scanContent('MAINWP_APP_PASSWORD=s3cr3t hunter2 value', 'sample.md');
    expect(problems).toEqual([expect.stringContaining('MAINWP_APP_PASSWORD')]);
  });

  it('rejects a credential-shaped literal in JSON form', () => {
    const problems = scanContent('"MAINWP_TOKEN": "ab12cd34ef56"', 'sample.json');
    expect(problems).toEqual([expect.stringContaining('MAINWP_TOKEN')]);
  });

  it('allows prose and frontmatter that only name the env vars', () => {
    const source = [
      '---',
      'description: Diagnose the connection without exposing secrets.',
      '---',
      '',
      'Set `MAINWP_USER` and `MAINWP_APP_PASSWORD` in your environment.',
      '[ -n "$MAINWP_APP_PASSWORD" ] && echo "MAINWP_APP_PASSWORD set"',
      '`MAINWP_TOKEN`: compatibility input only, expected to fail.',
    ].join('\n');
    expect(scanContent(source, 'setup.md')).toEqual([]);
  });

  it('allows obvious placeholders', () => {
    expect(scanContent('MAINWP_APP_PASSWORD=<your application password>', 'x.md')).toEqual([]);
    expect(scanContent('MAINWP_TOKEN=${MAINWP_TOKEN}', 'x.md')).toEqual([]);
  });
});

describe('marketplace manifest validation', () => {
  function marketplace(): Record<string, unknown> {
    return {
      name: 'mainwp-mcp',
      owner: { name: 'MainWP' },
      plugins: [{ name: 'mainwp', source: './plugins/mainwp' }],
    };
  }

  it('accepts the real shape', () => {
    expect(validateMarketplace(marketplace(), 'marketplace.json')).toEqual([]);
  });

  it('rejects a missing owner.name', () => {
    const data = marketplace();
    data.owner = {};
    expect(validateMarketplace(data, 'marketplace.json')).toEqual([
      expect.stringContaining('owner.name'),
    ]);
  });

  it('rejects a missing owner object', () => {
    const data = marketplace();
    delete data.owner;
    expect(validateMarketplace(data, 'marketplace.json')).toEqual([
      expect.stringContaining('owner'),
    ]);
  });

  it('rejects a missing name', () => {
    const data = marketplace();
    delete data.name;
    expect(validateMarketplace(data, 'marketplace.json')).toEqual([
      expect.stringContaining('name'),
    ]);
  });

  it('rejects an empty plugins array', () => {
    const data = marketplace();
    data.plugins = [];
    expect(validateMarketplace(data, 'marketplace.json')).toEqual([
      expect.stringContaining('plugins'),
    ]);
  });

  it('rejects a plugin entry without a source', () => {
    const data = marketplace();
    data.plugins = [{ name: 'mainwp' }];
    expect(validateMarketplace(data, 'marketplace.json')).toEqual([
      expect.stringContaining('source'),
    ]);
  });
});

describe('plugin manifest validation', () => {
  function manifest(): Record<string, unknown> {
    return {
      name: 'mainwp',
      description: 'Connect Claude to your MainWP Dashboard',
      version: '0.1.0',
      author: { name: 'MainWP' },
      license: 'GPL-3.0',
    };
  }

  it('accepts the real shape', () => {
    expect(validatePluginManifest(manifest(), 'plugin.json')).toEqual([]);
  });

  it.each(['name', 'description', 'version', 'author', 'license'])(
    'rejects a missing %s',
    field => {
      const data = manifest();
      delete data[field];
      expect(validatePluginManifest(data, 'plugin.json')).toEqual([expect.stringContaining(field)]);
    }
  );
});

describe('real repository manifests', () => {
  it('accepts the checked-in marketplace manifest', () => {
    expect(validateMarketplace(readJsonFile(MARKETPLACE_PATH), 'marketplace.json')).toEqual([]);
  });

  it('accepts the checked-in plugin manifest under its marketplace entry name', () => {
    expect(
      validatePluginManifest(readJsonFile(PLUGIN_MANIFEST_PATH), 'plugin.json', PLUGIN_NAME)
    ).toEqual([]);
  });

  it('rejects the real marketplace manifest with plugins[0].name removed', () => {
    const data = readJsonFile(MARKETPLACE_PATH);
    delete (data.plugins as Record<string, unknown>[])[0].name;
    expect(validateMarketplace(data, 'marketplace.json')).toEqual([
      expect.stringContaining('"name"'),
    ]);
  });

  it('rejects the real plugin manifest renamed away from its marketplace entry', () => {
    const data = readJsonFile(PLUGIN_MANIFEST_PATH);
    data.name = 'mainwp-dashboard';
    const problems = validatePluginManifest(data, 'plugin.json', PLUGIN_NAME);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('mainwp-dashboard');
  });

  it('rejects duplicate plugin names', () => {
    const data = readJsonFile(MARKETPLACE_PATH);
    const plugins = data.plugins as Record<string, unknown>[];
    data.plugins = [plugins[0], { ...plugins[0] }];
    expect(validateMarketplace(data, 'marketplace.json')).toEqual([
      expect.stringContaining('duplicate'),
    ]);
  });

  it.each([
    '/etc/plugins/mainwp',
    '../outside/mainwp',
    './plugins/../../outside',
    'https://example.com/mainwp',
    'github:mainwp/other',
    './commands/mainwp',
    './plugins/',
    // Backslashes are path separators on Windows, so these escape plugins/
    // there while looking like ordinary segment names to a POSIX split.
    './plugins/..\\outside',
    './plugins/mainwp\\..\\..\\outside',
  ])('rejects a plugin source outside ./plugins/: %s', source => {
    const data = readJsonFile(MARKETPLACE_PATH);
    (data.plugins as Record<string, unknown>[])[0].source = source;
    expect(validateMarketplace(data, 'marketplace.json')).toEqual([
      expect.stringContaining('source'),
    ]);
  });

  it('passes the whole repository through the plugin gate', () => {
    expect(checkRepository(REPO_ROOT)).toEqual([]);
  });
});

describe('checkRepository', () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeJson(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  /** Smallest tree checkRepository accepts, so each test breaks one thing. */
  function fixtureRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-plugin-repo-'));
    repos.push(root);
    writeJson(path.join(root, '.claude-plugin', 'marketplace.json'), {
      name: 'mainwp-mcp',
      owner: { name: 'MainWP' },
      plugins: [{ name: PLUGIN_NAME, source: './plugins/mainwp' }],
    });
    const pluginDir = path.join(root, 'plugins', 'mainwp');
    writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), {
      name: PLUGIN_NAME,
      description: 'Connect Claude to your MainWP Dashboard',
      version: '0.1.0',
      author: { name: 'MainWP' },
      license: 'GPL-3.0',
    });
    writeJson(path.join(pluginDir, '.mcp.json'), EXPECTED_MCP_CONFIG);
    fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'commands', 'tools.md'),
      '---\ndescription: List the tools.\n---\n\nBody.\n'
    );
    const skillDir = path.join(pluginDir, 'skills', 'mainwp-dashboard');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: mainwp-dashboard\ndescription: Operating a MainWP Dashboard.\n---\n'
    );
    return root;
  }

  it('accepts a well-formed fixture repository', () => {
    expect(checkRepository(fixtureRepo())).toEqual([]);
  });

  it('reports a plugin.json renamed away from its marketplace entry', () => {
    const root = fixtureRepo();
    const manifestPath = path.join(root, 'plugins', 'mainwp', '.claude-plugin', 'plugin.json');
    writeJson(manifestPath, { ...readJsonFile(manifestPath), name: 'mainwp-dashboard' });
    const problems = checkRepository(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('mainwp-dashboard');
  });

  it('reports a marketplace entry with no name', () => {
    const root = fixtureRepo();
    const marketplacePath = path.join(root, '.claude-plugin', 'marketplace.json');
    const data = readJsonFile(marketplacePath);
    delete (data.plugins as Record<string, unknown>[])[0].name;
    writeJson(marketplacePath, data);
    expect(checkRepository(root)).toEqual([expect.stringContaining('"name"')]);
  });

  it('fails on a symlink in a scanned tree instead of skipping it', () => {
    const root = fixtureRepo();
    const commandsDir = path.join(root, 'plugins', 'mainwp', 'commands');
    fs.symlinkSync(path.join(commandsDir, 'tools.md'), path.join(commandsDir, 'shadow.md'));
    expect(() => checkRepository(root)).toThrow(/shadow\.md/);
  });

  it('does not traverse a rejected source even when its target exists', () => {
    const root = fixtureRepo();
    // A sibling outside the fixture repo that a resolved "../" source would hit.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-plugin-escape-'));
    repos.push(outside);
    const escapedSource = `./plugins/../../${path.basename(outside)}`;
    const marketplacePath = path.join(root, '.claude-plugin', 'marketplace.json');
    const data = readJsonFile(marketplacePath);
    (data.plugins as Record<string, unknown>[]).push({ name: 'escape', source: escapedSource });
    writeJson(marketplacePath, data);
    const problems = checkRepository(root);
    // The invalid source is reported once by manifest validation; traversal
    // problems (missing plugin.json etc.) would mean the path was resolved.
    expect(problems.some(problem => problem.includes('source'))).toBe(true);
    expect(problems.some(problem => problem.includes('.claude-plugin/plugin.json'))).toBe(false);
  });
});

describe('command frontmatter validation', () => {
  it('accepts a non-empty description', () => {
    const source = '---\ndescription: Do the thing.\n---\n\nBody.\n';
    expect(validateCommandFile(source, 'tools.md')).toEqual([]);
  });

  it('rejects a missing description', () => {
    const source = '---\nargument-hint: <site-id>\n---\n\nBody.\n';
    expect(validateCommandFile(source, 'tools.md')).toEqual([
      expect.stringContaining('description'),
    ]);
  });

  it('rejects an empty description', () => {
    const source = '---\ndescription:   \n---\n\nBody.\n';
    expect(validateCommandFile(source, 'tools.md')).toEqual([
      expect.stringContaining('description'),
    ]);
  });

  it('rejects a file with no frontmatter at all', () => {
    expect(validateCommandFile('Just a body.\n', 'tools.md')).toEqual([
      expect.stringContaining('frontmatter'),
    ]);
  });
});

describe('skill frontmatter validation', () => {
  const source = '---\nname: mainwp-dashboard\ndescription: Operating a MainWP Dashboard.\n---\n';

  it('accepts a name matching its directory', () => {
    expect(validateSkillFile(source, 'mainwp-dashboard', 'SKILL.md')).toEqual([]);
  });

  it('rejects a name that does not match its directory', () => {
    expect(validateSkillFile(source, 'mainwp-network', 'SKILL.md')).toEqual([
      expect.stringContaining('mainwp-network'),
    ]);
  });

  it('rejects a missing description', () => {
    const broken = '---\nname: mainwp-dashboard\n---\n';
    expect(validateSkillFile(broken, 'mainwp-dashboard', 'SKILL.md')).toEqual([
      expect.stringContaining('description'),
    ]);
  });

  it('rejects a missing name', () => {
    const broken = '---\ndescription: Operating a MainWP Dashboard.\n---\n';
    expect(validateSkillFile(broken, 'mainwp-dashboard', 'SKILL.md')).toEqual([
      expect.stringContaining('name'),
    ]);
  });
});
