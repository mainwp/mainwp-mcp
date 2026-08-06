/**
 * MainWP MCP Server Configuration
 *
 * Configuration is loaded from environment variables:
 * - MAINWP_URL: Base URL of the MainWP Dashboard (e.g., https://dashboard.example.com)
 *
 * Authentication (one of):
 * - MAINWP_USER + MAINWP_APP_PASSWORD: WordPress Application Password (recommended for Abilities API)
 * - MAINWP_TOKEN: MainWP REST API Bearer token (only works with MainWP endpoints, not Abilities API)
 */

import fs from 'fs';
import { getErrorMessage } from './errors.js';
import path from 'path';
import os from 'os';

/** Allowed schema verbosity values */
export const SCHEMA_VERBOSITY_VALUES = ['compact', 'standard'] as const;

/** Schema verbosity type derived from allowed values */
export type SchemaVerbosity = (typeof SCHEMA_VERBOSITY_VALUES)[number];

/** Allowed response format values */
export const RESPONSE_FORMAT_VALUES = ['compact', 'pretty'] as const;

/** Response format type derived from allowed values */
export type ResponseFormat = (typeof RESPONSE_FORMAT_VALUES)[number];

export interface Config {
  /** Base URL of the MainWP Dashboard */
  dashboardUrl: string;
  /** Authentication type: 'basic' (app password) or 'bearer' (MainWP token) */
  authType: 'basic' | 'bearer';
  /** WordPress username (for basic auth) */
  username?: string;
  /** WordPress Application Password (for basic auth) */
  appPassword?: string;
  /** Bearer token for REST API authentication (for MainWP-specific endpoints) */
  apiToken?: string;
  /** Whether to skip SSL verification (for local dev with self-signed certs) */
  skipSslVerify: boolean;
  /** Whether HTTP URLs are explicitly allowed (insecure) */
  allowHttp: boolean;
  /** Rate limit: max API requests per minute (0 = disabled) */
  rateLimit: number;
  /** Optional list of allowed tool names (whitelist). If set, only these tools are exposed. */
  allowedTools?: string[];
  /** Optional list of blocked tool names (blacklist). These tools are never exposed. */
  blockedTools?: string[];
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout: number;
  /** Maximum response size in bytes (default: 10485760 = 10MB) */
  maxResponseSize: number;
  /** Safe mode: prevents destructive operations by stripping confirm parameter */
  safeMode: boolean;
  /** Require explicit user confirmation for destructive operations via two-phase preview flow */
  requireUserConfirmation: boolean;
  /** Maximum cumulative response data per server session in bytes (default: 52428800 = 50MB) */
  maxSessionData: number;
  /** Schema verbosity level: 'compact' reduces token usage, 'standard' provides full descriptions */
  schemaVerbosity: SchemaVerbosity;
  /** Response format: 'compact' omits whitespace to reduce token usage, 'pretty' uses 2-space indentation */
  responseFormat: ResponseFormat;
  /**
   * Allowed ability namespaces (default: ['mainwp']). Abilities whose name's
   * namespace prefix is in this list are surfaced as MCP tools. The first
   * entry is the *primary* namespace — its abilities get unprefixed tool
   * names; other namespaces produce `{ns}__{tool}` to avoid collisions.
   *
   * Typed as a non-empty tuple so `abilityNamespaces[0]` is statically known
   * to be a string. `loadConfig` enforces this at runtime; the type makes
   * direct Config construction (e.g. in tests) honor the same invariant.
   */
  abilityNamespaces: [string, ...string[]];
  /** Enable retry logic for transient errors (default: true) */
  retryEnabled: boolean;
  /** Maximum retry attempts including initial request (default: 2) */
  maxRetries: number;
  /** Base delay between retries in milliseconds (default: 1000) */
  retryBaseDelay: number;
  /** Maximum delay between retries in milliseconds (default: 2000) */
  retryMaxDelay: number;
  /** Configuration source: 'environment', 'settings file', or 'mixed' */
  configSource: 'environment' | 'settings file' | 'mixed';
}

/**
 * Everything `loadConfig` validates that is not connection identity: policy,
 * limits, transport, and formatting. Setup mode runs on this alone (tool
 * filters have to gate the setup tools too), so the resolver can hand it back
 * without a Dashboard URL or credentials.
 */
export type PolicyConfig = Omit<
  Config,
  'dashboardUrl' | 'authType' | 'username' | 'appPassword' | 'apiToken'
