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

  // Parse rate limit (default: 60 requests/minute)
  const rateLimitStr = process.env.MAINWP_RATE_LIMIT ?? '60';
  const rateLimit = parseInt(rateLimitStr, 10);
  if (isNaN(rateLimit) || rateLimit < 0) {
    throw new Error('MAINWP_RATE_LIMIT must be a non-negative integer');
  }

  // Parse ability namespace (default: 'mainwp', strip trailing slashes)
  const abilityNamespace = (process.env.MAINWP_ABILITY_NAMESPACE || 'mainwp').replace(/\/+$/, '');

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
