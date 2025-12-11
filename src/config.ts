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
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): Config {
  const dashboardUrl = process.env.MAINWP_URL;
  const username = process.env.MAINWP_USER;
  const appPassword = process.env.MAINWP_APP_PASSWORD;
  const apiToken = process.env.MAINWP_TOKEN;
  const skipSslVerify = process.env.MAINWP_SKIP_SSL_VERIFY === 'true';
  const allowHttp = process.env.MAINWP_ALLOW_HTTP === 'true';
  const safeMode = process.env.MAINWP_SAFE_MODE === 'true';

  // Parse rate limit (default: 60 requests/minute)
  const rateLimitStr = process.env.MAINWP_RATE_LIMIT ?? '60';
  const rateLimit = parseInt(rateLimitStr, 10);
  if (isNaN(rateLimit) || rateLimit < 0) {
    throw new Error('MAINWP_RATE_LIMIT must be a non-negative integer');
  }

  // Parse request timeout (default: 30000ms = 30 seconds)
  const timeoutStr = process.env.MAINWP_REQUEST_TIMEOUT ?? '30000';
  const requestTimeout = parseInt(timeoutStr, 10);
  if (isNaN(requestTimeout) || requestTimeout <= 0) {
    throw new Error('MAINWP_REQUEST_TIMEOUT must be a positive integer');
  }

  // Parse max response size (default: 10485760 bytes = 10MB)
  const maxSizeStr = process.env.MAINWP_MAX_RESPONSE_SIZE ?? '10485760';
  const maxResponseSize = parseInt(maxSizeStr, 10);
  if (isNaN(maxResponseSize) || maxResponseSize <= 0) {
    throw new Error('MAINWP_MAX_RESPONSE_SIZE must be a positive integer');
  }

  // Parse max session data (default: 52428800 bytes = 50MB)
  const maxSessionDataStr = process.env.MAINWP_MAX_SESSION_DATA ?? '52428800';
  const maxSessionData = parseInt(maxSessionDataStr, 10);
  if (isNaN(maxSessionData) || maxSessionData <= 0) {
    throw new Error('MAINWP_MAX_SESSION_DATA must be a positive integer');
  }

  // Parse ability namespace (default: 'mainwp', strip trailing slashes)
  const abilityNamespace = (process.env.MAINWP_ABILITY_NAMESPACE || 'mainwp').replace(/\/+$/, '');

  // Parse allowed/blocked tool lists (comma-separated)
  const allowedTools = process.env.MAINWP_ALLOWED_TOOLS
    ?.split(',')
    .map(s => s.trim())
    .filter(Boolean) ?? [];
  const blockedTools = process.env.MAINWP_BLOCKED_TOOLS
    ?.split(',')
    .map(s => s.trim())
    .filter(Boolean) ?? [];

  // Validate no conflicts between allowed and blocked lists
  if (allowedTools.length > 0 && blockedTools.length > 0) {
    const allowedSet = new Set(allowedTools);
    const conflicts = blockedTools.filter(tool => allowedSet.has(tool));
    if (conflicts.length > 0) {
      throw new Error(
        `Tool allow/block list conflict: ${conflicts.join(', ')} appear in both MAINWP_ALLOWED_TOOLS and MAINWP_BLOCKED_TOOLS`
      );
    }
  }

  if (!dashboardUrl) {
    throw new Error('MAINWP_URL environment variable is required');
  }

  // Determine auth type
  const hasBasicAuth = username && appPassword;
  const hasBearerAuth = apiToken;

  if (!hasBasicAuth && !hasBearerAuth) {
    throw new Error(
      'Authentication required: Set MAINWP_USER + MAINWP_APP_PASSWORD (recommended) or MAINWP_TOKEN'
    );
  }

  // Normalize URL (remove trailing slash)
  const normalizedUrl = dashboardUrl.replace(/\/+$/, '');

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    throw new Error(`Invalid MAINWP_URL: "${dashboardUrl}" is not a valid URL`);
  }

  // Block HTTP by default (insecure credential transmission)
  if (parsedUrl.protocol === 'http:') {
    if (!allowHttp) {
      throw new Error(
        'MAINWP_URL uses HTTP which transmits credentials in plain text. ' +
        'Use HTTPS, or set MAINWP_ALLOW_HTTP=true to allow insecure connections (not recommended).'
      );
    }
    console.error('WARNING: MAINWP_URL uses HTTP - credentials will be transmitted in plain text');
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
