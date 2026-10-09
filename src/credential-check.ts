/**
 * Startup credential validation.
 *
 * Classifies connection failures into actionable operator-facing messages.
 * No policy logic lives here — this is error-message classification only.
 */

import { fetchAbilities, type Ability } from './abilities.js';
import { Config } from './config.js';
import { describeCredentialRejection, isCredentialRejection } from './credential-diagnostics.js';
import { getErrorMessage, getHttpStatus } from './errors.js';
import type { Logger } from './logging.js';

// undici reports every network or TLS failure as "fetch failed" and keeps the
// reason in error.cause.code. Only a constant-shaped code is repeated; the
// cause message can carry hosts and addresses.
const CAUSE_CODE_RE = /^[A-Z0-9_]{2,64}$/;
const CERT_CAUSE_RE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/;

const CERT_HINT =
  'The Dashboard\'s certificate is not trusted by the Node.js that runs this server. See "SSL certificate problem" at https://docs.mainwp.com/mcp-server/troubleshooting.';

function causeNote(error: unknown): string {
  let code: unknown;
  // A getter or proxy on the cause can throw; its message must not replace the
  // original failure, so an uninspectable cause adds nothing.
  try {
    const cause = error instanceof Error ? error.cause : undefined;
    code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  } catch {
    return '';
  }
  if (typeof code !== 'string' || !CAUSE_CODE_RE.test(code)) return '';
  return CERT_CAUSE_RE.test(code) ? ` (${code}). ${CERT_HINT}` : ` (${code})`;
}

/**
 * The Dashboard answered and refused these credentials. Retrying with the same
 * values cannot help, unlike a network, TLS, or server failure.
 */
export class CredentialRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CredentialRejectedError';
  }
}

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

    const code =
      error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (isCredentialRejection(status, code)) {
      throw new CredentialRejectedError(
        `Authentication failed: ${describeCredentialRejection(config, code)}`,
        { cause: error }
      );
    }

    // A bare 403 may come from a WAF or proxy rather than WordPress, so it
    // keeps the generic guidance and the degraded retry path.
    if (status === 403) {
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
    throw new Error(`Credential validation failed: ${message}${causeNote(error)}`, {
      cause: error,
    });
  }
}