>;

/**
 * Result of resolving configuration. `unconfigured` is first-run absence, not
 * invalid input: every other validation failure still throws.
 */
export type ConfigResolution =
  | { status: 'ready'; config: Config }
  | {
      status: 'unconfigured';
      missing: 'MAINWP_URL' | 'credentials';
      message: string;
      policy: PolicyConfig;
    };

/**
 * Settings file interface - all fields optional for file-based configuration
 */
export interface SettingsFile {
  /** Base URL of the MainWP Dashboard */
  dashboardUrl?: string;
  /** WordPress username (for basic auth) */
  username?: string;
  /** WordPress Application Password (for basic auth) */
  appPassword?: string;
  /** Bearer token for REST API authentication (for MainWP-specific endpoints) */
  apiToken?: string;
  /** Whether to skip SSL verification (for local dev with self-signed certs) */
  skipSslVerify?: boolean;
  /** Whether HTTP URLs are explicitly allowed (insecure) */
  allowHttp?: boolean;
  /** Safe mode: prevents destructive operations by stripping confirm parameter */
  safeMode?: boolean;
  /** Require explicit user confirmation for destructive operations via two-phase preview flow */
  requireUserConfirmation?: boolean;
  /** Rate limit: max API requests per minute (0 = disabled) */
  rateLimit?: number;
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;
  /** Maximum response size in bytes (default: 10485760 = 10MB) */
  maxResponseSize?: number;
  /** Maximum cumulative response data per server session in bytes (default: 52428800 = 50MB) */
  maxSessionData?: number;
  /** Optional list of allowed tool names (whitelist). If set, only these tools are exposed. */
  allowedTools?: string[];
  /** Optional list of blocked tool names (blacklist). These tools are never exposed. */
  blockedTools?: string[];
  /** Schema verbosity level: 'compact' reduces token usage, 'standard' provides full descriptions */
  schemaVerbosity?: SchemaVerbosity;
  /** Response format: 'compact' omits whitespace to reduce token usage, 'pretty' uses 2-space indentation */
  responseFormat?: ResponseFormat;
  /** Allowed ability namespaces (default: ['mainwp']). First entry is the primary namespace. */
  abilityNamespaces?: string[];
  /** Enable retry logic for transient errors (default: true) */
  retryEnabled?: boolean;
  /** Maximum retry attempts including initial request (default: 2) */
  maxRetries?: number;
  /** Base delay between retries in milliseconds (default: 1000) */
  retryBaseDelay?: number;
  /** Maximum delay between retries in milliseconds (default: 2000) */
  retryMaxDelay?: number;
}

const SETTINGS_FILENAME = 'settings.json';

/**
 * Valid WP Abilities namespace: lowercase alphanumeric with internal hyphens,
 * no leading/trailing hyphen. Must stay in sync with the namespace portion of
 * ABILITY_NAME_RE in abilities.ts — a namespace accepted here but rejected
 * there would silently filter out every ability it matches.
 */
const ABILITY_NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Default namespace allowlist. */
const DEFAULT_ABILITY_NAMESPACES: readonly string[] = ['mainwp'] as const;

/**
 * Field → type map for settings.json validation. Each SettingsFile property
 * is declared exactly once here; the type checks and unknown-field detection
 * in validateSettingsFile both derive from this map. Adding a settings field
 * means adding one entry here (plus the SettingsFile interface and its
 * loadConfig getter call).
 */
const SETTINGS_FIELD_TYPES: Record<string, 'string' | 'boolean' | 'number' | 'string[]'> = {
  dashboardUrl: 'string',
  username: 'string',
  appPassword: 'string',
  apiToken: 'string',
  schemaVerbosity: 'string',
  responseFormat: 'string',
  skipSslVerify: 'boolean',
  allowHttp: 'boolean',
  safeMode: 'boolean',
  requireUserConfirmation: 'boolean',
  retryEnabled: 'boolean',
  rateLimit: 'number',
  requestTimeout: 'number',
  maxResponseSize: 'number',
  maxSessionData: 'number',
  maxRetries: 'number',
  retryBaseDelay: 'number',
  retryMaxDelay: 'number',
  allowedTools: 'string[]',
  blockedTools: 'string[]',
  abilityNamespaces: 'string[]',
};

/**
 * Validate settings file structure and types
 * Throws on validation errors with descriptive messages
 */
