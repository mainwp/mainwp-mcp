/**
 * First-run setup mode.
 *
 * Holds server readiness as mutable state the MCP handlers dereference at call
 * time, exposes the two setup tools, and owns the configure flow: precondition
 * refusals, hostile-input validation of the submitted tuple, live credential
 * validation, persistence, and the state swap.
 *
 * Readiness is an authorization boundary, not a listing filter. Handlers must
 * consult it at execution time, and every string this module returns is
 * scrubbed of registered secrets before it leaves.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { formatJson, type Config, type ConfigResolution, type PolicyConfig } from './config.js';
import { clearCache, initRateLimiter, type Ability } from './abilities.js';
import { clearPendingPreviews } from './confirmation.js';
import { validateCredentials } from './credential-check.js';
import { getErrorMessage, McpErrorFactory } from './errors.js';
import { withSecretRedaction, type Logger } from './logging.js';
import { CONFIGURE_TOOL, RESERVED_TOOL_NAMES, SETUP_STATUS_TOOL } from './naming.js';
import { decidePolicy } from './policy.js';
import {
  appPasswordCanonicalForm,
  appPasswordSecret,
  canRegisterKnownSecrets,
  createSecretRedactor,
  redactKnownSecrets,
  registerKnownSecrets,
  sanitizeError,
  withScopedSecrets,
  MIN_KNOWN_SECRET_LENGTH,
} from './security.js';
import { clearToolsCache, type ToolCallResult } from './tools.js';
import {
  trustedSettingsPath,
  writeConnectionSettings,
  SettingsWriteError,
} from './settings-writer.js';

export { CONFIGURE_TOOL, SETUP_STATUS_TOOL };

const SETUP_GUIDE_URL = 'https://github.com/mainwp/mainwp-mcp#readme';

/** Connection environment variables. Any of them set makes the file we write moot. */
const CONNECTION_ENV_VARS = [
  'MAINWP_URL',
  'MAINWP_USER',
  'MAINWP_APP_PASSWORD',
  'MAINWP_TOKEN',
] as const;

/** Submitted-value caps. Oversized input is rejected, never trimmed. */
const MAX_URL_INPUT = 500;
const MAX_USERNAME_INPUT = 200;
const MAX_PASSWORD_INPUT = 200;

export type SetupState = 'ready' | 'unconfigured' | 'degraded';

/**
 * Mutable readiness holder. Handlers keep a reference to this, not to a
 * Config, so a successful configure changes what every already-registered
 * handler sees.
 */
export class ConfigState {
  private currentConfig: Config | null;
  private readonly missingSetting: 'MAINWP_URL' | 'credentials' | null;
  private policySettings: PolicyConfig;
  private failureReason: string | null = null;
  private operationInFlight = false;

  private constructor(
    config: Config | null,
    missing: 'MAINWP_URL' | 'credentials' | null,
    policy: PolicyConfig
  ) {
    this.currentConfig = config;
    this.missingSetting = missing;
    this.policySettings = policy;
  }

  static fromResolution(resolution: ConfigResolution): ConfigState {
    return resolution.status === 'ready'
      ? ConfigState.fromConfig(resolution.config)
      : new ConfigState(null, resolution.missing, resolution.policy);
  }

  static fromConfig(config: Config): ConfigState {
    return new ConfigState(config, null, policyOf(config));
  }

