/**
 * Startup credential validation.
 *
 * Classifies connection failures into actionable operator-facing messages.
 * No policy logic lives here — this is error-message classification only.
 */

import { fetchAbilities, type Ability } from './abilities.js';
import { Config } from './config.js';
import { getErrorMessage, getHttpStatus } from './errors.js';
import type { Logger } from './logging.js';

/**
 * Validate credentials by attempting to fetch abilities from the MainWP Dashboard.
 * Provides enhanced error messages for common failure scenarios.
 *
 * @param config - Server configuration
 * @param logger - Logger for status messages
 * @returns The fetched abilities array on success
 * @throws Error with actionable message on failure
 */
export async function validateCredentials(config: Config, logger: Logger): Promise<Ability[]> {
  try {
    const abilities = await fetchAbilities(config, false, logger);
    logger.info('Credential validation successful: Connected to MainWP Dashboard');
    return abilities;
  } catch (error) {
    const message = getErrorMessage(error);
    const lowerMessage = message.toLowerCase();

    // HTTP failures carry a structured status (createHttpError in http-client.ts);
    // classify on that. Message sniffing below is only for non-HTTP failures
    // (DNS, SSL, timeout) which have no status to inspect.
    const status = getHttpStatus(error);

    // Authentication failures (401/403) - provide auth-type specific guidance
    if (status === 401 || status === 403) {
      const authHint =
        config.authType === 'basic'
          ? 'Verify MAINWP_USER and MAINWP_APP_PASSWORD (or username/appPassword in settings.json) are correct and the user has REST API access.'
          : 'Bearer tokens (MAINWP_TOKEN) are not accepted by the Abilities API, which authenticates through native WordPress. Use MAINWP_USER + MAINWP_APP_PASSWORD (a WordPress Application Password / Basic auth) instead.';
      throw new Error(`Authentication failed: Invalid credentials. ${authHint}`, {
        cause: error,
      });
    }

    // Endpoint not found (404) - likely missing Abilities API plugin
    if (status === 404) {
      throw new Error(
        'Abilities API endpoint not found. Verify MAINWP_URL points to a MainWP Dashboard with the Abilities API plugin installed.',
        { cause: error }
      );
    }

    // Connection timeout
    if (lowerMessage.includes('timeout')) {
      throw new Error(
        'Connection timeout. Verify MAINWP_URL is reachable and the server is responding.',
        { cause: error }
      );
    }

    // SSL/TLS certificate errors
    if (
      lowerMessage.includes('certificate') ||
      lowerMessage.includes('ssl') ||
      lowerMessage.includes('tls') ||
      lowerMessage.includes('self-signed') ||
      lowerMessage.includes('unable to verify')
    ) {
      throw new Error(
        'SSL certificate verification failed. For self-signed certificates, set MAINWP_SKIP_SSL_VERIFY=true (development only).',
        { cause: error }
      );
    }

    // Network connectivity errors
    if (
      lowerMessage.includes('enotfound') ||
      lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('network') ||
      lowerMessage.includes('getaddrinfo') ||
      lowerMessage.includes('econnreset')
    ) {
      throw new Error(
        'Network error: Cannot reach MAINWP_URL. Verify the URL is correct and the server is accessible.',
        { cause: error }
      );
    }

    // Other errors - re-throw with prefix
    throw new Error(`Credential validation failed: ${message}`, { cause: error });
  }
}