function validateSettingsFile(settings: unknown, filePath: string): void {
  // Guard: root value must be a non-null plain object
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Invalid settings file: ${filePath}\n  - root value must be a JSON object`);
  }
  const record = settings as Record<string, unknown>;

  const errors: string[] = [];

  // Validate every declared field against its type; string[] gets the
  // array-of-strings check, the rest a typeof check
  for (const [field, type] of Object.entries(SETTINGS_FIELD_TYPES)) {
    const value = record[field];
    if (value === undefined) continue;
    if (type === 'string[]') {
      if (!Array.isArray(value) || !value.every((x: unknown) => typeof x === 'string')) {
        errors.push(`"${field}" must be an array of strings`);
      }
    } else if (typeof value !== type) {
      errors.push(`"${field}" must be a ${type}`);
    } else if (type === 'number' && !Number.isSafeInteger(value)) {
      // Same contract as getNumber's env-var parsing: integers only, within
      // the safe range. JSON also permits decimals and 1e999 (Infinity with
      // typeof 'number'), both of which would pass downstream isNaN checks
      errors.push(`"${field}" must be an integer within the safe range`);
    }
  }

  // Validate schemaVerbosity enum
  if (record.schemaVerbosity !== undefined) {
    if (!(SCHEMA_VERBOSITY_VALUES as readonly unknown[]).includes(record.schemaVerbosity)) {
      errors.push(
        `"schemaVerbosity" must be one of: ${SCHEMA_VERBOSITY_VALUES.join(', ')}; got: "${record.schemaVerbosity}"`
      );
    }
  }

  // Validate responseFormat enum
  if (record.responseFormat !== undefined) {
    if (!(RESPONSE_FORMAT_VALUES as readonly unknown[]).includes(record.responseFormat)) {
      errors.push(
        `"responseFormat" must be one of: ${RESPONSE_FORMAT_VALUES.join(', ')}; got: "${record.responseFormat}"`
      );
    }
  }

  // Validate abilityNamespaces entries (charset + non-empty list). The
  // generic arrayFields check above already verified every entry is a string,
  // so only the charset check runs here.
  if (Array.isArray(record.abilityNamespaces)) {
    if (record.abilityNamespaces.length === 0) {
      errors.push('"abilityNamespaces" must not be empty');
    }
    for (const ns of record.abilityNamespaces) {
      if (typeof ns !== 'string') continue; // arrayFields check reported this already
      if (!ABILITY_NAMESPACE_RE.test(ns)) {
        errors.push(
          `"abilityNamespaces" entry "${ns}" must match ${ABILITY_NAMESPACE_RE} (lowercase alphanumeric and internal hyphens)`
        );
      }
    }
  }

  // Detect unknown fields
  // Valid fields: all SettingsFile properties plus _comment (for inline documentation per schema)
  const validFields = new Set([...Object.keys(SETTINGS_FIELD_TYPES), '_comment']);
  for (const key of Object.keys(record)) {
    if (!validFields.has(key)) {
      errors.push(`Unknown field "${key}"`);
    }
  }

  // Report all errors at once
  if (errors.length > 0) {
    throw new Error(
      `Invalid settings file: ${filePath}\n${errors.map(e => `  - ${e}`).join('\n')}`
    );
  }
}

/**
 * A loaded settings file plus whether its source is trusted. The per-user
 * config under ~/.config/mainwp-mcp is trusted; a settings.json discovered in
 * the current working directory is NOT — anyone who can write to (or lure the
 * operator into launching from) that directory can plant one. loadConfig uses
 * `trusted` to refuse security-flag values that would weaken the secure
 * posture (see fileSecurityFlag).
 */
interface LoadedSettings {
  settings: SettingsFile;
  trusted: boolean;
}

/**
 * Load settings from settings.json, reporting whether the source is trusted.
 * Searches: CWD first, then ~/.config/mainwp-mcp/. Returns null if no file
 * found (silent fallback). Throws on validation errors.
 */
function loadSettingsFileWithSource(): LoadedSettings | null {
  const searchPaths = [
    path.join(process.cwd(), SETTINGS_FILENAME),
    path.join(os.homedir(), '.config', 'mainwp-mcp', SETTINGS_FILENAME),
  ];
  const cwdPath = searchPaths[0];
  const homePath = searchPaths[1];

  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      let content: string;
      let parsed: unknown;

      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (error) {
        throw new Error(`Failed to read settings file: ${filePath}\n${getErrorMessage(error)}`, {
          cause: error,
        });
      }

      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new Error(`Invalid JSON in settings file: ${filePath}\n${getErrorMessage(error)}`, {
          cause: error,
        });
      }

      validateSettingsFile(parsed, filePath);

      // A settings.json in the current working directory is untrusted: a
      // malicious file in a shared or attacker-writable directory could
      // redirect API calls to capture credentials, or weaken a default-secure
      // flag. loadConfig refuses security-flag values from an untrusted source.
      const fromUntrustedCwd = filePath === cwdPath && cwdPath !== homePath;
      if (fromUntrustedCwd) {
        console.error(
          `[mainwp-mcp] WARNING: Loading settings from working directory (${filePath}). ` +
            `Ensure this file is trusted. Prefer ~/.config/mainwp-mcp/settings.json for production.`
        );
      } else {
        console.error('[mainwp-mcp] Loaded settings from file');
      }

      return { settings: parsed as SettingsFile, trusted: !fromUntrustedCwd };
    }
  }

  return null;
}

/**
 * Load settings from settings.json file
 * Searches: CWD first, then ~/.config/mainwp-mcp/
 * Returns null if no file found (silent fallback)
 * Throws on validation errors
 */
export function loadSettingsFile(): SettingsFile | null {
  return loadSettingsFileWithSource()?.settings ?? null;
}

/**
 * Get string value with precedence: env var > settings file > default
 */
function getString(
  envVar: string | undefined,
  fileValue: string | undefined,
  defaultValue: string
): string {
  if (envVar !== undefined && envVar !== '') {
    return envVar;
  }
  if (fileValue !== undefined && fileValue !== '') {
    return fileValue;
  }
  return defaultValue;
}

/** Accepted boolean env var spellings (case-insensitive) */
const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSY_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Get boolean value with precedence: env var > settings file > default.
 * Unrecognized non-empty env values fail startup rather than falling through
 * to a file/default value — several of these flags are security-relevant.
 */
function getBoolean(
  name: string,
  envVar: string | undefined,
  fileValue: boolean | undefined,
  defaultValue: boolean
): boolean {
  if (envVar !== undefined && envVar !== '') {
    const normalized = envVar.trim().toLowerCase();
    if (TRUTHY_VALUES.has(normalized)) {
      return true;
    }
    if (FALSY_VALUES.has(normalized)) {
      return false;
    }
    throw new Error(`${name} must be a boolean (true/1/yes/on or false/0/no/off), got "${envVar}"`);
  }
  if (fileValue !== undefined) {
    return fileValue;
  }
  return defaultValue;
}

/**
 * Gate a security-relevant boolean coming from a settings file so an untrusted
 * current-working-directory file cannot weaken a default-secure posture. Each
 * gated flag has one `insecureValue` — the boolean that loosens security
 * (requireUserConfirmation=false, skipSslVerify=true, allowHttp=true). From an
 * untrusted source that exact value is dropped (returns undefined) so
 * getBoolean falls through to the env var — still authoritative, checked
 * first — or the secure default. Env vars and the trusted per-user config are
 * never affected; a file value that does not loosen posture passes through
 * unchanged. safeMode is not gated: its default (false) is already the
 * least-restrictive value, so a CWD file cannot make it less secure.
 */
function fileSecurityFlag(
  name: string,
  fileValue: boolean | undefined,
  insecureValue: boolean,
  trusted: boolean
): boolean | undefined {
  if (!trusted && fileValue === insecureValue) {
    console.error(
      `[mainwp-mcp] WARNING: Ignoring "${name}" from the working-directory settings.json ` +
        `because an untrusted file may not weaken this security setting. ` +
        `Set it via an environment variable or ~/.config/mainwp-mcp/settings.json.`
    );
    return undefined;
  }
  return fileValue;
}

/**
 * Get number value with precedence: env var > settings file > default.
 * Non-integer env values fail startup — a silently truncated "60abc" → 60
 * is worse than a clear config error for limits and timeouts.
 */
function getNumber(
  name: string,
  envVar: string | undefined,
  fileValue: number | undefined,
  defaultValue: number
): number {
  if (envVar !== undefined && envVar !== '') {
    const trimmed = envVar.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`${name} must be an integer, got "${envVar}"`);
    }
    const value = parseInt(trimmed, 10);
    // Digit-only strings can still overflow to Infinity (e.g. 400 digits),
    // which passes isNaN/positive checks downstream and disables every
    // limit that compares against it
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${name} must be within the safe integer range, got "${envVar}"`);
    }
    return value;
  }
  if (fileValue !== undefined) {
    return fileValue;
  }
  return defaultValue;
}

