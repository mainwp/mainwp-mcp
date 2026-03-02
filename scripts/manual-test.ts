#!/usr/bin/env tsx
/**
 * Manual Test Harness for MainWP MCP Server
 *
 * Runs a catalog of test scenarios against the real MainWP Dashboard,
 * records response times, and saves results to a timestamped JSON file.
 *
 * Usage:
 *   npm run test:manual                        # Run all tests
 *   npm run test:manual -- --category read     # Read-only only
 *   npm run test:manual -- --category safe-write
 *   npm run test:manual -- --test count-sites --test list-sites
 *   npm run test:manual -- --site-id 1         # Skip discovery
 *   npm run test:manual -- --dry-run           # Show what would run
 *   npm run test:manual -- --verbose           # Print response bodies
 */

import fs from 'fs';
import https from 'https';
import { performance } from 'perf_hooks';
import { loadConfig, getAbilitiesApiUrl, getAuthHeaders, type Config } from '../src/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TestStatus = 'pass' | 'fail' | 'skipped';
type TestCategory = 'read' | 'safe-write';

interface TestResult {
  name: string;
  question: string;
  abilityName: string;
  httpMethod: string;
  params: Record<string, unknown>;
  status: TestStatus;
  statusCode?: number;
  responseTimeMs?: number;
  responseSizeBytes?: number;
  responseBody?: unknown;
  error?: string;
  timestamp: string;
}

interface TestScenario {
  name: string;
  question: string;
  abilityName: string;
  category: TestCategory;
  readonly: boolean;
  params: (ctx: DiscoveryContext) => Record<string, unknown>;
  /** Additional HTTP status codes to treat as acceptable (not a failure) */
  acceptStatuses?: number[];
  /** Name of the paired cleanup test that must always run */
  pairedWith?: string;
}

interface DiscoveryContext {
  siteId: number | null;
  pluginSlug: string | null;
  themeSlug: string | null;
}

interface CliOptions {
  category: TestCategory | null;
  testNames: string[];
  siteId: number | null;
  dryRun: boolean;
  verbose: boolean;
}

