import { spawn, type ChildProcess } from 'node:child_process';

/**
 * SIGKILL the child's whole process group (requires spawn with detached:
 * true); falls back to the direct child when the group kill fails.
 */
export function killProcessTree(child: ChildProcess): void {
  if (typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Group may already be gone or unavailable; fall through.
    }
  }
  child.kill('SIGKILL');
}

export interface CommandRecord {
  argv: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut?: boolean;
}

export interface CommandResult extends CommandRecord {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(readonly result: CommandResult) {
    super(
      `Command failed with exit code ${result.exitCode}: ${result.argv.join(' ')}\n${result.stderrTail}`
    );
  }
}

function tail(value: string, maxLength = 12_000): string {
  return value.length <= maxLength ? value : value.slice(-maxLength);
}

export interface ChildCompletion {
  exitCode: number;
  timedOut: boolean;
  spawnError?: Error;
}

/**
 * Await a spawned child under a hard deadline. On timeout the whole process
 * group is killed (spawn with detached: true), and a bounded fallback armed
 * from the timeout callback itself resolves even when a descendant that
 * escaped the group kill keeps the stdio pipes open — arming it from 'exit'
 * would miss the case where the child exits before the deadline. Promise
 * resolution is idempotent, so every path may safely resolve.
 */
export async function awaitChildWithDeadline(
  child: ChildProcess,
  timeoutMs: number,
  fallbackMs = 2_000
): Promise<ChildCompletion> {
  let timedOut = false;
  let spawnError: Error | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const exitCode = await new Promise<number>(resolve => {
    timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      setTimeout(() => resolve(124), fallbackMs).unref();
    }, timeoutMs);
    child.once('error', error => {
      // A spawn failure never emits 'close', so resolve here or hang forever.
      spawnError = error;
      resolve(1);
    });
    child.once('close', code => resolve(timedOut ? 124 : (code ?? 1)));
  }).finally(() => clearTimeout(timeout));
  return { exitCode, timedOut, spawnError };
}

export class CommandRunner {
  readonly records: CommandRecord[] = [];
  onRecord?: (record: CommandRecord) => void;

  record(record: CommandRecord): void {
    this.records.push(record);
    this.onRecord?.(record);
  }

  async run(
    argv: string[],
    cwd: string,
    options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeoutMs?: number } = {}
  ): Promise<CommandResult> {
    const started = performance.now();
    // detached puts the child in its own process group so a timeout can kill
    // the whole tree — SIGKILL on the direct child alone leaves grandchildren
    // holding the stdio pipes, and 'close' never fires.
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));

    const timeoutMs = options.timeoutMs ?? 300_000;
    const { exitCode, timedOut, spawnError } = await awaitChildWithDeadline(child, timeoutMs);
    const stdoutText = Buffer.concat(stdout).toString('utf8');
    const capturedStderr = Buffer.concat(stderr).toString('utf8');
    const stderrText = [
      capturedStderr,
      ...(timedOut ? [`Command timed out after ${timeoutMs}ms`] : []),
      ...(spawnError ? [spawnError.message] : []),
    ]
      .filter(Boolean)
      .join('\n');
    const result: CommandResult = {
      argv,
      cwd,
      exitCode,
      durationMs: Math.round(performance.now() - started),
      stdout: stdoutText,
      stderr: stderrText,
      stdoutTail: tail(stdoutText),
      stderrTail: tail(stderrText),
      ...(timedOut ? { timedOut: true } : {}),
    };
    const record: CommandRecord = {
      argv: result.argv,
      cwd: result.cwd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
      ...(result.timedOut ? { timedOut: true } : {}),
    };
    this.record(record);

    if (exitCode !== 0 && !options.allowFailure) throw new CommandError(result);
    return result;
  }
}