  /**
   * Readiness only. The setup mutex is deliberately not folded in here: a
   * configure that has already adopted its config is ready, and the
   * listChanged notifications it fires must not reach a client that would
   * then be refused by handlers still calling the server not-ready.
   */
  get state(): SetupState {
    if (this.currentConfig === null) return 'unconfigured';
    return this.failureReason === null ? 'ready' : 'degraded';
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** The effective config, or null while the server is not ready. */
  get readyConfig(): Config | null {
    return this.isReady ? this.currentConfig : null;
  }

  /** The config retained for a degraded retry, or null when unconfigured. */
  get retainedConfig(): Config | null {
    return this.currentConfig;
  }

  get policy(): PolicyConfig {
    return this.policySettings;
  }

  get missing(): 'MAINWP_URL' | 'credentials' | null {
    return this.missingSetting;
  }

  get degradedReason(): string | null {
    return this.failureReason;
  }

  markDegraded(reason: string): void {
    this.failureReason = reason;
  }

  markReady(): void {
    this.failureReason = null;
  }

  /** True while a configure or a degraded-connection retry holds the mutex. */
  get isOperationInFlight(): boolean {
    return this.operationInFlight;
  }

  /**
   * Claim the setup mutex. False means another call already holds it.
   * Configure and the degraded status retry share it, so a retry that started
   * earlier can never finish after a configure adopted a new identity and
   * stamp its stale failure onto it.
   */
  beginOperation(): boolean {
    if (this.operationInFlight) return false;
    this.operationInFlight = true;
    return true;
  }

  endOperation(): void {
    this.operationInFlight = false;
  }

  /** Adopt a validated config. Callers own the rest of the swap sequence. */
  adopt(config: Config): void {
    this.currentConfig = config;
    this.policySettings = policyOf(config);
    this.failureReason = null;
  }
}

function policyOf(config: Config): PolicyConfig {
  const {
    dashboardUrl: _dashboardUrl,
    authType: _authType,
    username: _username,
    appPassword: _appPassword,
    apiToken: _apiToken,
    ...policy
  } = config;
  return policy;
}

/** Fired after a state swap so clients re-read every affected surface. */
export interface SetupNotifier {
  (): Promise<void>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '[invalid-url]';
  }
}

function manualSetupBlock(): string {
  return `Option 1 (recommended): add the credentials yourself. The password never passes through this chat. Put these in the "env" block of this server's entry in your MCP client config, then restart the client:

  MAINWP_URL            https://your-dashboard.com
  MAINWP_USER           your admin username
  MAINWP_APP_PASSWORD   the application password

They can also go in ~/.config/mainwp-mcp/settings.json. Setup guide: ${SETUP_GUIDE_URL}`;
}

function chatSetupBlock(): string {
  return `Option 2: paste them here and I will set it up for you. That is a fine choice too. Why it should be okay: an Application Password is separate from your real login password, and you can revoke it any time from your WordPress profile with one click. The server stores it only in a config file on this machine with owner-only permissions, and scrubs it from its own logs. Worth knowing: the password also becomes part of this conversation's history, which your chat app and AI provider may retain. If that ever bothers you, revoke the password and create a new one. It takes a few seconds.`;
}

function setupGuidance(chatSetupAvailable: boolean): string {
  const intro = `The MainWP MCP server is installed but not connected to your Dashboard yet. Three things are needed: your Dashboard URL, your WordPress admin username, and an Application Password (WordPress profile page, Application Passwords section, name it something like "MainWP MCP" and click Add).`;
  if (!chatSetupAvailable) {
    return `${intro}

${manualSetupBlock()}`;
  }
  return `${intro}

There are two ways to finish setup.

${manualSetupBlock()}

${chatSetupBlock()}`;
}

function relayInstructions(chatSetupAvailable: boolean): string {
  if (!chatSetupAvailable) {
    return "Relay the guidance to the user as written. Chat-based setup is disabled by this server's tool policy, so the manual path is the only option.";
  }
  return 'Present both options to the user neutrally, including the note about chat history, and let them choose. If they pick option 2, collect all three values and then call mainwp_configure once with dashboard_url, username, and application_password. Do not guess or reuse values the user did not give you.';
}