/**
 * Get string array value with precedence: env var > settings file > default
 */
function getStringArray(
  envVar: string | undefined,
  fileValue: string[] | undefined,
  defaultValue: string[]
): string[] {
  if (envVar !== undefined && envVar !== '') {
    return envVar
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  if (fileValue !== undefined) {
    return fileValue;
  }
  return defaultValue;
}

/**
 * Every MAINWP_* env var read by loadConfig. Used to compute configSource —
 * keep in sync with the getter calls below when adding a config option.
 */
const MAINWP_ENV_VARS = [
  'MAINWP_URL',
  'MAINWP_USER',
  'MAINWP_APP_PASSWORD',
  'MAINWP_TOKEN',
  'MAINWP_SKIP_SSL_VERIFY',
  'MAINWP_ALLOW_HTTP',
  'MAINWP_SAFE_MODE',
  'MAINWP_REQUIRE_USER_CONFIRMATION',
  'MAINWP_RATE_LIMIT',
  'MAINWP_REQUEST_TIMEOUT',
  'MAINWP_MAX_RESPONSE_SIZE',
  'MAINWP_MAX_SESSION_DATA',
  'MAINWP_ALLOWED_TOOLS',
  'MAINWP_BLOCKED_TOOLS',
  'MAINWP_SCHEMA_VERBOSITY',
  'MAINWP_RESPONSE_FORMAT',
  'MAINWP_RETRY_ENABLED',
  'MAINWP_MAX_RETRIES',
  'MAINWP_RETRY_BASE_DELAY',
  'MAINWP_RETRY_MAX_DELAY',
  'MAINWP_ABILITY_NAMESPACES',
] as const;

/**
 * First-run configuration is absent entirely (no dashboard URL or no
 * credentials), as opposed to present but invalid. The CLI entry point
 * renders this as getting-started guidance instead of a fatal error.
 */
export class MissingConfigError extends Error {
  constructor(
    message: string,
    public readonly missing: 'MAINWP_URL' | 'credentials'
  ) {
    super(message);
    this.name = 'MissingConfigError';
  }
}

/**
 * Load configuration from environment variables and settings file
 * Precedence: environment variables > settings file > defaults
 *
 * Throws when configuration is absent; `resolveConfig` is the entry point that
 * reports absence as a value instead.
 */
export function loadConfig(): Config {
  const resolution = resolveConfig();
  if (resolution.status === 'unconfigured') {
    throw new MissingConfigError(resolution.message, resolution.missing);
  }
  return resolution.config;
}

/**
 * Resolve configuration, reporting first-run absence as a value so the server
 * can start in setup mode with validated policy settings and no credentials.
 * Present-but-invalid input still throws: the operator configured something
 * wrong and a startup error is the honest answer.
 */
export function resolveConfig(): ConfigResolution {
  // Load settings file (returns null if not found)
  const loaded = loadSettingsFileWithSource();
  const settings = loaded?.settings ?? null;
  // A settings.json discovered in the current working directory is an
  // untrusted source and may not loosen security flags (see fileSecurityFlag).
  // No file, or the trusted per-user config, counts as trusted.
  const settingsTrusted = loaded === null || loaded.trusted;

  // Determine config source based on what's available
  const hasEnvVars = MAINWP_ENV_VARS.some(name => !!process.env[name]);

  const configSource: 'environment' | 'settings file' | 'mixed' =
    settings === null ? 'environment' : !hasEnvVars ? 'settings file' : 'mixed';

  // Merge configuration with precedence: env > file > default
  // An untrusted CWD file may not choose where environment-sourced credentials
  // are sent: a planted file naming its own dashboardUrl, combined with real
  // credentials from env vars, exfiltrates those credentials to that host. The
  // untrusted URL is dropped so startup fails closed on missing configuration.
  // A CWD file carrying url and credentials together stays allowed - that is
  // the documented per-folder multi-dashboard pattern, and it routes nothing
  // that did not come from the same file.
  const username = getString(process.env.MAINWP_USER, settings?.username, '');
  const appPassword = getString(process.env.MAINWP_APP_PASSWORD, settings?.appPassword, '');
  const apiToken = getString(process.env.MAINWP_TOKEN, settings?.apiToken, '');
  let fileDashboardUrl = settings?.dashboardUrl;
  const envHasUrl = !!process.env.MAINWP_URL && process.env.MAINWP_URL !== '';
  const envHasUser = !!process.env.MAINWP_USER && process.env.MAINWP_USER !== '';
  const envHasPassword =
    !!process.env.MAINWP_APP_PASSWORD && process.env.MAINWP_APP_PASSWORD !== '';
  const envHasToken = !!process.env.MAINWP_TOKEN && process.env.MAINWP_TOKEN !== '';
  // Only credentials the SELECTED auth mode will send matter here: a complete
  // Basic pair wins over apiToken (see getAuthHeaders), so a stale env token
  // behind a complete same-file Basic config routes nothing and must not
  // reject the documented per-folder pattern.
  const usesBasicAuth = username !== '' && appPassword !== '';
  const envCredentialUsed = usesBasicAuth ? envHasUser || envHasPassword : envHasToken;
  if (!settingsTrusted && !envHasUrl && fileDashboardUrl && envCredentialUsed) {
    console.error(
      `[mainwp-mcp] WARNING: Ignoring "dashboardUrl" from the working-directory settings.json ` +
        `because credentials come from the environment; an untrusted file may not choose where ` +
        `those credentials are sent. Set MAINWP_URL, or keep the URL and credentials together ` +
        `in the same settings file.`
    );
    fileDashboardUrl = undefined;
  }
  const dashboardUrl = getString(process.env.MAINWP_URL, fileDashboardUrl, '');
  const skipSslVerify = getBoolean(
    'MAINWP_SKIP_SSL_VERIFY',
    process.env.MAINWP_SKIP_SSL_VERIFY,
    fileSecurityFlag('skipSslVerify', settings?.skipSslVerify, true, settingsTrusted),
    false
  );
  const allowHttp = getBoolean(
    'MAINWP_ALLOW_HTTP',
    process.env.MAINWP_ALLOW_HTTP,
    fileSecurityFlag('allowHttp', settings?.allowHttp, true, settingsTrusted),
    false
  );
  // safeMode is not gated by fileSecurityFlag: its default (false) is already
  // the least-restrictive value, so a CWD file cannot make it less secure.
  const safeMode = getBoolean(
    'MAINWP_SAFE_MODE',
    process.env.MAINWP_SAFE_MODE,
    settings?.safeMode,
    false
  );
  const requireUserConfirmation = getBoolean(
    'MAINWP_REQUIRE_USER_CONFIRMATION',
    process.env.MAINWP_REQUIRE_USER_CONFIRMATION,
    fileSecurityFlag(
      'requireUserConfirmation',
      settings?.requireUserConfirmation,
      false,
      settingsTrusted
    ),
    true
  );

  // Parse rate limit (default: 60 requests/minute)
  const rateLimit = getNumber(
    'MAINWP_RATE_LIMIT',
    process.env.MAINWP_RATE_LIMIT,
    settings?.rateLimit,
    60
  );
  if (rateLimit < 0) {
    throw new Error(
      'MAINWP_RATE_LIMIT must be a non-negative integer (set via environment variable or settings.json)'
    );
  }

  // Parse request timeout (default: 30000ms = 30 seconds)
  const requestTimeout = getNumber(
    'MAINWP_REQUEST_TIMEOUT',
    process.env.MAINWP_REQUEST_TIMEOUT,
    settings?.requestTimeout,
    30000
  );
  if (requestTimeout <= 0) {
    throw new Error(
      'MAINWP_REQUEST_TIMEOUT must be a positive integer (set via environment variable or settings.json)'
    );
  }

  // Parse max response size (default: 10485760 bytes = 10MB)
  const maxResponseSize = getNumber(
    'MAINWP_MAX_RESPONSE_SIZE',
    process.env.MAINWP_MAX_RESPONSE_SIZE,
    settings?.maxResponseSize,
    10485760
  );
  if (maxResponseSize <= 0) {
    throw new Error(
      'MAINWP_MAX_RESPONSE_SIZE must be a positive integer (set via environment variable or settings.json)'
    );
  }

  // Parse max session data (default: 52428800 bytes = 50MB)
  const maxSessionData = getNumber(
    'MAINWP_MAX_SESSION_DATA',
    process.env.MAINWP_MAX_SESSION_DATA,
    settings?.maxSessionData,
    52428800
  );
  if (maxSessionData <= 0) {
    throw new Error(
      'MAINWP_MAX_SESSION_DATA must be a positive integer (set via environment variable or settings.json)'
    );
  }

  // Parse allowed/blocked tool lists
  const allowedTools = getStringArray(process.env.MAINWP_ALLOWED_TOOLS, settings?.allowedTools, []);
  const blockedTools = getStringArray(process.env.MAINWP_BLOCKED_TOOLS, settings?.blockedTools, []);

  // Parse schema verbosity (default: 'standard' for backwards compatibility)
  const schemaVerbosityRaw = getString(
    process.env.MAINWP_SCHEMA_VERBOSITY,
    settings?.schemaVerbosity,
    'standard'
  );

  // Validate enum value before narrowing the type
  if (!(SCHEMA_VERBOSITY_VALUES as readonly string[]).includes(schemaVerbosityRaw)) {
    throw new Error(
      `MAINWP_SCHEMA_VERBOSITY must be one of: ${SCHEMA_VERBOSITY_VALUES.join(', ')}; got: "${schemaVerbosityRaw}" ` +
        `(set via environment variable or settings.json)`
    );
  }
  const schemaVerbosity = schemaVerbosityRaw as SchemaVerbosity;

  // Parse response format (default: 'compact' to reduce token usage)
  const responseFormatRaw = getString(
    process.env.MAINWP_RESPONSE_FORMAT,
    settings?.responseFormat,
    'compact'
  );

  // Validate enum value before narrowing the type
  if (!(RESPONSE_FORMAT_VALUES as readonly string[]).includes(responseFormatRaw)) {
    throw new Error(
      `MAINWP_RESPONSE_FORMAT must be one of: ${RESPONSE_FORMAT_VALUES.join(', ')}; got: "${responseFormatRaw}" ` +
        `(set via environment variable or settings.json)`
    );
  }
  const responseFormat = responseFormatRaw as ResponseFormat;

  // Parse ability namespace allowlist (default: ['mainwp']). Deduplicate so
  // the env-var path (no schema-level uniqueItems) and the settings.json path
  // produce identical cache signatures for equivalent input.
  const rawAbilityNamespaces = getStringArray(
    process.env.MAINWP_ABILITY_NAMESPACES,
    settings?.abilityNamespaces,
    [...DEFAULT_ABILITY_NAMESPACES]
  );
  const abilityNamespaces = Array.from(new Set(rawAbilityNamespaces));
  if (abilityNamespaces.length === 0) {
    const source = process.env.MAINWP_ABILITY_NAMESPACES
      ? `MAINWP_ABILITY_NAMESPACES="${process.env.MAINWP_ABILITY_NAMESPACES}"`
      : 'settings.json';
    throw new Error(
      `abilityNamespaces must contain at least one non-empty entry (got from ${source})`
    );
  }
  for (const ns of abilityNamespaces) {
    if (!ABILITY_NAMESPACE_RE.test(ns)) {
      throw new Error(
        `Invalid abilityNamespaces entry "${ns}": must match ${ABILITY_NAMESPACE_RE} (lowercase alphanumeric and internal hyphens)`
      );
    }
  }
  // Re-assert the non-empty-tuple shape for the Config interface.
  const abilityNamespacesTuple = abilityNamespaces as [string, ...string[]];

  // Parse retry configuration
  const retryEnabled = getBoolean(
    'MAINWP_RETRY_ENABLED',
    process.env.MAINWP_RETRY_ENABLED,
    settings?.retryEnabled,
    true
  );

  const maxRetries = getNumber(
    'MAINWP_MAX_RETRIES',
    process.env.MAINWP_MAX_RETRIES,
    settings?.maxRetries,
    2
  );
  if (maxRetries < 1 || maxRetries > 5) {
    throw new Error(
      'MAINWP_MAX_RETRIES must be between 1 and 5 (set via environment variable or settings.json)'
    );
  }

  const retryBaseDelay = getNumber(
    'MAINWP_RETRY_BASE_DELAY',
    process.env.MAINWP_RETRY_BASE_DELAY,
    settings?.retryBaseDelay,
    1000
  );
  if (retryBaseDelay < 500 || retryBaseDelay > 10000) {
    throw new Error(
      'MAINWP_RETRY_BASE_DELAY must be between 500ms and 10000ms (set via environment variable or settings.json)'
    );
  }

  const retryMaxDelay = getNumber(
    'MAINWP_RETRY_MAX_DELAY',
    process.env.MAINWP_RETRY_MAX_DELAY,
    settings?.retryMaxDelay,
    2000
  );
  if (retryMaxDelay < retryBaseDelay || retryMaxDelay > 30000) {
    throw new Error(
      `MAINWP_RETRY_MAX_DELAY must be between ${retryBaseDelay}ms and 30000ms (set via environment variable or settings.json)`
    );
  }

  // Validate no conflicts between allowed and blocked lists
  if (allowedTools.length > 0 && blockedTools.length > 0) {
    const allowedSet = new Set(allowedTools);
    const conflicts = blockedTools.filter(tool => allowedSet.has(tool));
    if (conflicts.length > 0) {
      throw new Error(
        `Tool allow/block list conflict: ${conflicts.join(', ')} appear in both allowedTools and blockedTools`
      );
    }
  }

  // Built before the connection checks below so setup mode still gets every
  // validated non-credential setting.
  const policy: PolicyConfig = {
    skipSslVerify,
    allowHttp,
    rateLimit,
    requestTimeout,
    maxResponseSize,
    safeMode,
    requireUserConfirmation,
    maxSessionData,
    schemaVerbosity,
    responseFormat,
    abilityNamespaces: abilityNamespacesTuple,
    retryEnabled,
    maxRetries,
    retryBaseDelay,
    retryMaxDelay,
    configSource,
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(blockedTools.length > 0 ? { blockedTools } : {}),
  };

  if (!dashboardUrl) {
    return {
      status: 'unconfigured',
      missing: 'MAINWP_URL',
      message: 'MAINWP_URL is required (set via environment variable or settings.json)',
      policy,
    };
  }

  // Runs before the credentials check: a URL that is present but malformed is
  // something the user actively configured wrong, and setup mode cannot repair
  // it (the env var stays authoritative over anything configure would write),
  // so it must fail fast even when credentials are also missing.
  const normalizedUrl = dashboardUrl.replace(/\/+$/, '');

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    throw new Error(`Invalid dashboardUrl: "${dashboardUrl}" is not a valid URL`);
  }

  // Block HTTP by default (insecure credential transmission)
  if (parsedUrl.protocol === 'http:') {
    if (!allowHttp) {
      throw new Error(
        'dashboardUrl uses HTTP which transmits credentials in plain text. ' +
          'Use HTTPS, or set allowHttp=true to allow insecure connections (not recommended).'
      );
    }
    console.error(
      'WARNING: dashboardUrl uses HTTP - credentials will be transmitted in plain text'
    );
  }

  const hasBasicAuth = username && appPassword;
  const hasBearerAuth = apiToken;

  if (!hasBasicAuth && !hasBearerAuth) {
    return {
      status: 'unconfigured',
      missing: 'credentials',
      message:
        'Authentication required: Set MAINWP_USER + MAINWP_APP_PASSWORD or MAINWP_TOKEN (via environment variables or settings.json)',
      policy,
    };
  }

  if (hasBearerAuth && !hasBasicAuth) {
    console.error(
      'WARNING: MAINWP_TOKEN bearer authentication is expected to fail against the WordPress Abilities API. ' +
        'Configure both MAINWP_USER and MAINWP_APP_PASSWORD with a WordPress Application Password.'
    );
  }

  const shared = {
    ...policy,
    dashboardUrl: normalizedUrl,
  };

  // Prefer basic auth (Application Password) as it works with Abilities API
  if (hasBasicAuth) {
    return {
      status: 'ready',
      config: { ...shared, authType: 'basic' as const, username, appPassword },
    };
  }

  return { status: 'ready', config: { ...shared, authType: 'bearer' as const, apiToken } };
}

/**
 * Serialize data as JSON using the configured response format.
 * 'compact' omits whitespace; 'pretty' uses 2-space indentation.
 */
export function formatJson(config: Pick<Config, 'responseFormat'>, data: unknown): string {
  return config.responseFormat === 'pretty' ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

/**
 * Build the Abilities API base URL
 */
export function getAbilitiesApiUrl(config: Config): string {
  return `${config.dashboardUrl}/wp-json/wp-abilities/v1`;
}

/**
 * Get authorization headers for API requests.
 */
export function getAuthHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.authType === 'basic' && config.username && config.appPassword) {
    headers['Authorization'] =
      `Basic ${Buffer.from(`${config.username}:${config.appPassword}`).toString('base64')}`;
  } else if (config.authType === 'bearer' && config.apiToken) {
    headers['Authorization'] = `Bearer ${config.apiToken}`;
  }

  return headers;
}
