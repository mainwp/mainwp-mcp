#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifacts } from './lib/artifacts.js';
import {
  evaluateConfirmationTranscript,
  type RecordedAgentToolResult,
  type RecordedAgentToolUse,
} from './lib/agent-confirmation.js';
import { CommandRunner } from './lib/commands.js';
import {
  FIXTURE_APP_PASSWORD,
  FIXTURE_USERNAME,
  startFixtureDashboard,
  type FixtureDashboard,
} from './fixture-dashboard.js';
import { resolveAcceptanceCredentials, type AcceptanceCredentials } from './lib/env.js';
import { packAndInstall } from './lib/pack.js';
import { Redactor } from './lib/redact.js';
import { IndependentVerifier } from './lib/verify.js';

interface AgentScenario {
  id: string;
  target: 'live' | 'fixture';
  task(groundTruth: AgentGroundTruth): string;
  expectedTools: string[];
  groundTruth(verifier: IndependentVerifier): Promise<AgentGroundTruth>;
  evaluate?: (
    truth: AgentGroundTruth,
    collected: CollectedAgentOutput,
    verifier: IndependentVerifier
  ) => Promise<{ evaluation: AgentEvaluation; reason?: string }>;
}

interface AgentGroundTruth {
  count?: number;
  siteId?: number;
  siteUrl?: string;
  siteName?: string;
  pluginActive?: boolean;
  pluginName?: string;
  pluginSlug?: string;
  updateSiteUrls?: string[];
  beforeSiteCount?: number;
  targetSiteId?: number;
  targetSiteUrl?: string;
  targetSiteName?: string;
}

interface EvaluationField {
  pass: boolean;
  evidence: unknown;
}

interface AgentEvaluation {
  understoodRequest: EvaluationField;
  rightCapability: EvaluationField;
  rightArguments: EvaluationField;
  correctMcpResult: EvaluationField;
  stateChange: EvaluationField;
  faithfulFinalAnswer: EvaluationField;
}

interface AgentResult {
  id: string;
  status: 'passed' | 'failed' | 'unverified';
  model?: string;
  toolUses: RecordedAgentToolUse[];
  toolResults: RecordedAgentToolResult[];
  finalText: string;
  groundTruth?: AgentGroundTruth;
  evaluation?: AgentEvaluation;
  reason?: string;
}

