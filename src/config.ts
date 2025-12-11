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
import path from 'path';
import os from 'os';

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
  /** Ability namespace filter (default: 'mainwp') */
  abilityNamespace: string;
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
  /** Maximum cumulative response data per server session in bytes (default: 52428800 = 50MB) */
  maxSessionData: number;
  /** Configuration source: 'environment', 'settings file', or 'mixed' */
  configSource: 'environment' | 'settings file' | 'mixed';
}

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
  /** Rate limit: max API requests per minute (0 = disabled) */
  rateLimit?: number;
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;
  /** Maximum response size in bytes (default: 10485760 = 10MB) */
  maxResponseSize?: number;
  /** Maximum cumulative response data per server session in bytes (default: 52428800 = 50MB) */
  maxSessionData?: number;
  /** Ability namespace filter (default: 'mainwp') */
  abilityNamespace?: string;
  /** Optional list of allowed tool names (whitelist). If set, only these tools are exposed. */
  allowedTools?: string[];
  /** Optional list of blocked tool names (blacklist). These tools are never exposed. */
  blockedTools?: string[];
}

const SETTINGS_FILENAME = 'settings.json';

/**
 * Validate settings file structure and types
 * Throws on validation errors with descriptive messages
 */
function validateSettingsFile(settings: any, filePath: string): void {
  // Guard: root value must be a non-null plain object
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Invalid settings file: ${filePath}\n  - root value must be a JSON object`);
  }

  const errors: string[] = [];

  // Define expected field types
  const stringFields = ['dashboardUrl', 'username', 'appPassword', 'apiToken', 'abilityNamespace'];
  const booleanFields = ['skipSslVerify', 'allowHttp', 'safeMode'];
  const numberFields = ['rateLimit', 'requestTimeout', 'maxResponseSize', 'maxSessionData'];
  const arrayFields = ['allowedTools', 'blockedTools'];

  // Validate string fields
  for (const field of stringFields) {
    if (settings[field] !== undefined && typeof settings[field] !== 'string') {
      errors.push(`"${field}" must be a string`);
    }
  }

  // Validate boolean fields
  for (const field of booleanFields) {
    if (settings[field] !== undefined && typeof settings[field] !== 'boolean') {
      errors.push(`"${field}" must be a boolean`);
    }
  }

  // Validate number fields
  for (const field of numberFields) {
    if (settings[field] !== undefined && typeof settings[field] !== 'number') {
      errors.push(`"${field}" must be a number`);
    }
  }

  // Validate array fields (must be arrays of strings)
  for (const field of arrayFields) {
    const value = settings[field];
    if (value !== undefined) {
      if (!Array.isArray(value) || !value.every((x: any) => typeof x === 'string')) {
        errors.push(`"${field}" must be an array of strings`);
      }
    }
  }

  // Detect unknown fields
  const validFields = new Set([...stringFields, ...booleanFields, ...numberFields, ...arrayFields]);
  for (const key of Object.keys(settings)) {
    if (!validFields.has(key)) {
      errors.push(`Unknown field "${key}"`);
    }
  }

  // Report all errors at once
  if (errors.length > 0) {
    throw new Error(`Invalid settings file: ${filePath}\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

/**
 * Load settings from settings.json file
 * Searches: CWD first, then ~/.config/mainwp-mcp/
 * Returns null if no file found (silent fallback)
 * Throws on validation errors
 */
export function loadSettingsFile(): SettingsFile | null {
  const searchPaths = [
    path.join(process.cwd(), SETTINGS_FILENAME),
    path.join(os.homedir(), '.config', 'mainwp-mcp', SETTINGS_FILENAME),
  ];

  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      let content: string;
      let parsed: any;

      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (error: any) {
        throw new Error(`Failed to read settings file: ${filePath}\n${error.message}`);
      }

      try {
        parsed = JSON.parse(content);
      } catch (error: any) {
        throw new Error(`Invalid JSON in settings file: ${filePath}\n${error.message}`);
      }

      validateSettingsFile(parsed, filePath);
      console.error(`[mainwp-mcp] Loaded settings from: ${filePath}`);
      return parsed as SettingsFile;
    }
  }

  return null;
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

/**
 * Get boolean value with precedence: env var > settings file > default
 */
function getBoolean(
  envVar: string | undefined,
  fileValue: boolean | undefined,
  defaultValue: boolean
): boolean {
  if (envVar !== undefined && envVar !== '') {
    return envVar === 'true';
  }
  if (fileValue !== undefined) {
    return fileValue;
  }
  return defaultValue;
}

/**
 * Get number value with precedence: env var > settings file > default
 */
