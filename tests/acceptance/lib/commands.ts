import { spawn } from 'node:child_process';

export interface CommandRecord {
  argv: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
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
    options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}
  ): Promise<CommandResult> {
    const started = performance.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
    const stdoutText = Buffer.concat(stdout).toString('utf8');
    const stderrText = Buffer.concat(stderr).toString('utf8');
    const result: CommandResult = {
      argv,
      cwd,
      exitCode,
      durationMs: Math.round(performance.now() - started),
      stdout: stdoutText,
      stderr: stderrText,
      stdoutTail: tail(stdoutText),
      stderrTail: tail(stderrText),
    };
    const record: CommandRecord = {
      argv: result.argv,
      cwd: result.cwd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
    };
    this.record(record);

    if (exitCode !== 0 && !options.allowFailure) throw new CommandError(result);
    return result;
  }
}
