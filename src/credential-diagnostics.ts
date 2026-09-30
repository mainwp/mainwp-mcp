/**
 * Credential rejection diagnostics.
 *
 * WordPress answers a wrong login with a generic `invalid_username` that names
 * neither the user nor where the value came from (issue #77). Startup, the
 * setup tools, and tool execution all word the rejection here, so each one
 * names the same user and the same sources.
 */

import type { Config, ConnectionKey, ConnectionSource } from './config.js';

/** WordPress Application Password failures, by REST error `code`. */
const REJECTION_CODES = new Set([
  'invalid_username',
  'invalid_email',
  'incorrect_password',
  'application_passwords_disabled',
  'application_passwords_disabled_for_user',
]);

// The code is remote input; only a plain WordPress-style slug is repeated.
const WP_ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

// Usernames come from local config, but they reach logs and the transcript.
const MAX_USERNAME_SHOWN = 100;

const BEARER_HINT =
  'Bearer tokens (MAINWP_TOKEN) are not accepted by the Abilities API, which authenticates through native WordPress. Use MAINWP_USER + MAINWP_APP_PASSWORD (a WordPress Application Password / Basic auth) instead.';

const SOURCE_LABELS: Record<ConnectionSource, string> = {
  env: 'the environment',
  'settings.json': 'settings.json',
};

/** A WordPress error code safe to repeat, or undefined. */
export function safeWpErrorCode(code: unknown): string | undefined {
  return typeof code === 'string' && WP_ERROR_CODE_RE.test(code) ? code : undefined;
}

/**
 * True when the Dashboard answered and refused the credentials, as opposed to
 * being unreachable or failing. Any 401 counts. A 403 counts only with a
 * WordPress rejection code, because WAFs and proxies send bare 403s too.
 */
export function isCredentialRejection(status: number | undefined, code: unknown): boolean {
  if (status === 401) return true;
  const safeCode = safeWpErrorCode(code);
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    safeCode !== undefined &&
    REJECTION_CODES.has(safeCode)
  );
}

/**
 * WordPress Application Password shape: 24 alphanumerics, shown as six groups
 * of four. A username like this is most likely the password in the wrong
 * field, and it is not registered as a secret, so it must not be echoed.
 * WordPress ignores separators when it compares, so a paste with padding,
 * other whitespace, or hyphens between the groups is the same password.
 */
export function looksLikeApplicationPassword(value: string): boolean {
  return /^[A-Za-z0-9]{4}(?:[\s-]*[A-Za-z0-9]{4}){5}$/.test(value.trim());
}

function quoteUsername(username: string): string {
  const shown =
    username.length > MAX_USERNAME_SHOWN ? `${username.slice(0, MAX_USERNAME_SHOWN)}...` : username;
  // JSON quoting escapes control characters and embedded quotes.
  return JSON.stringify(shown);
}

// "KEY from source", never "KEY: source": sanitizeError redacts anything that
// looks like PASSWORD: value, which would swallow the source name.
function describeSources(config: Config, keys: ConnectionKey[]): string {
  const parts = keys.flatMap(key => {
    const source = config.connectionSources[key];
    return source ? [`${key} from ${SOURCE_LABELS[source]}`] : [];
  });
  return parts.length > 0 ? ` Sources: ${parts.join(', ')}.` : '';
}

/**
 * One-paragraph explanation of a credential rejection: which user, which
 * sources, and what WordPress expects. Never includes the password.
 */
export function describeCredentialRejection(config: Config, code?: unknown): string {
  const safeCode = safeWpErrorCode(code);
  const codeNote = safeCode && REJECTION_CODES.has(safeCode) ? ` (${safeCode})` : '';

  if (config.authType === 'bearer') {
    return `The Dashboard rejected the bearer token${codeNote}.${describeSources(config, ['MAINWP_URL', 'MAINWP_TOKEN'])} ${BEARER_HINT}`;
  }

  const sources = describeSources(config, ['MAINWP_URL', 'MAINWP_USER', 'MAINWP_APP_PASSWORD']);
  if (looksLikeApplicationPassword(config.username ?? '')) {
    return `The Dashboard rejected the credentials${codeNote}.${sources} The MAINWP_USER value looks like an Application Password, so MAINWP_USER and MAINWP_APP_PASSWORD may be swapped.`;
  }
  const user = quoteUsername(config.username ?? '');

  if (safeCode === 'invalid_username' || safeCode === 'invalid_email') {
    return `The Dashboard has no user ${user}${codeNote}.${sources} WordPress expects the login name or email address, not the display name.`;
  }
  if (safeCode === 'incorrect_password') {
    return `The Dashboard rejected the application password for user ${user}${codeNote}.${sources} Use an Application Password from that user's profile page, not the account's login password.`;
  }
  return `The Dashboard rejected the credentials for user ${user}${codeNote}.${sources} WordPress expects the login name or email address, not the display name, and an Application Password, not the account's login password.`;
}