function getNumber(
  envVar: string | undefined,
  fileValue: number | undefined,
  defaultValue: number
): number {
  if (envVar !== undefined && envVar !== '') {
    return parseInt(envVar, 10);
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
    return envVar.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (fileValue !== undefined) {
    return fileValue;
  }
  return defaultValue;
}

/**
 * Load configuration from environment variables and settings file
 * Precedence: environment variables > settings file > defaults
 */
export function loadConfig(): Config {
  // Load settings file (returns null if not found)
  const settings = loadSettingsFile();

  // Determine config source based on what's available
  const hasEnvVars = !!(
    process.env.MAINWP_URL ||
    process.env.MAINWP_USER ||
    process.env.MAINWP_APP_PASSWORD ||
    process.env.MAINWP_TOKEN ||
    process.env.MAINWP_SKIP_SSL_VERIFY ||
    process.env.MAINWP_ALLOW_HTTP ||
    process.env.MAINWP_SAFE_MODE ||
    process.env.MAINWP_RATE_LIMIT ||
    process.env.MAINWP_REQUEST_TIMEOUT ||
    process.env.MAINWP_MAX_RESPONSE_SIZE ||
    process.env.MAINWP_MAX_SESSION_DATA ||
    process.env.MAINWP_ABILITY_NAMESPACE ||
    process.env.MAINWP_ALLOWED_TOOLS ||
    process.env.MAINWP_BLOCKED_TOOLS
  );

  const configSource: 'environment' | 'settings file' | 'mixed' =
    settings === null ? 'environment' :
    !hasEnvVars ? 'settings file' :
    'mixed';

  // Merge configuration with precedence: env > file > default
  const dashboardUrl = getString(process.env.MAINWP_URL, settings?.dashboardUrl, '');
  const username = getString(process.env.MAINWP_USER, settings?.username, '');
  const appPassword = getString(process.env.MAINWP_APP_PASSWORD, settings?.appPassword, '');
  const apiToken = getString(process.env.MAINWP_TOKEN, settings?.apiToken, '');
  const skipSslVerify = getBoolean(process.env.MAINWP_SKIP_SSL_VERIFY, settings?.skipSslVerify, false);
  const allowHttp = getBoolean(process.env.MAINWP_ALLOW_HTTP, settings?.allowHttp, false);
  const safeMode = getBoolean(process.env.MAINWP_SAFE_MODE, settings?.safeMode, false);

  // Parse rate limit (default: 60 requests/minute)
  const rateLimit = getNumber(process.env.MAINWP_RATE_LIMIT, settings?.rateLimit, 60);
  if (isNaN(rateLimit) || rateLimit < 0) {
    throw new Error('MAINWP_RATE_LIMIT must be a non-negative integer (set via environment variable or settings.json)');
  }

  // Parse request timeout (default: 30000ms = 30 seconds)
  const requestTimeout = getNumber(process.env.MAINWP_REQUEST_TIMEOUT, settings?.requestTimeout, 30000);
  if (isNaN(requestTimeout) || requestTimeout <= 0) {
    throw new Error('MAINWP_REQUEST_TIMEOUT must be a positive integer (set via environment variable or settings.json)');
  }

  // Parse max response size (default: 10485760 bytes = 10MB)
  const maxResponseSize = getNumber(process.env.MAINWP_MAX_RESPONSE_SIZE, settings?.maxResponseSize, 10485760);
  if (isNaN(maxResponseSize) || maxResponseSize <= 0) {
    throw new Error('MAINWP_MAX_RESPONSE_SIZE must be a positive integer (set via environment variable or settings.json)');
  }

  // Parse max session data (default: 52428800 bytes = 50MB)
  const maxSessionData = getNumber(process.env.MAINWP_MAX_SESSION_DATA, settings?.maxSessionData, 52428800);
  if (isNaN(maxSessionData) || maxSessionData <= 0) {
    throw new Error('MAINWP_MAX_SESSION_DATA must be a positive integer (set via environment variable or settings.json)');
  }

  // Parse ability namespace (default: 'mainwp', strip trailing slashes)
  const abilityNamespace = getString(process.env.MAINWP_ABILITY_NAMESPACE, settings?.abilityNamespace, 'mainwp').replace(/\/+$/, '');

  // Security warning: empty namespace exposes ALL abilities from the API
  if (!abilityNamespace) {
    console.error(
      'WARNING: Empty abilityNamespace exposes ALL abilities from the Abilities API. ' +
      'This may include abilities from other plugins. Set abilityNamespace to restrict exposure.'
    );
  }

  // Parse allowed/blocked tool lists
  const allowedTools = getStringArray(process.env.MAINWP_ALLOWED_TOOLS, settings?.allowedTools, []);
  const blockedTools = getStringArray(process.env.MAINWP_BLOCKED_TOOLS, settings?.blockedTools, []);

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

  if (!dashboardUrl) {
    throw new Error('MAINWP_URL is required (set via environment variable or settings.json)');
  }

  // Determine auth type
  const hasBasicAuth = username && appPassword;
  const hasBearerAuth = apiToken;

  if (!hasBasicAuth && !hasBearerAuth) {
    throw new Error(
      'Authentication required: Set MAINWP_USER + MAINWP_APP_PASSWORD or MAINWP_TOKEN (via environment variables or settings.json)'
    );
  }

  // Normalize URL (remove trailing slash)
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
    console.error('WARNING: dashboardUrl uses HTTP - credentials will be transmitted in plain text');
  }

  // Prefer basic auth (Application Password) as it works with Abilities API
  if (hasBasicAuth) {
    return {
      dashboardUrl: normalizedUrl,
      authType: 'basic',
      username,
      appPassword,
      skipSslVerify,
      allowHttp,
      rateLimit,
      abilityNamespace,
      requestTimeout,
      maxResponseSize,
      safeMode,
      maxSessionData,
      configSource,
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(blockedTools.length > 0 ? { blockedTools } : {}),
    };
  }

  return {
    dashboardUrl: normalizedUrl,
    authType: 'bearer',
    apiToken,
    skipSslVerify,
    allowHttp,
    rateLimit,
    abilityNamespace,
    requestTimeout,
    maxResponseSize,
    safeMode,
    maxSessionData,
    configSource,
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(blockedTools.length > 0 ? { blockedTools } : {}),
  };
}

/**
 * Build the Abilities API base URL
 */
export function getAbilitiesApiUrl(config: Config): string {
  return `${config.dashboardUrl}/wp-json/wp-abilities/v1`;
}

/**
 * Get authorization headers for API requests
 */
export function getAuthHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.authType === 'basic' && config.username && config.appPassword) {
    // WordPress Application Password uses Basic Auth
    const credentials = Buffer.from(`${config.username}:${config.appPassword}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  } else if (config.authType === 'bearer' && config.apiToken) {
    headers['Authorization'] = `Bearer ${config.apiToken}`;
  }

  return headers;
}