// The manual fix is always included. Chat setup cannot replace loaded
// credentials, so editing the config by hand is the only way out of a wrong
// tuple whether or not mainwp_configure is available.
function degradedGuidance(reason: string): string {
  return `The MainWP MCP server has credentials but could not reach the Dashboard at startup: ${reason}

The credentials are still loaded. Ask me to check again once the Dashboard is reachable and I will retry with them; call ${SETUP_STATUS_TOOL} to run that retry.

If the credentials themselves are wrong, fix them where they are configured (the "env" block of this server's entry in your MCP client config, or ~/.config/mainwp-mcp/settings.json) and restart the client.`;
}

/**
 * JSON tool result. Every string is scrubbed of registered secrets, plus any
 * request-scoped values the caller supplies (the configure path passes the
 * submitted password, which is not in the global registry).
 */
function setupResult(
  policy: PolicyConfig,
  data: Record<string, unknown>,
  isError = false,
  redactSubmitted?: (message: string) => string
): ToolCallResult {
  const serialized = formatJson(policy, data);
  const scoped = redactSubmitted ? redactSubmitted(serialized) : serialized;
  return {
    content: [{ type: 'text', text: redactKnownSecrets(scoped) }],
    ...(isError ? { isError: true } : {}),
  };
}

function refusal(
  policy: PolicyConfig,
  code: string,
  message: string,
  redactSubmitted?: (message: string) => string
): ToolCallResult {
  return setupResult(policy, { status: 'refused', code, message }, true, redactSubmitted);
}

/**
 * Tool definitions for setup mode, after allow/block filtering.
 * Only listed while the server is not ready.
 */
