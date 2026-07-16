import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AcceptanceCredentials {
  dashboardUrl: string;
  username: string;
  appPassword: string;
}

function stripInlineComment(value: string): string {
  const match = value.match(/^(.*?)(?:\s+#.*)?$/);
  return match?.[1]?.trim() ?? value.trim();
}

function unquote(value: string): string {
  const first = value[0];
  if (first === '"' || first === "'") {
    const closingQuote = value.indexOf(first, 1);
    if (closingQuote !== -1) return value.slice(1, closingQuote);
  }
  return stripInlineComment(value);
}

export function parseAcceptanceEnv(content: string): AcceptanceCredentials {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values.set(match[1], unquote(match[2].trim()));
  }

  const credentials = {
    dashboardUrl: values.get('LLM_DASH_URL') ?? '',
    username: values.get('MAINWP_USER') ?? '',
    appPassword: values.get('MAINWP_APP_PASSWORD') ?? '',
  };
  validateCredentials(credentials, 'acceptance environment file');
  return credentials;
}

function validateCredentials(credentials: AcceptanceCredentials, source: string): void {
  const missing = Object.entries(credentials)
    .filter(([, value]) => value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')} in ${source}`);
  }
}

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function resolveAcceptanceCredentials(
  env: NodeJS.ProcessEnv = process.env
): AcceptanceCredentials {
  const fromEnvironment = {
    dashboardUrl: env.MAINWP_URL ?? '',
    username: env.MAINWP_USER ?? '',
    appPassword: env.MAINWP_APP_PASSWORD ?? '',
  };
  if (Object.values(fromEnvironment).every(value => value.length > 0)) {
    return fromEnvironment;
  }

  const envPath = expandHome(
    env.MAINWP_MCP_ACCEPTANCE_ENV ?? '~/github/dev-tools/network-testbed/.env'
  );
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Live acceptance credentials were not complete in the process environment and ${envPath} could not be read`,
      { cause: error }
    );
  }
  return parseAcceptanceEnv(content);
}
