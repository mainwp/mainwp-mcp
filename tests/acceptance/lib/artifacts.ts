import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { CommandRecord, CommandRunner } from './commands.js';
import type { Redactor } from './redact.js';

export const HARNESS_VERSION = '1.0.0';

export interface TarballManifest {
  filename: string;
  sha256: string;
  integrity: string;
}

export interface AcceptanceManifest {
  git: {
    branch: string;
    commit: string;
    dirty: boolean;
    diffSha256: string;
  };
  packageVersion: string;
  tarball: TarballManifest | null;
  nodeVersion: string;
  npmVersion: string;
  os: string;
  arch: string;
  harnessVersion: string;
  mode: string;
  target: string;
  flags: Record<string, unknown>;
  startTime: string;
  endTime: string | null;
}

interface EventRecord {
  scenario: string;
  direction: 'client-to-server' | 'server-to-client';
  timestamp: string;
  monotonicMs: number;
  message: JSONRPCMessage;
}

export class Artifacts {
  readonly runDir: string;
  readonly manifest: AcceptanceManifest;
  private readonly monotonicStart = performance.now();
  private readonly serverStderrBuffers = new Map<string, string>();

  constructor(
    readonly repoRoot: string,
    readonly runId: string,
    private readonly redactor: Redactor,
    manifest: AcceptanceManifest
  ) {
    this.runDir = path.join(repoRoot, 'test-results', 'acceptance', runId);
    this.manifest = manifest;
    fs.mkdirSync(this.runDir, { recursive: true });
    this.writeJson('manifest.json', manifest);
    fs.writeFileSync(path.join(this.runDir, 'events.jsonl'), '');
    fs.writeFileSync(path.join(this.runDir, 'commands.jsonl'), '');
  }

  writeJson(filename: string, value: unknown): void {
    this.write(filename, `${JSON.stringify(value, null, 2)}\n`);
  }

  write(filename: string, value: string): void {
    fs.writeFileSync(path.join(this.runDir, filename), this.redactor.redact(value), 'utf8');
  }

  appendJsonLine(filename: string, value: unknown): void {
    fs.appendFileSync(
      path.join(this.runDir, filename),
      `${this.redactor.stringify(value)}\n`,
      'utf8'
    );
  }

  appendEvent(
    scenario: string,
    direction: EventRecord['direction'],
    message: JSONRPCMessage
  ): void {
    this.appendJsonLine('events.jsonl', {
      scenario,
      direction,
      timestamp: new Date().toISOString(),
      monotonicMs: Math.round((performance.now() - this.monotonicStart) * 1000) / 1000,
      message,
    } satisfies EventRecord);
  }

  appendServerStderr(scenario: string, value: string): void {
    const filename = `server-${scenario.replace(/[^a-z0-9_-]/gi, '_')}.stderr.log`;
    const buffered = `${this.serverStderrBuffers.get(filename) ?? ''}${value}`;
    const { output, remainder } = this.redactor.redactStream(buffered);
    this.serverStderrBuffers.set(filename, remainder);
    if (output) fs.appendFileSync(path.join(this.runDir, filename), output, 'utf8');
  }

  flushServerStderr(scenario: string): void {
    const filename = `server-${scenario.replace(/[^a-z0-9_-]/gi, '_')}.stderr.log`;
    const remainder = this.serverStderrBuffers.get(filename);
    if (remainder) {
      fs.appendFileSync(path.join(this.runDir, filename), this.redactor.redact(remainder), 'utf8');
    }
    this.serverStderrBuffers.delete(filename);
  }

  recordCommand(record: CommandRecord): void {
    this.appendJsonLine('commands.jsonl', record);
  }

  setTarball(tarball: TarballManifest): void {
    this.manifest.tarball = tarball;
    this.writeJson('manifest.json', this.manifest);
  }

  finish(): void {
    this.manifest.endTime = new Date().toISOString();
    this.writeJson('manifest.json', this.manifest);
  }
}

export async function createArtifacts(
  repoRoot: string,
  redactor: Redactor,
  runner: CommandRunner,
  mode: string,
  target: string,
  flags: Record<string, unknown>,
  suffix = ''
): Promise<Artifacts> {
  const branch = (await runner.run(['git', 'branch', '--show-current'], repoRoot)).stdout.trim();
  const commit = (await runner.run(['git', 'rev-parse', 'HEAD'], repoRoot)).stdout.trim();
  const status = (await runner.run(['git', 'status', '--porcelain'], repoRoot)).stdout;
  const diff = (await runner.run(['git', 'diff', 'HEAD'], repoRoot)).stdout;
  const npmVersion = (await runner.run(['npm', '--version'], repoRoot)).stdout.trim();
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  const startTime = new Date().toISOString();
  const timestamp = startTime.replace(/[-:.]/g, '').replace('Z', 'Z');
  const dirty = status.length > 0;
  const runId = `${timestamp}-${commit.slice(0, 8)}${dirty ? '-dirty' : ''}${suffix}`;
  const manifest: AcceptanceManifest = {
    git: {
      branch,
      commit,
      dirty,
      diffSha256: crypto.createHash('sha256').update(diff).digest('hex'),
    },
    packageVersion: packageJson.version,
    tarball: null,
    nodeVersion: process.version,
    npmVersion,
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    harnessVersion: HARNESS_VERSION,
    mode,
    target,
    flags,
    startTime,
    endTime: null,
  };
  const artifacts = new Artifacts(repoRoot, runId, redactor, manifest);
  for (const record of runner.records) artifacts.recordCommand(record);
  runner.onRecord = record => artifacts.recordCommand(record);
  return artifacts;
}
