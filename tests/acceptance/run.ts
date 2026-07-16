#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifacts, type Artifacts } from './lib/artifacts.js';
import { CommandRunner } from './lib/commands.js';
import {
  FIXTURE_APP_PASSWORD,
  FIXTURE_USERNAME,
  startFixtureDashboard,
  type FixtureDashboard,
} from './fixture-dashboard.js';
import { resolveAcceptanceCredentials, type AcceptanceCredentials } from './lib/env.js';
import { getWriteGuardReason } from './lib/guards.js';
import { packAndInstall, type PackedPackage } from './lib/pack.js';
import { Redactor } from './lib/redact.js';
import { launchServer } from './lib/server.js';
import { IndependentVerifier } from './lib/verify.js';
import { scenarios } from './scenarios/index.js';
import {
  AssertionRecorder,
  type AcceptanceMode,
  type AcceptanceTarget,
  type ScenarioContext,
  type ScenarioResult,
} from './scenarios/types.js';

interface CliOptions {
  mode: AcceptanceMode;
  target: AcceptanceTarget;
  scenarioIds: string[];
  writes: boolean;
  list: boolean;
  keepConsumer: boolean;
}

interface RunResults {
  runId: string;
  mode: AcceptanceMode;
  target: AcceptanceTarget;
  startedAt: string;
  endedAt: string;
  scenarios: ScenarioResult[];
  totals: Record<'passed' | 'failed' | 'skipped' | 'unverified', number>;
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function usage(): string {
  return `Usage: npx tsx tests/acceptance/run.ts [options]

Options:
  --mode packed|source    Server package mode (default: packed)
  --target live|fixture  Dashboard target (default: live)
  --scenario <id>        Run one scenario; repeat for multiple scenarios
  --writes               Enable host-guarded state-changing scenarios
  --list                 List scenarios and exit
  --keep-consumer        Preserve the temporary packed consumer project
  --help                 Show this help
`;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'packed',
    target: 'live',
    scenarioIds: [],
    writes: false,
    list: false,
    keepConsumer: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--mode') {
      const value = requiredValue(args, index, arg);
      if (value !== 'packed' && value !== 'source') throw new Error(`Invalid --mode: ${value}`);
      options.mode = value;
      index += 1;
    } else if (arg === '--target') {
      const value = requiredValue(args, index, arg);
      if (value !== 'live' && value !== 'fixture') throw new Error(`Invalid --target: ${value}`);
      options.target = value;
      index += 1;
    } else if (arg === '--scenario') {
      options.scenarioIds.push(requiredValue(args, index, arg));
      index += 1;
    } else if (arg === '--writes') {
      options.writes = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--keep-consumer') {
      options.keepConsumer = true;
    } else if (arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function basicAuthorization(credentials: AcceptanceCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString(
    'base64'
  )}`;
}

function baseServerEnv(
  target: AcceptanceTarget,
  credentials: AcceptanceCredentials
): Record<string, string> {
  return {
    MAINWP_URL: credentials.dashboardUrl,
    MAINWP_USER: credentials.username,
    MAINWP_APP_PASSWORD: credentials.appPassword,
    MAINWP_RATE_LIMIT: '0',
    ...(target === 'fixture' ? { MAINWP_ALLOW_HTTP: 'true' } : { MAINWP_SKIP_SSL_VERIFY: 'true' }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.trim() : String(error);
}

function summarize(results: ScenarioResult[]): RunResults['totals'] {
  const totals = { passed: 0, failed: 0, skipped: 0, unverified: 0 };
  for (const result of results) totals[result.status] += 1;
  return totals;
}

function summaryMarkdown(run: RunResults): string {
  const lines = [
    '# MainWP MCP acceptance results',
    '',
    `- Run: \`${run.runId}\``,
    `- Mode: \`${run.mode}\``,
    `- Target: \`${run.target}\``,
    `- Passed: ${run.totals.passed}`,
    `- Failed: ${run.totals.failed}`,
    `- Skipped: ${run.totals.skipped}`,
    `- Unverified: ${run.totals.unverified}`,
    '',
    '| Scenario | Kind | Status | Assertions | Reason |',
    '| --- | --- | --- | ---: | --- |',
  ];
  for (const result of run.scenarios) {
    lines.push(
      `| ${result.id} | ${result.kind} | ${result.status} | ${result.assertions.filter(assertion => assertion.pass).length}/${result.assertions.length} | ${(result.reason ?? result.error ?? '').replace(/\r?\n/g, ' ')} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

async function runScenario(
  definition: (typeof scenarios)[number],
  options: CliOptions,
  credentials: AcceptanceCredentials,
  verifier: IndependentVerifier,
  entry: string,
  packageVersion: string,
  packedPackage: PackedPackage | null,
  artifacts: Artifacts,
  runner: CommandRunner
): Promise<ScenarioResult> {
  const started = performance.now();
  const base = {
    id: definition.id,
    purpose: definition.purpose,
    kind: definition.kind,
  };
  if (!definition.targets.includes(options.target)) {
    return {
      ...base,
      status: 'skipped',
      durationMs: 0,
      assertions: [],
      reason: `Scenario targets ${definition.targets.join(', ')}, not ${options.target}.`,
    };
  }
  if (definition.kind === 'write') {
    const reason = getWriteGuardReason(
      credentials.dashboardUrl,
      options.writes,
      process.env.MAINWP_MCP_ACCEPTANCE_WRITE_HOSTS
    );
    if (reason) {
      return { ...base, status: 'skipped', durationMs: 0, assertions: [], reason };
    }
  }

  let precondition;
  try {
    precondition =
      (await definition.preconditions?.({
        target: options.target,
        mode: options.mode,
        credentials,
        verifier,
        packedPackage,
      })) ?? {};
  } catch (error) {
    return {
      ...base,
      status: 'unverified',
      durationMs: Math.round(performance.now() - started),
      assertions: [],
      reason: errorText(error),
    };
  }
  if (precondition.status) {
    return {
      ...base,
      status: precondition.status,
      durationMs: Math.round(performance.now() - started),
      assertions: [],
      reason: precondition.reason ?? 'Precondition was not met.',
    };
  }

  const launch = precondition.launch ?? {};
  const env = launch.omitCredentialEnv ? {} : baseServerEnv(options.target, credentials);
  Object.assign(env, launch.env ?? {});
  const assertions = new AssertionRecorder();
  let connection;
  let scenarioContext: ScenarioContext | undefined;
  let scenarioError: string | undefined;
  try {
    connection = await launchServer({
      scenario: definition.id,
      entry,
      env,
      artifacts,
      runner,
      settings: launch.settings,
    });
    scenarioContext = {
      client: connection.client,
      verifier,
      config: {
        target: options.target,
        mode: options.mode,
        dashboardUrl: credentials.dashboardUrl,
        packageVersion,
      },
      packedPackage,
      assert: assertions,
      state: precondition.state ?? {},
    };
    await definition.run(scenarioContext);
    if (process.env.MAINWP_MCP_ACCEPTANCE_FORCE_FAILURE === definition.id) {
      assertions.equal('intentional forced-failure validation probe', 'actual', 'expected');
    }
  } catch (error) {
    scenarioError = errorText(error);
  } finally {
    if (scenarioContext && definition.cleanup) {
      try {
        await definition.cleanup(scenarioContext);
      } catch (error) {
        scenarioError = [scenarioError, `Cleanup failed: ${errorText(error)}`]
          .filter(Boolean)
          .join('\n');
      }
    }
    try {
      await connection?.close();
    } catch (error) {
      scenarioError = [scenarioError, `Server close failed: ${errorText(error)}`]
        .filter(Boolean)
        .join('\n');
    }
  }

  const failedAssertions = assertions.results.filter(assertion => !assertion.pass);
  return {
    ...base,
    status: scenarioError || failedAssertions.length > 0 ? 'failed' : 'passed',
    durationMs: Math.round(performance.now() - started),
    assertions: assertions.results,
    ...(scenarioError ? { error: scenarioError } : {}),
    ...(failedAssertions.length > 0
      ? { reason: `${failedAssertions.length} assertion(s) failed.` }
      : {}),
  };
}

export async function runAcceptance(args = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  if (options.list) {
    for (const scenario of scenarios) {
      process.stdout.write(
        `${scenario.id}\t${scenario.kind}\t${scenario.targets.join(',')}\t${scenario.purpose}\n`
      );
    }
    return 0;
  }

  const byId = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  const unknown = options.scenarioIds.filter(id => !byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown scenario ID(s): ${unknown.join(', ')}`);
  const selected =
    options.scenarioIds.length > 0 ? options.scenarioIds.map(id => byId.get(id)!) : scenarios;

  let fixture: FixtureDashboard | undefined;
  let resolvedCredentials: AcceptanceCredentials;
  if (options.target === 'fixture') {
    fixture = await startFixtureDashboard();
    resolvedCredentials = {
      dashboardUrl: fixture.url,
      username: FIXTURE_USERNAME,
      appPassword: FIXTURE_APP_PASSWORD,
    };
  } else {
    resolvedCredentials = resolveAcceptanceCredentials();
  }
  const redactor = new Redactor({
    username: resolvedCredentials.username,
    appPassword: resolvedCredentials.appPassword,
    dashboardUrl: resolvedCredentials.dashboardUrl,
    authorization: basicAuthorization(resolvedCredentials),
  });
  const runner = new CommandRunner();
  const artifacts = await createArtifacts(
    REPO_ROOT,
    redactor,
    runner,
    options.mode,
    options.target,
    {
      scenarios: options.scenarioIds,
      writes: options.writes,
      keepConsumer: options.keepConsumer,
    }
  );
  const verifier = new IndependentVerifier(resolvedCredentials, options.target === 'live');
  let packedPackage: PackedPackage | null = null;
  let runResults: RunResults | undefined;

  try {
    if (options.mode === 'packed') {
      packedPackage = await packAndInstall(REPO_ROOT, runner, artifacts, options.keepConsumer);
    }
    const entry = packedPackage?.installedEntry ?? path.join(REPO_ROOT, 'dist', 'index.js');
    const results: ScenarioResult[] = [];
    for (const scenario of selected) {
      const result = await runScenario(
        scenario,
        options,
        resolvedCredentials,
        verifier,
        entry,
        artifacts.manifest.packageVersion,
        packedPackage,
        artifacts,
        runner
      );
      results.push(result);
      process.stdout.write(`${result.status.toUpperCase()} ${result.id}\n`);
      artifacts.writeJson('results.json', { scenarios: results, totals: summarize(results) });
    }
    runResults = {
      runId: artifacts.runId,
      mode: options.mode,
      target: options.target,
      startedAt: artifacts.manifest.startTime,
      endedAt: new Date().toISOString(),
      scenarios: results,
      totals: summarize(results),
    };
    artifacts.writeJson('results.json', runResults);
    artifacts.write('summary.md', summaryMarkdown(runResults));
  } catch (error) {
    const failure = redactor.redact(errorText(error));
    artifacts.writeJson('results.json', { status: 'failed', error: failure });
    artifacts.write(
      'summary.md',
      `# MainWP MCP acceptance results\n\nHarness failure: ${failure}\n`
    );
    throw error;
  } finally {
    artifacts.finish();
    await verifier.close();
    await fixture?.close();
    packedPackage?.cleanup();
  }

  process.stdout.write(`Artifacts: ${artifacts.runDir}\n`);
  if (options.keepConsumer && packedPackage) {
    process.stdout.write(`Consumer preserved: ${packedPackage.consumerDir}\n`);
  }
  return runResults.totals.failed > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runAcceptance()
    .then(exitCode => {
      process.exitCode = exitCode;
    })
    .catch(error => {
      process.stderr.write(`${errorText(error)}\n`);
      process.exitCode = 1;
    });
}