export function getSetupTools(state: ConfigState): Tool[] {
  const policy = state.policy;
  const tools: Tool[] = [
    {
      name: SETUP_STATUS_TOOL,
      description:
        'Report whether the MainWP MCP server is connected to a Dashboard yet, and return the setup instructions to show the user. Call this first when MainWP tools are missing. If the server has credentials but could not reach the Dashboard, this retries the connection.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: {
        title: 'MainWP setup status',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: CONFIGURE_TOOL,
      description:
        'Connect this server to a MainWP Dashboard using credentials the user supplied in chat. Requires all three values at once. The credentials are verified against the Dashboard, then saved to ~/.config/mainwp-mcp/settings.json on this machine with owner-only permissions; the password is scrubbed from server logs and never echoed back. Only usable before the server is connected.',
      inputSchema: {
        type: 'object',
        properties: {
          dashboard_url: {
            type: 'string',
            description:
              'HTTPS URL of the MainWP Dashboard, for example https://dashboard.example.com',
          },
          username: { type: 'string', description: 'WordPress admin username on the Dashboard' },
          application_password: {
            type: 'string',
            description: 'WordPress Application Password for that user',
          },
        },
        required: ['dashboard_url', 'username', 'application_password'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Configure MainWP connection',
        readOnlyHint: false,
        // Configure rewrites local server state and sends the supplied
        // credentials to a model-supplied origin, so clients should surface it
        // for approval like any other consequential call.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ];
  return tools.filter(tool => decidePolicy(policy, tool.name) === 'allow');
}

export function isSetupToolName(name: string): boolean {
  return RESERVED_TOOL_NAMES.has(name);
}

/**
 * Validate a model-supplied Dashboard URL.
 *
 * Stricter than the config loader: the value came from a conversation, so
 * userinfo, query, and fragment (credential-carrying or request-shaping parts)
 * are rejected rather than normalized away, and HTTP is allowed only when the
 * operator already opted into it through env or trusted config.
 */
export function validateConfigureUrl(raw: unknown, allowHttp: boolean): string {
  if (typeof raw !== 'string') {
    throw McpErrorFactory.invalidParams('dashboard_url must be a string');
  }
  if (raw.length === 0 || raw.length > MAX_URL_INPUT) {
    throw McpErrorFactory.invalidParams(
      `dashboard_url must be between 1 and ${MAX_URL_INPUT} characters`
    );
  }
  if (raw !== raw.trim()) {
    throw McpErrorFactory.invalidParams('dashboard_url must not have leading or trailing spaces');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw McpErrorFactory.invalidParams('dashboard_url is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowHttp)) {
    throw McpErrorFactory.invalidParams(
      'dashboard_url must use https. Plain HTTP would send the Application Password in clear text.'
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw McpErrorFactory.invalidParams('dashboard_url must not contain credentials');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw McpErrorFactory.invalidParams(
      'dashboard_url must not contain a query string or fragment'
    );
  }
  // Keep any base path (MainWP runs in subdirectories) but normalize it the
  // same way loadConfig does, so cache identity matches a hand-written config.
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

function validateCredentialField(raw: unknown, field: string, maxLength: number): string {
  if (typeof raw !== 'string') {
    throw McpErrorFactory.invalidParams(`${field} must be a string`);
  }
  if (raw.trim() === '') {
    throw McpErrorFactory.invalidParams(`${field} must not be empty`);
  }
  if (raw.length > maxLength) {
    throw McpErrorFactory.invalidParams(`${field} must be at most ${maxLength} characters`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw McpErrorFactory.invalidParams(`${field} must not contain control characters`);
  }
  return raw;
}

/**
 * A WordPress Application Password is 24 characters, so anything shorter than
 * the redaction registry's floor cannot be one. Rejected here rather than
 * lowering that floor: a saved value the registry refuses to hold is a
 * credential this server can never scrub from its own later output. The floor
 * applies to the form WordPress compares, because that form is registered too
 * and is the shortest one the registry has to accept.
 */
function validateApplicationPassword(raw: unknown): string {
  const value = validateCredentialField(raw, 'application_password', MAX_PASSWORD_INPUT);
  if (appPasswordCanonicalForm(value).length < MIN_KNOWN_SECRET_LENGTH) {
    throw McpErrorFactory.invalidParams(
      'application_password does not look like an Application Password. WordPress shows one as six groups of four characters on your profile page. The password you use to log in to WordPress will not work here.'
    );
  }
  return value;
}

/**
 * Fire the listChanged notifications after a state swap that already happened.
 * A client that rejects the notification has not undone the swap, so the
 * failure is logged and the caller still reports what it actually did.
 */
async function notifyQuietly(notify: SetupNotifier, logger: Logger): Promise<void> {
  try {
    await notify();
  } catch (error) {
    logger.warning('Could not send the setup listChanged notifications', {
      error: sanitizeError(getErrorMessage(error)),
    });
  }
}

/** Environment variables that would outrank anything configure could persist. */
function activeConnectionEnvVars(): string[] {
  return CONNECTION_ENV_VARS.filter(name => {
    const value = process.env[name];
    return value !== undefined && value !== '';
  });
}

async function handleSetupStatus(
  state: ConfigState,
  logger: Logger,
  notify: SetupNotifier
): Promise<ToolCallResult> {
  const policy = state.policy;
  const chatSetupAvailable = decidePolicy(policy, CONFIGURE_TOOL) === 'allow';

  if (state.state === 'degraded') {
    const config = state.retainedConfig;
    if (config) {
      // The retry shares configure's mutex. Without it a retry could still be
      // in flight when a configure adopts a new identity, and its failure
      // would be recorded against credentials it never tested.
      if (!state.beginOperation()) {
        const reason = state.degradedReason ?? 'the connection check failed';
        return setupResult(policy, {
          state: 'degraded',
          dashboardHost: hostOf(config.dashboardUrl),
          problem: reason,
          note: 'Another setup operation is already running, so the connection was not retried. Ask again once it finishes.',
          guidance: degradedGuidance(reason),
        });
      }
      try {
        let abilities: Ability[];
        try {
          // Credential-free recovery: the retained config may simply have hit a
          // Dashboard that was down at startup.
          abilities = await validateCredentials(config, logger);
        } catch (error) {
          const reason = sanitizeError(getErrorMessage(error));
          state.markDegraded(reason);
          return setupResult(policy, {
            state: 'degraded',
            dashboardHost: hostOf(config.dashboardUrl),
            problem: reason,
            guidance: degradedGuidance(reason),
          });
        }
        // Outside the validation catch: a rejected notification is a client
        // problem, and folding it in would undo a connection that works and
        // report the transport error as the Dashboard's.
        state.markReady();
        await notifyQuietly(notify, logger);
        return setupResult(policy, {
          state: 'ready',
          dashboardHost: hostOf(config.dashboardUrl),
          abilitiesCount: abilities.length,
          message: `Connected to ${hostOf(config.dashboardUrl)}. The MainWP tools are available now.`,
          clientRefreshNote: CLIENT_REFRESH_NOTE,
        });
      } finally {
        state.endOperation();
      }
    }
  }

  if (state.isReady) {
    const config = state.readyConfig!;
    return setupResult(policy, {
      state: 'ready',
      dashboardHost: hostOf(config.dashboardUrl),
      message: 'The MainWP MCP server is already connected. No setup is needed.',
    });
  }

  return setupResult(policy, {
    state: 'unconfigured',
    missing: state.missing ?? 'credentials',
    chatSetupAvailable,
    guidance: setupGuidance(chatSetupAvailable),
    relayInstructions: relayInstructions(chatSetupAvailable),
  });
}

const CLIENT_REFRESH_NOTE =
  'If your MCP client does not refresh its tool list on its own, reconnect or restart the server to see the MainWP tools.';

async function handleConfigure(
  state: ConfigState,
  args: Record<string, unknown>,
  logger: Logger,
  notify: SetupNotifier
): Promise<ToolCallResult> {
  const policy = state.policy;

  // Nothing between here and the input validation below can echo a submitted
  // value: every message is a fixed string. So the password is not touched,
  // encoded, or registered until a call has earned it — registration is
  // process-lifetime state, and a refused call must not be able to grow it.
  if (state.isOperationInFlight) {
    return refusal(
      policy,
      'CONFIGURE_IN_PROGRESS',
      'Another setup attempt is still running. Wait for it to finish before trying again.'
    );
  }
  // Any loaded config, not only a working one: degraded means an operator's
  // credentials are present and the Dashboard was unreachable. A conversation
  // may bootstrap a connection, never replace one the operator provisioned.
  if (state.retainedConfig !== null) {
    return refusal(
      policy,
      'ALREADY_CONFIGURED',
      `This server already has MainWP credentials loaded, so setup will not replace them from chat. If the connection is not working, call ${SETUP_STATUS_TOOL} to retry with the credentials it already has. To change the credentials, edit ${trustedSettingsPath()} (or the "env" block of this server's entry in your MCP client config) and restart the client.`
    );
  }

  const envVars = activeConnectionEnvVars();
  if (envVars.length > 0) {
    // Env outranks the file this tool writes, so persisting here would validate
    // one identity and silently activate another later.
    return refusal(
      policy,
      'ENV_CONFIGURED',
      `This server reads its connection settings from environment variables (${envVars.join(', ')}), which take precedence over the file this tool writes. Finish setup in the "env" block of this server's entry in your MCP client config, then restart the client.`
    );
  }

  const cwdSettings = path.join(process.cwd(), 'settings.json');
  if (fs.existsSync(cwdSettings)) {
    // The loader stops at the first file it finds, so this one would shadow the
    // home file forever and the save would be a lie.
    return refusal(
      policy,
      'SHADOWED_BY_WORKING_DIRECTORY_FILE',
      `A settings.json in the server's working directory (${cwdSettings}) is loaded before ${trustedSettingsPath()}, so anything saved here would be ignored. Complete the connection settings in that file, or remove it, then restart the client.`
    );
  }

  let dashboardUrl: string;
  let username: string;
  let appPassword: string;
  try {
    dashboardUrl = validateConfigureUrl(args.dashboard_url, policy.allowHttp);
    username = validateCredentialField(args.username, 'username', MAX_USERNAME_INPUT);
    appPassword = validateApplicationPassword(args.application_password);
  } catch (error) {
    return refusal(policy, 'INVALID_INPUT', sanitizeError(getErrorMessage(error)));
  }

  // Request-scoped: exact by value, no length floor, and never added to the
  // global registry. A password this call refuses is scrubbed from this call's
  // output and then forgotten, which the global registry cannot do — it keeps
  // every value it is given for the life of the process, and it ignores values
  // under its length floor.
  const basicBlob = Buffer.from(`${username}:${appPassword}`).toString('base64');
  const submittedSecrets = [appPasswordSecret(appPassword), basicBlob];
  const redactSubmitted = createSecretRedactor(submittedSecrets);

  // Asked before the credential is transmitted, because registration is earned
  // only after the save and the request cannot be recalled. A full registry
  // means this process could never scrub the value from its own output, so it
  // must not adopt it.
  if (!canRegisterKnownSecrets(submittedSecrets)) {
    return refusal(
      policy,
      'REDACTION_UNAVAILABLE',
      `This server can no longer protect a new credential in its own output, so setup stopped before contacting the Dashboard. Nothing was sent and nothing was saved. Restart the MCP client and try again, or put the credentials in the "env" block of this server's entry in your MCP client config.`,
      redactSubmitted
    );
  }

  if (!state.beginOperation()) {
    return refusal(
      policy,
      'CONFIGURE_IN_PROGRESS',
      'Another setup attempt is still running. Wait for it to finish before trying again.',
      redactSubmitted
    );
  }

  try {
    // Exactly the submitted tuple: never merged with stored or environment
    // values, so validation and persistence describe the same identity.
    const candidate: Config = {
      ...policy,
      dashboardUrl,
      authType: 'basic',
      username,
      appPassword,
      configSource: 'settings file',
    };

    let abilities: Ability[];
    try {
      // The submitted tuple has not earned registration yet, so the fetch runs
      // under a request-scoped secret context and a logger that scrubs the
      // same values. Without both, a Dashboard that reflects the password in
      // an ability name, a schema key, or a label writes it straight to a log
      // line and into the cached catalog, and the global registry is not
      // allowed to know the value until a call persists it.
      abilities = await withScopedSecrets(submittedSecrets, () =>
        validateCredentials(candidate, withSecretRedaction(logger, redactSubmitted))
      );
    } catch (error) {
      // Scrub before sanitizeError, not after: sanitizeError truncates, and a
      // reflected password straddling that cut must be removed whole.
      return refusal(
        policy,
        'CONNECTION_FAILED',
        `${sanitizeError(redactSubmitted(getErrorMessage(error)))} Nothing was saved. Check the values and try again, or set them up manually.`,
        redactSubmitted
      );
    }

    // Rechecked inside the mutex, on the same condition as the precondition
    // above: another path could have given the server a config while the
    // network call was in flight.
    if (state.retainedConfig !== null) {
      // Defense in depth: validateCredentials already filled the shared cache
      // slot from the submitted (model-supplied) origin. The slot is signature
      // guarded by dashboard URL plus auth identity, so the identity that won
      // the race would miss and refetch anyway; drop it so data fetched under a
      // rejected identity does not sit in a process-global slot.
      clearCache();
      return refusal(
        policy,
        'ALREADY_CONFIGURED',
        'This server was given credentials while the setup call was running. Nothing was saved.',
        redactSubmitted
      );
    }

    let savedPath: string;
    try {
      savedPath = writeConnectionSettings({ dashboardUrl, username, appPassword });
    } catch (error) {
      const detail = sanitizeError(
        redactSubmitted(
          error instanceof SettingsWriteError ? error.message : getErrorMessage(error)
        )
      );
      return refusal(
        policy,
        'SAVE_FAILED',
        `${detail} The connection itself worked, so adding the same values to the "env" block of this server's entry in your MCP client config will get you running.`,
        redactSubmitted
      );
    }

    // The tuple is now this server's own identity, so it joins the registry
    // that startup credentials use and every later output is scrubbed by
    // value. Only a call that persisted gets to grow that registry.
    if (!registerKnownSecrets(submittedSecrets)) {
      // The capacity check before the fetch passed, so the registry filled
      // while this call was in flight. The credentials are already saved and
      // working; the operator needs to know this process can no longer scrub
      // all of them from its output.
      logger.warning(
        "The secret-redaction registry is full, so the saved credentials are only partly protected in this server's output. Restart the MCP client."
      );
    }
    // The validation fetch normalized the catalog before that registration, so
    // a Dashboard that reflected the password back in an ability label still
    // has it sitting in the cache. Drop it and let the next call refetch under
    // redaction; one extra fetch is cheaper than a leaked credential.
    clearCache();

    // One ordered swap: adopt the config, re-arm the rate limiter for its
    // settings, drop confirmation state and derived tools belonging to the old
    // identity, then tell the client every surface changed. Readiness is
    // visible from adopt() onward, so a client that re-lists as soon as the
    // notification lands sees the real tools.
    state.adopt(candidate);
    initRateLimiter(candidate.rateLimit);
    clearPendingPreviews();
    clearToolsCache();
    // The config is adopted and on disk by now, so a client that rejects the
    // notification does not make this a failed setup. clientRefreshNote in the
    // payload below already tells the user what to do if the list looks stale.
    await notifyQuietly(notify, logger);

    logger.info('Setup completed; server is connected', {
      dashboardHost: hostOf(dashboardUrl),
      abilitiesCount: abilities.length,
    });

    return setupResult(
      policy,
      {
        status: 'connected',
        dashboardHost: hostOf(dashboardUrl),
        abilitiesCount: abilities.length,
        message: `Connected to ${hostOf(dashboardUrl)}. ${abilities.length} MainWP tools are available now.`,
        savedTo: savedPath,
        storageNote:
          'The credentials were saved on this machine with owner-only permissions. Edit that file to change them later.',
        clientRefreshNote: CLIENT_REFRESH_NOTE,
      },
      false,
      redactSubmitted
    );
  } finally {
    state.endOperation();
  }
}

/**
 * Execute a setup tool. Callers must have established that the name is a
 * setup tool; policy is rechecked here because listing is not authorization.
 */
export async function executeSetupTool(
  state: ConfigState,
  name: string,
  args: Record<string, unknown>,
  logger: Logger,
  notify: SetupNotifier
): Promise<ToolCallResult> {
  if (decidePolicy(state.policy, name) !== 'allow') {
    throw McpErrorFactory.permissionDenied(`Tool is not allowed: ${name}`);
  }
  if (name === SETUP_STATUS_TOOL) {
    return handleSetupStatus(state, logger, notify);
  }
  if (name === CONFIGURE_TOOL) {
    return handleConfigure(state, args, logger, notify);
  }
  throw McpErrorFactory.toolNotFound(name);
}

/**
 * The refusal every non-setup surface returns while the server is not ready.
 * Never leaks whether a name exists in the Dashboard catalog.
 */
export function notReadyResult(state: ConfigState): ToolCallResult {
  const policy = state.policy;
  const chatSetupAvailable = decidePolicy(policy, CONFIGURE_TOOL) === 'allow';
  const statusToolAvailable = decidePolicy(policy, SETUP_STATUS_TOOL) === 'allow';
  const guidance =
    state.state === 'degraded'
      ? degradedGuidance(state.degradedReason ?? 'the connection check failed')
      : setupGuidance(chatSetupAvailable);
  return setupResult(
    policy,
    {
      status: 'not_configured',
      state: state.state,
      message: statusToolAvailable
        ? `The MainWP MCP server is not connected to a Dashboard yet, so its tools are unavailable. Call ${SETUP_STATUS_TOOL} for setup instructions.`
        : 'The MainWP MCP server is not connected to a Dashboard yet, so its tools are unavailable.',
      guidance,
    },
    true
  );
}