interface RunReport {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  dashboardUrl: string;
  discovery: DiscoveryContext;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    avgResponseTimeMs: number;
    minResponseTimeMs: number;
    maxResponseTimeMs: number;
  };
  results: TestResult[];
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    category: null,
    testNames: [],
    siteId: null,
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--category':
        opts.category = args[++i] as TestCategory;
        if (opts.category !== 'read' && opts.category !== 'safe-write') {
          console.error(`Invalid category: ${opts.category}. Must be "read" or "safe-write".`);
          process.exit(1);
        }
        break;
      case '--test':
        opts.testNames.push(args[++i]);
        break;
      case '--site-id':
        opts.siteId = parseInt(args[++i], 10);
        if (isNaN(opts.siteId)) {
          console.error('Invalid --site-id: must be a number');
          process.exit(1);
        }
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--help':
        console.log(`
MainWP MCP Manual Test Harness

Usage:
  npm run test:manual                          Run all tests
  npm run test:manual -- --category read       Read-only tests only
  npm run test:manual -- --category safe-write Safe-write tests only
  npm run test:manual -- --test <name>         Run specific test(s)
  npm run test:manual -- --site-id <id>        Skip discovery, use this site ID
  npm run test:manual -- --dry-run             Show what would run
  npm run test:manual -- --verbose             Print response bodies
`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}. Use --help for usage.`);
        process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// PHP-style Query String Serialization (simplified inline version)
// ---------------------------------------------------------------------------

function serializeToPhpQueryString(input: Record<string, unknown>): string {
  const params: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.push(`input[${encodeURIComponent(key)}][]=${encodeURIComponent(String(item))}`);
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
        params.push(
          `input[${encodeURIComponent(key)}][${encodeURIComponent(subKey)}]=${encodeURIComponent(String(subVal))}`
        );
      }
    } else if (value !== undefined && value !== null) {
      params.push(`input[${encodeURIComponent(key)}]=${encodeURIComponent(String(value))}`);
    }
  }

  return params.length > 0 ? '?' + params.join('&') : '';
}

// ---------------------------------------------------------------------------
// HTTP Call Helper
// ---------------------------------------------------------------------------

let sharedAgent: https.Agent | undefined;

async function callAbility(
  config: Config,
  abilityName: string,
  params: Record<string, unknown>,
  isReadonly: boolean
): Promise<{ statusCode: number; body: unknown; responseTimeMs: number; responseSizeBytes: number }> {
  const baseUrl = getAbilitiesApiUrl(config);
  const url = `${baseUrl}/abilities/${abilityName}/run`;
  const headers = getAuthHeaders(config);
  const hasParams = Object.keys(params).length > 0;

  // Set up SSL agent for self-signed certs
  if (config.skipSslVerify && !sharedAgent) {
    sharedAgent = new https.Agent({ rejectUnauthorized: false });
  }
  const agent = config.skipSslVerify ? sharedAgent : undefined;

  const fetchOptions: RequestInit & { agent?: https.Agent } = {
    headers,
  };

  if (agent) {
    (fetchOptions as unknown as { agent: https.Agent }).agent = agent;
  }

  let fullUrl: string;
  if (isReadonly) {
    fetchOptions.method = 'GET';
    fullUrl = hasParams ? url + serializeToPhpQueryString(params) : url;
  } else {
    fetchOptions.method = 'POST';
    fetchOptions.body = JSON.stringify({ input: params });
    fullUrl = url;
  }

  const start = performance.now();
  const response = await fetch(fullUrl, fetchOptions);
  const responseTimeMs = Math.round((performance.now() - start) * 100) / 100;

  const text = await response.text();
  const responseSizeBytes = Buffer.byteLength(text, 'utf8');

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  // Truncate body at 10KB for storage
  const bodyStr = JSON.stringify(body);
  if (bodyStr.length > 10240) {
    body = { _truncated: true, _sizeBytes: responseSizeBytes, _preview: bodyStr.slice(0, 500) };
  }

  return { statusCode: response.status, body, responseTimeMs, responseSizeBytes };
}

// ---------------------------------------------------------------------------
// Test Catalog
// ---------------------------------------------------------------------------

function buildTestCatalog(): TestScenario[] {
  return [
    // --- Read-Only (15) ---
    {
      name: 'count-sites',
      question: 'How many sites are managed?',
      abilityName: 'mainwp/count-sites-v1',
      category: 'read',
      readonly: true,
      params: () => ({}),
    },
    {
      name: 'list-sites',
      question: 'List all managed sites',
      abilityName: 'mainwp/list-sites-v1',
      category: 'read',
      readonly: true,
      params: () => ({ per_page: 5 }),
    },
    {
      name: 'get-site',
      question: 'Show details for a site',
      abilityName: 'mainwp/get-site-v1',
      category: 'read',
      readonly: true,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'get-sites-basic',
      question: 'Get basic list of all sites',
      abilityName: 'mainwp/get-sites-basic-v1',
      category: 'read',
      readonly: true,
      params: () => ({ per_page: 5 }),
    },
    {
      name: 'get-site-plugins',
      question: 'What plugins are on this site?',
      abilityName: 'mainwp/get-site-plugins-v1',
      category: 'read',
      readonly: true,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'get-site-themes',
      question: 'What themes are on this site?',
      abilityName: 'mainwp/get-site-themes-v1',
      category: 'read',
      readonly: true,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'get-site-security',
      question: 'Security status of this site?',
      abilityName: 'mainwp/get-site-security-v1',
      category: 'read',
      readonly: true,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'get-site-changes',
      question: 'Recent changes on this site?',
      abilityName: 'mainwp/get-site-changes-v1',
      category: 'read',
      readonly: true,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId, per_page: 5 }),
    },
    {
      name: 'get-abandoned-plugins',
      question: 'Abandoned plugins on this site?',
      abilityName: 'mainwp/get-abandoned-plugins-v1',
      category: 'read',
      readonly: true,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'get-abandoned-themes',
      question: 'Abandoned themes on this site?',
      abilityName: 'mainwp/get-abandoned-themes-v1',
      category: 'read',
      readonly: true,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'list-updates',
      question: 'What updates are available?',
      abilityName: 'mainwp/list-updates-v1',
      category: 'read',
      readonly: true,
      params: () => ({ per_page: 5 }),
    },
    {
      name: 'list-clients',
      question: 'List all clients',
      abilityName: 'mainwp/list-clients-v1',
      category: 'read',
      readonly: true,
      params: () => ({ per_page: 5 }),
    },
    {
      name: 'count-clients',
      question: 'How many clients exist?',
      abilityName: 'mainwp/count-clients-v1',
      category: 'read',
      readonly: true,
      params: () => ({}),
    },
    {
      name: 'list-tags',
      question: 'List all tags',
      abilityName: 'mainwp/list-tags-v1',
      category: 'read',
      readonly: true,
      params: () => ({ per_page: 5 }),
    },
    {
      name: 'get-batch-job-status',
      question: 'Check batch job status',
      abilityName: 'mainwp/get-batch-job-status-v1',
      category: 'read',
      readonly: true,
      params: () => ({ job_id: 1 }),
      acceptStatuses: [400, 404],
    },

    // --- Safe Writes (7) ---
    {
      name: 'sync-sites',
      question: 'Sync site data',
      abilityName: 'mainwp/sync-sites-v1',
      category: 'safe-write',
      readonly: false,
      params: (ctx) => ({ site_ids_or_domains: [ctx.siteId] }),
    },
    {
      name: 'check-site',
      question: 'Is this site online?',
      abilityName: 'mainwp/check-site-v1',
      category: 'safe-write',
      readonly: false,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'reconnect-site',
      question: 'Reconnect this site',
      abilityName: 'mainwp/reconnect-site-v1',
      category: 'safe-write',
      readonly: false,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'suspend-site',
      question: 'Suspend monitoring for this site',
      abilityName: 'mainwp/suspend-site-v1',
      category: 'safe-write',
      readonly: false,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
      pairedWith: 'unsuspend-site',
    },
    {
      name: 'unsuspend-site',
      question: 'Resume monitoring for this site',
      abilityName: 'mainwp/unsuspend-site-v1',
      category: 'safe-write',
      readonly: false,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId }),
    },
    {
      name: 'activate-plugin',
      question: 'Activate a plugin on this site',
      abilityName: 'mainwp/activate-site-plugins-v1',
      category: 'safe-write',
      readonly: false,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId, plugins: [ctx.pluginSlug] }),
      pairedWith: 'deactivate-plugin',
    },
    {
      name: 'deactivate-plugin',
      question: 'Deactivate a plugin on this site',
      abilityName: 'mainwp/deactivate-site-plugins-v1',
      category: 'safe-write',
      readonly: false,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId, plugins: [ctx.pluginSlug] }),
      pairedWith: 'delete-plugin',
    },
    {
      name: 'delete-plugin',
      question: 'Delete a plugin from this site',
      abilityName: 'mainwp/delete-site-plugins-v1',
      category: 'safe-write',
      readonly: false,
      params: (ctx) => ({ site_id_or_domain: ctx.siteId, plugins: [ctx.pluginSlug], confirm: true }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Discovery Phase
// ---------------------------------------------------------------------------

async function discover(config: Config, opts: CliOptions): Promise<DiscoveryContext> {
  const ctx: DiscoveryContext = {
    siteId: opts.siteId,
    pluginSlug: null,
    themeSlug: null,
  };

  if (ctx.siteId) {
    console.log(`Using provided site ID: ${ctx.siteId}`);
  } else {
    console.log('Discovering site ID...');
    try {
      const result = await callAbility(config, 'mainwp/list-sites-v1', { per_page: 1 }, true);
      if (result.statusCode === 200 && result.body) {
        const data = result.body as { items?: Array<{ id: number }> };
        if (data.items && data.items.length > 0) {
          ctx.siteId = data.items[0].id;
          console.log(`  Found site ID: ${ctx.siteId}`);
        }
      }
    } catch (err) {
      console.error(`  Discovery failed (list-sites): ${(err as Error).message}`);
      throw new Error(`Cannot reach Dashboard. Check credentials and URL.\n  ${(err as Error).message}`);
    }
  }

  if (!ctx.siteId) {
    console.log('  No sites found — site-dependent tests will be skipped.');
    return ctx;
  }

  // Discover a non-essential active plugin
  console.log('Discovering plugin slug...');
  try {
    const result = await callAbility(
      config,
      'mainwp/get-site-plugins-v1',
      { site_id_or_domain: ctx.siteId },
      true
    );
    if (result.statusCode === 200 && result.body) {
      const data = result.body as { plugins?: Array<{ slug: string; active: boolean }> };
      if (data.plugins) {
        // Find any non-essential plugin (active or inactive) for lifecycle testing
        const candidate = data.plugins.find(
          (p) => !p.slug.startsWith('mainwp-child')
        );
        if (candidate) {
          ctx.pluginSlug = candidate.slug;
          console.log(`  Found plugin: ${ctx.pluginSlug} (${candidate.active ? 'active' : 'inactive'})`);
        } else {
          console.log('  No non-essential plugin found — plugin tests will be skipped.');
        }
      }
    }
  } catch (err) {
    console.log(`  Plugin discovery failed: ${(err as Error).message}`);
  }

  // Discover an inactive theme
  console.log('Discovering theme slug...');
  try {
    const result = await callAbility(
      config,
      'mainwp/get-site-themes-v1',
      { site_id_or_domain: ctx.siteId },
      true
    );
    if (result.statusCode === 200 && result.body) {
      const data = result.body as { themes?: Array<{ slug: string; active: boolean }> };
      if (data.themes) {
        const candidate = data.themes.find((t) => !t.active);
        if (candidate) {
          ctx.themeSlug = candidate.slug;
          console.log(`  Found theme: ${ctx.themeSlug}`);
        } else {
          console.log('  No inactive theme found.');
        }
      }
    }
  } catch (err) {
    console.log(`  Theme discovery failed: ${(err as Error).message}`);
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Test Execution
// ---------------------------------------------------------------------------

function needsSiteId(scenario: TestScenario, ctx: DiscoveryContext): boolean {
  const params = scenario.params(ctx);
  return params.site_id_or_domain !== undefined || params.site_ids_or_domains !== undefined;
}

function needsPluginSlug(scenario: TestScenario): boolean {
  return scenario.name === 'deactivate-plugin' || scenario.name === 'activate-plugin';
}

function shouldSkip(scenario: TestScenario, ctx: DiscoveryContext): string | null {
  if (needsSiteId(scenario, ctx) && !ctx.siteId) {
    return 'No site ID available';
  }
  if (needsPluginSlug(scenario) && !ctx.pluginSlug) {
    return 'No plugin slug available';
  }
  return null;
}

async function runTest(
  config: Config,
  scenario: TestScenario,
  ctx: DiscoveryContext,
  verbose: boolean
): Promise<TestResult> {
  const skipReason = shouldSkip(scenario, ctx);
  if (skipReason) {
    return {
      name: scenario.name,
      question: scenario.question,
      abilityName: scenario.abilityName,
      httpMethod: scenario.readonly ? 'GET' : 'POST',
      params: {},
      status: 'skipped',
      error: skipReason,
      timestamp: new Date().toISOString(),
    };
  }

  const params = scenario.params(ctx);

  try {
    const result = await callAbility(config, scenario.abilityName, params, scenario.readonly);

    const passed = result.statusCode >= 200 && result.statusCode < 300;
    const acceptedStatus = scenario.acceptStatuses?.includes(result.statusCode) ?? false;

    if (verbose && result.body) {
      console.log(`\n  Response body (${scenario.name}):`);
      console.log(`  ${JSON.stringify(result.body, null, 2).split('\n').join('\n  ')}`);
    }

    return {
      name: scenario.name,
      question: scenario.question,
      abilityName: scenario.abilityName,
      httpMethod: scenario.readonly ? 'GET' : 'POST',
      params,
      status: passed || acceptedStatus ? 'pass' : 'fail',
      statusCode: result.statusCode,
      responseTimeMs: result.responseTimeMs,
      responseSizeBytes: result.responseSizeBytes,
      responseBody: result.body,
      error: !passed && !acceptedStatus ? `HTTP ${result.statusCode}` : undefined,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      name: scenario.name,
      question: scenario.question,
      abilityName: scenario.abilityName,
      httpMethod: scenario.readonly ? 'GET' : 'POST',
      params,
      status: 'fail',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Terminal Output
// ---------------------------------------------------------------------------

function printSummaryTable(config: Config, results: TestResult[], durationMs: number): void {
  const hostname = new URL(config.dashboardUrl).hostname;
  const authType = config.authType === 'basic' ? 'Basic' : 'Bearer';

  console.log('\n' + '='.repeat(90));
  console.log('MainWP MCP Manual Test Report');
  console.log(`Dashboard: ${hostname} | Auth: ${authType} | Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log('='.repeat(90));

  // Table header
  const hdr = [
    '#'.padStart(3),
    'Test'.padEnd(22),
    'Ability'.padEnd(38),
    'Status'.padEnd(8),
    'Time (ms)'.padStart(10),
    'HTTP'.padStart(5),
  ];
  console.log(hdr.join(' | '));
  console.log('-'.repeat(90));

  results.forEach((r, i) => {
    const num = String(i + 1).padStart(3);
    const name = r.name.padEnd(22);
    const ability = r.abilityName.padEnd(38);
    const status = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
    const statusStr = status.padEnd(8);
    const time = r.responseTimeMs !== undefined ? String(Math.round(r.responseTimeMs)).padStart(10) : '       N/A';
    const http = r.statusCode !== undefined ? String(r.statusCode).padStart(5) : '  N/A';
    console.log(`${num} | ${name} | ${ability} | ${statusStr} | ${time} | ${http}`);
  });

  console.log('-'.repeat(90));

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const times = results.filter((r) => r.responseTimeMs !== undefined).map((r) => r.responseTimeMs!);
  const avg = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const min = times.length > 0 ? Math.round(Math.min(...times)) : 0;
  const max = times.length > 0 ? Math.round(Math.max(...times)) : 0;

  console.log(`Summary: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total)`);
  if (times.length > 0) {
    console.log(`Avg: ${avg}ms | Min: ${min}ms | Max: ${max}ms`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  // Env var mapping: MAINWP_API_URL → MAINWP_URL
  if (!process.env.MAINWP_URL && process.env.MAINWP_API_URL) {
    process.env.MAINWP_URL = process.env.MAINWP_API_URL;
  }

  // Load config
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}\n`);
    console.error('Missing credentials. Set up one of:');
    console.error('  1. Source env: source /path/to/network-testbed/.env');
    console.error('  2. Create settings.json (see settings.example.json)\n');
    process.exit(1);
  }

  console.log(`\nMainWP MCP Manual Test Harness`);
  console.log(`Dashboard: ${new URL(config.dashboardUrl).hostname}`);
  console.log(`Auth: ${config.authType}`);

  // Build and filter test catalog
  const allTests = buildTestCatalog();
  let tests = allTests;

  if (opts.category) {
    tests = tests.filter((t) => t.category === opts.category);
    console.log(`Category filter: ${opts.category} (${tests.length} tests)`);
  }

  if (opts.testNames.length > 0) {
    // When specific tests are requested, also include their paired cleanup tests
    const requestedNames = new Set(opts.testNames);
    for (const name of opts.testNames) {
      const scenario = allTests.find((t) => t.name === name);
      if (scenario?.pairedWith) {
        requestedNames.add(scenario.pairedWith);
      }
    }
    tests = tests.filter((t) => requestedNames.has(t.name));
    console.log(`Test filter: ${[...requestedNames].join(', ')} (${tests.length} tests)`);
  }

  if (tests.length === 0) {
    console.error('\nNo tests match the given filters.');
    process.exit(1);
  }

  // Dry run — just show the catalog
  if (opts.dryRun) {
    console.log(`\nDry run — ${tests.length} tests would execute:\n`);
    tests.forEach((t, i) => {
      const num = String(i + 1).padStart(3);
      const cat = t.category === 'read' ? 'READ' : 'WRITE';
      console.log(`${num}. [${cat}] ${t.name} → ${t.abilityName}`);
      console.log(`     "${t.question}"`);
    });
    console.log('\nNo API calls were made.');
    process.exit(0);
  }

  // Discovery
  console.log('');
  const ctx = await discover(config, opts);
  console.log('');

  // Execute tests
  const results: TestResult[] = [];
  let consecutiveNetworkErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;
  const runStart = performance.now();

  for (const scenario of tests) {
    // Circuit breaker
    if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`\nCircuit breaker: ${MAX_CONSECUTIVE_ERRORS} consecutive network errors. Aborting remaining tests.`);
      // Mark remaining as skipped
      const remaining = tests.slice(tests.indexOf(scenario));
      for (const s of remaining) {
        results.push({
          name: s.name,
          question: s.question,
          abilityName: s.abilityName,
          httpMethod: s.readonly ? 'GET' : 'POST',
          params: {},
          status: 'skipped',
          error: 'Circuit breaker: too many consecutive network errors',
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }

    const label = `  ${String(results.length + 1).padStart(2)}. ${scenario.name}`;
    process.stdout.write(`${label}...`);

    const result = await runTest(config, scenario, ctx, opts.verbose);
    results.push(result);

    // Track consecutive network errors (not HTTP errors — those have status codes)
    if (result.status === 'fail' && !result.statusCode) {
      consecutiveNetworkErrors++;
    } else {
      consecutiveNetworkErrors = 0;
    }

    // Status indicator
    if (result.status === 'pass') {
      const time = result.responseTimeMs ? ` (${Math.round(result.responseTimeMs)}ms)` : '';
      console.log(` PASS${time}`);
    } else if (result.status === 'skipped') {
      console.log(` SKIP — ${result.error}`);
    } else {
      console.log(` FAIL — ${result.error}`);
    }
  }

  const runDuration = performance.now() - runStart;

  // Print summary table
  printSummaryTable(config, results, runDuration);

  // Build report
  const times = results.filter((r) => r.responseTimeMs !== undefined).map((r) => r.responseTimeMs!);
  const report: RunReport = {
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    startedAt: new Date(Date.now() - runDuration).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Math.round(runDuration),
    dashboardUrl: new URL(config.dashboardUrl).hostname,
    discovery: ctx,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      avgResponseTimeMs: times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
      minResponseTimeMs: times.length > 0 ? Math.round(Math.min(...times)) : 0,
      maxResponseTimeMs: times.length > 0 ? Math.round(Math.max(...times)) : 0,
    },
    results,
  };

  // Save results
  fs.mkdirSync('test-results', { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const outFile = `test-results/test-run-${timestamp}.json`;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nSaved to: ${outFile}\n`);

  // Exit with non-zero if any failures
  const failCount = results.filter((r) => r.status === 'fail').length;
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nFatal error: ${(err as Error).message}`);
  process.exit(1);
});