interface CollectedAgentOutput {
  toolUses: RecordedAgentToolUse[];
  toolResults: RecordedAgentToolResult[];
  finalText: string;
  model?: string;
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const agentScenarios: AgentScenario[] = [
  {
    id: 'agent-count-sites',
    target: 'live',
    task: () => 'How many sites are currently connected to my MainWP dashboard?',
    expectedTools: ['count_sites_v1', 'list_sites_v1'],
    groundTruth: async verifier => ({ count: await verifier.countSites() }),
  },
  {
    id: 'agent-updates',
    target: 'live',
    task: () => 'Which of my sites need plugin updates?',
    expectedTools: ['list_updates_v1', 'list_sites_v1', 'get_site_plugins_v1'],
    groundTruth: async verifier => {
      const updateSiteUrls: string[] = [];
      for (const site of await verifier.listSites()) {
        const plugins = await verifier.getSitePlugins(site.id);
        if (plugins.plugins.some(plugin => Boolean(plugin.update_version))) {
          updateSiteUrls.push(site.url);
        }
      }
      return { updateSiteUrls: updateSiteUrls.sort() };
    },
  },
  {
    id: 'agent-plugin-active',
    target: 'live',
    task: truth =>
      `Is the ${truth.pluginName} plugin active on ${truth.siteUrl}? Answer yes or no with the site name.`,
    expectedTools: ['get_site_plugins_v1', 'get_site_v1', 'list_sites_v1'],
    groundTruth: async verifier => {
      // Probe a plugin that actually exists on the testbed: the override
      // plugin when configured, otherwise the first plugin discovered.
      const preferred = process.env.MAINWP_MCP_ACCEPTANCE_TOGGLE_PLUGIN;
      const sites = await verifier.listSites();
      if (sites.length === 0) throw new Error('No site is available for agent-plugin-active');
      for (const site of sites) {
        const plugins = (await verifier.getSitePlugins(site.id)).plugins;
        const plugin = preferred
          ? plugins.find(candidate => candidate.slug === preferred)
          : plugins[0];
        if (plugin?.name) {
          return {
            siteId: site.id,
            siteUrl: site.url,
            siteName: site.name,
            pluginActive: plugin.active,
            pluginName: plugin.name,
            pluginSlug: plugin.slug,
          };
        }
      }
      throw new Error('No discoverable plugin was found for agent-plugin-active');
    },
  },
  {
    id: 'agent-confirm-delete-site',
    target: 'fixture',
    task: truth =>
      `Delete the MainWP site named ${truth.targetSiteName} at ${truth.targetSiteUrl} (site ID ${truth.targetSiteId}). This deletion is explicitly authorized. Proceed through any confirmation step needed to complete it, then report the outcome.`,
    expectedTools: ['delete_site_v1'],
    groundTruth: async verifier => {
      const sites = await verifier.listSites();
      const target = sites.find(site => site.id === 1) ?? sites[0];
      if (!target) throw new Error('No fixture site was available for agent confirmation');
      return {
        beforeSiteCount: sites.length,
        targetSiteId: target.id,
        targetSiteUrl: target.url,
        targetSiteName: target.name,
      };
    },
    evaluate: async (truth, collected, verifier) => {
      if (
        truth.beforeSiteCount === undefined ||
        truth.targetSiteId === undefined ||
        !truth.targetSiteName
      ) {
        throw new Error('Fixture confirmation ground truth was incomplete');
      }
      const transcript = evaluateConfirmationTranscript(
        collected.toolUses,
        collected.toolResults,
        truth.targetSiteId
      );
      const after = await verifier.listSites();
      const deleteUses = collected.toolUses.filter(tool =>
        toolFamilyMatches(tool.name, ['delete_site_v1'])
      );
      const finalText = collected.finalText.toLowerCase();
      const evaluation: AgentEvaluation = {
        understoodRequest: {
          pass: collected.finalText.trim().length > 0,
          evidence: collected.finalText,
        },
        rightCapability: {
          pass: deleteUses.length >= 2,
          evidence: deleteUses.map(tool => tool.name),
        },
        rightArguments: {
          pass: transcript.pass,
          evidence: {
            targetSiteId: truth.targetSiteId,
            confirmationToken: transcript.confirmationToken,
            previewCallId: transcript.previewCallId,
            confirmedCallId: transcript.confirmedCallId,
          },
        },
        correctMcpResult: {
          pass: transcript.pass,
          evidence: transcript,
        },
        stateChange: {
          pass:
            after.length === truth.beforeSiteCount - 1 &&
            !after.some(site => site.id === truth.targetSiteId),
          evidence: {
            beforeCount: truth.beforeSiteCount,
            afterCount: after.length,
            targetStillPresent: after.some(site => site.id === truth.targetSiteId),
          },
        },
        faithfulFinalAnswer: {
          pass:
            finalText.includes(truth.targetSiteName.toLowerCase()) &&
            /\b(deleted|removed)\b/.test(finalText),
          evidence: collected.finalText,
        },
      };
      return { evaluation, ...(transcript.reason ? { reason: transcript.reason } : {}) };
    },
  },
];

function parseArgs(args: string[]): {
  scenarioIds: string[];
  list: boolean;
  keepConsumer: boolean;
} {
  const options = { scenarioIds: [] as string[], list: false, keepConsumer: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--scenario') {
      const id = args[index + 1];
      if (!id || id.startsWith('--')) throw new Error('--scenario requires an ID');
      options.scenarioIds.push(id);
      index += 1;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--keep-consumer') {
      options.keepConsumer = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function shellDisplay(argv: string[]): string {
  return argv.map(value => (/[\s*]/.test(value) ? JSON.stringify(value) : value)).join(' ');
}

function contentBlocks(event: unknown): unknown[] {
  if (!event || typeof event !== 'object') return [];
  const record = event as Record<string, unknown>;
  const message = record.message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) return content;
  }
  return [];
}

function collectEvent(event: unknown, accumulator: CollectedAgentOutput): void {
  if (!event || typeof event !== 'object') return;
  const record = event as Record<string, unknown>;
  if (typeof record.model === 'string') accumulator.model = record.model;
  if (record.message && typeof record.message === 'object') {
    const model = (record.message as Record<string, unknown>).model;
    if (typeof model === 'string') accumulator.model = model;
  }
  for (const block of contentBlocks(event)) {
    if (!block || typeof block !== 'object') continue;
    const content = block as Record<string, unknown>;
    if (content.type === 'tool_use' && typeof content.name === 'string') {
      if (content.name.startsWith('mcp__mainwp__')) {
        accumulator.toolUses.push({
          ...(typeof content.id === 'string' ? { id: content.id } : {}),
          name: content.name,
          input: content.input,
        });
      }
    } else if (content.type === 'tool_result') {
      accumulator.toolResults.push({
        ...(typeof content.tool_use_id === 'string' ? { toolUseId: content.tool_use_id } : {}),
        content: content.content,
        ...((content.is_error === true || content.isError === true) && { isError: true }),
      });
    } else if (content.type === 'text' && typeof content.text === 'string') {
      accumulator.finalText = content.text;
    }
  }
  if (record.type === 'result' && typeof record.result === 'string') {
    accumulator.finalText = record.result;
  }
}

function toolFamilyMatches(toolName: string, expected: string[]): boolean {
  return expected.some(
    family => toolName === `mcp__mainwp__${family}` || toolName.endsWith(family)
  );
}

function finalAnswerMatches(truth: AgentGroundTruth, text: string): boolean {
  if (truth.count !== undefined) {
    return [...text.matchAll(/\b\d+\b/g)].some(match => Number(match[0]) === truth.count);
  }
  if (truth.updateSiteUrls) {
    if (truth.updateSiteUrls.length === 0) return /\b(no|none|zero|0)\b/i.test(text);
    // Agents commonly name sites by hostname ("child6-4.local") rather than
    // full URL, so match on hostnames.
    const hostnameOf = (url: string): string => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    };
    const lower = text.toLowerCase();
    return truth.updateSiteUrls.every(url => lower.includes(hostnameOf(url).toLowerCase()));
  }
  if (truth.pluginActive !== undefined) {
    const answer = text.match(/\b(yes|no)\b/i)?.[1]?.toLowerCase();
    return (
      answer === (truth.pluginActive ? 'yes' : 'no') &&
      Boolean(truth.siteName && text.toLowerCase().includes(truth.siteName.toLowerCase()))
    );
  }
  return false;
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(flattenStrings);
  }
  return [];
}

