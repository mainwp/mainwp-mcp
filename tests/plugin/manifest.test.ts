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

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPromptList } from '../../src/prompts.js';
import {
  EXPECTED_MCP_CONFIG,
  diffJson,
  scanContent,
  validateMarketplace,
  validatePluginManifest,
  validateCommandFile,
  validateSkillFile,
} from '../../scripts/check-plugin.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COMMANDS_DIR = path.join(REPO_ROOT, 'plugins', 'mainwp', 'commands');

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