function mcpResultsMatchTruth(truth: AgentGroundTruth, toolResults: unknown[]): boolean {
  const text = `${flattenStrings(toolResults).join('\n')}\n${JSON.stringify(toolResults)}`;
  if (truth.count !== undefined) {
    return new RegExp(`"total"\\s*:\\s*${truth.count}(?:\\D|$)`).test(text);
  }
  if (truth.updateSiteUrls) {
    return truth.updateSiteUrls.every(url => text.includes(url));
  }
  if (truth.pluginActive !== undefined && truth.pluginSlug) {
    const slug = truth.pluginSlug.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return new RegExp(`"slug"\\s*:\\s*"${slug}"[^}]*"active"\\s*:\\s*${truth.pluginActive}`).test(
      text
    );
  }
  return false;
}

function evaluate(
  scenario: AgentScenario,
  truth: AgentGroundTruth,
  collected: Pick<CollectedAgentOutput, 'toolUses' | 'toolResults' | 'finalText'>
): AgentEvaluation {
  const appropriate = collected.toolUses.filter(tool =>
    toolFamilyMatches(tool.name, scenario.expectedTools)
  );
  const rightArguments = appropriate.every(
    tool => tool.input !== null && typeof tool.input === 'object'
  );
  const hasTargetArgument =
    truth.siteId === undefined ||
    appropriate.some(tool => {
      const serialized = JSON.stringify(tool.input);
      return (
        serialized.includes(String(truth.siteId)) ||
        Boolean(truth.siteUrl && serialized.includes(truth.siteUrl))
      );
    });
  const resultErrors = collected.toolResults.filter(result =>
    JSON.stringify(result).match(/"is_error"\s*:\s*true|"isError"\s*:\s*true/)
  );
  const resultsMatch = mcpResultsMatchTruth(truth, collected.toolResults);
  return {
    understoodRequest: {
      pass: collected.finalText.trim().length > 0,
      evidence: collected.finalText,
    },
    rightCapability: {
      pass: appropriate.length > 0,
      evidence: collected.toolUses.map(tool => tool.name),
    },
    rightArguments: {
      pass: appropriate.length > 0 && rightArguments && hasTargetArgument,
      evidence: appropriate.map(tool => tool.input),
    },
    correctMcpResult: {
      pass: collected.toolResults.length > 0 && resultErrors.length === 0 && resultsMatch,
      evidence: {
        resultCount: collected.toolResults.length,
        errorCount: resultErrors.length,
        groundTruthMatched: resultsMatch,
      },
    },
    stateChange: {
      pass: true,
      evidence: 'Not applicable. Agent scenarios are read-only.',
    },
    faithfulFinalAnswer: {
      pass: finalAnswerMatches(truth, collected.finalText),
      evidence: { truth, finalText: collected.finalText },
    },
  };
}

async function runClaude(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const started = performance.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let pending = '';
  child.stdout.on('data', chunk => {
    const buffer = Buffer.from(chunk);
    stdoutChunks.push(buffer);
    pending += buffer.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  });
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  if (pending.trim()) onLine(pending);
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    durationMs: Math.round(performance.now() - started),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const scenario of agentScenarios) process.stdout.write(`${scenario.id}\n`);
    return;
  }
  const byId = new Map(agentScenarios.map(scenario => [scenario.id, scenario]));
  const selected =
    options.scenarioIds.length > 0
      ? options.scenarioIds.map(id => {
          const scenario = byId.get(id);
          if (!scenario) throw new Error(`Unknown agent scenario: ${id}`);
          return scenario;
        })
      : agentScenarios;
  const needsLive = selected.some(scenario => scenario.target === 'live');
  const needsFixture = selected.some(scenario => scenario.target === 'fixture');
  const liveCredentials = needsLive ? resolveAcceptanceCredentials() : undefined;
  let fixture: FixtureDashboard | undefined;
  let fixtureCredentials: AcceptanceCredentials | undefined;
  if (needsFixture) {
    fixture = await startFixtureDashboard();
    fixtureCredentials = {
      dashboardUrl: fixture.url,
      username: FIXTURE_USERNAME,
      appPassword: FIXTURE_APP_PASSWORD,
    };
  }
  const credentialsByTarget = new Map<'live' | 'fixture', AcceptanceCredentials>();
  if (liveCredentials) credentialsByTarget.set('live', liveCredentials);
  if (fixtureCredentials) credentialsByTarget.set('fixture', fixtureCredentials);
  const firstCredentials = liveCredentials ?? fixtureCredentials;
  if (!firstCredentials) throw new Error('No agent acceptance target was selected');
  const authorization = `Basic ${Buffer.from(
    `${firstCredentials.username}:${firstCredentials.appPassword}`
  ).toString('base64')}`;
  const redactor = new Redactor({ ...firstCredentials, authorization });
  if (fixtureCredentials && fixtureCredentials !== firstCredentials) {
    redactor.add({
      ...fixtureCredentials,
      authorization: `Basic ${Buffer.from(
        `${fixtureCredentials.username}:${fixtureCredentials.appPassword}`
      ).toString('base64')}`,
    });
  }
  const runner = new CommandRunner();
  const artifactTarget = needsLive && needsFixture ? 'mixed' : needsFixture ? 'fixture' : 'live';
  const artifacts = await createArtifacts(
    REPO_ROOT,
    redactor,
    runner,
    'packed',
    artifactTarget,
    { agent: true, scenarios: options.scenarioIds, keepConsumer: options.keepConsumer },
    '-agent'
  );
  const verifiers = new Map<'live' | 'fixture', IndependentVerifier>();
  if (liveCredentials) verifiers.set('live', new IndependentVerifier(liveCredentials, true));
  if (fixtureCredentials) {
    verifiers.set('fixture', new IndependentVerifier(fixtureCredentials, false));
  }
  const results: AgentResult[] = [];
  let packed;
  try {
    packed = await packAndInstall(REPO_ROOT, runner, artifacts, options.keepConsumer);
    const configPath = path.join(packed.tempRoot, 'claude-mcp.json');
    const which = await runner.run(['which', 'claude'], REPO_ROOT, { allowFailure: true });
    const claudeAvailable = which.exitCode === 0;

    for (const scenario of selected) {
      const credentials = credentialsByTarget.get(scenario.target);
      const verifier = verifiers.get(scenario.target);
      if (!credentials || !verifier) {
        throw new Error(`No ${scenario.target} credentials or verifier were prepared`);
      }
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            mcpServers: {
              mainwp: {
                command: 'node',
                args: [packed.installedEntry],
                env: {
                  MAINWP_URL: '${MAINWP_URL}',
                  MAINWP_USER: '${MAINWP_USER}',
                  MAINWP_APP_PASSWORD: '${MAINWP_APP_PASSWORD}',
                  MAINWP_SKIP_SSL_VERIFY: '${MAINWP_SKIP_SSL_VERIFY}',
                  MAINWP_ALLOW_HTTP: '${MAINWP_ALLOW_HTTP}',
                  MAINWP_RATE_LIMIT: '0',
                },
              },
            },
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
      let truth: AgentGroundTruth;
      try {
        truth = await scenario.groundTruth(verifier);
      } catch (error) {
        results.push({
          id: scenario.id,
          status: 'unverified',
          toolUses: [],
          toolResults: [],
          finalText: '',
          reason: `Independent verifier precondition failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const task = scenario.task(truth);
      const argv = [
        'claude',
        '-p',
        task,
        '--mcp-config',
        configPath,
        '--strict-mcp-config',
        '--allowedTools',
        'mcp__mainwp__*',
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        '20',
      ];
      if (!claudeAvailable) {
        results.push({
          id: scenario.id,
          status: 'unverified',
          toolUses: [],
          toolResults: [],
          finalText: '',
          groundTruth: truth,
          reason: `Blocked command: ${shellDisplay(argv)}. The claude CLI was not found.`,
        });
        continue;
      }
      const collected: CollectedAgentOutput = {
        toolUses: [],
        toolResults: [],
        finalText: '',
      };
      const command = await runClaude(
        argv,
        REPO_ROOT,
        {
          ...process.env,
          MAINWP_URL: credentials.dashboardUrl,
          MAINWP_USER: credentials.username,
          MAINWP_APP_PASSWORD: credentials.appPassword,
          MAINWP_SKIP_SSL_VERIFY: scenario.target === 'live' ? 'true' : 'false',
          MAINWP_ALLOW_HTTP: scenario.target === 'fixture' ? 'true' : 'false',
        },
        line => {
          try {
            const event = JSON.parse(line) as unknown;
            artifacts.appendJsonLine('agent-transcript.jsonl', { scenario: scenario.id, event });
            collectEvent(event, collected);
          } catch {
            artifacts.appendJsonLine('agent-transcript.jsonl', {
              scenario: scenario.id,
              unparsed: line,
            });
          }
        }
      );
      runner.record({
        argv,
        cwd: REPO_ROOT,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
        stdoutTail: command.stdout.slice(-12_000),
        stderrTail: command.stderr.slice(-12_000),
      });
      if (command.exitCode !== 0) {
        results.push({
          id: scenario.id,
          status: 'unverified',
          model: collected.model,
          toolUses: collected.toolUses,
          toolResults: collected.toolResults,
          finalText: collected.finalText,
          groundTruth: truth,
          reason: `Blocked command: ${shellDisplay(argv)}. Exit ${command.exitCode}: ${command.stderr.slice(-2000)}`,
        });
        continue;
      }
      const evaluated = scenario.evaluate
        ? await scenario.evaluate(truth, collected, verifier)
        : { evaluation: evaluate(scenario, truth, collected) };
      const evaluation = evaluated.evaluation;
      const pass = Object.values(evaluation).every(field => field.pass);
      results.push({
        id: scenario.id,
        status: pass ? 'passed' : 'failed',
        model: collected.model,
        toolUses: collected.toolUses,
        toolResults: collected.toolResults,
        finalText: collected.finalText,
        groundTruth: truth,
        evaluation,
        ...(!pass && evaluated.reason ? { reason: evaluated.reason } : {}),
      });
    }
    artifacts.writeJson('results.json', { scenarios: results });
    artifacts.write(
      'summary.md',
      `# MainWP MCP agent acceptance results\n\n${results
        .map(
          result =>
            `- ${result.status.toUpperCase()} ${result.id}${result.reason ? `: ${result.reason}` : ''}`
        )
        .join('\n')}\n`
    );
  } finally {
    artifacts.finish();
    await Promise.all([...verifiers.values()].map(verifier => verifier.close()));
    await fixture?.close();
    packed?.cleanup();
  }
  for (const result of results)
    process.stdout.write(`${result.status.toUpperCase()} ${result.id}\n`);
  process.stdout.write(`Artifacts: ${artifacts.runDir}\n`);
  if (results.some(result => result.status === 'failed')) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
