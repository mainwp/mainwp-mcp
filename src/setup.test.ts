/**
 * First-run setup tests: URL validation of model-supplied values, the
 * configure preconditions that keep a persisted tuple from being shadowed,
 * and the guarantee that a submitted password never reaches an output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';
import type { Config, PolicyConfig } from './config.js';
import { clearCache, fetchAbilities } from './abilities.js';
import { clearKnownSecrets, sanitizeError } from './security.js';
import { trustedSettingsPath } from './settings-writer.js';
import {
  ConfigState,
  CONFIGURE_TOOL,
  executeSetupTool,
  getSetupTools,
  SETUP_STATUS_TOOL,
  validateConfigureUrl,
} from './setup.js';

const { initRateLimiterSpy } = vi.hoisted(() => ({ initRateLimiterSpy: vi.fn() }));

vi.mock('./abilities.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./abilities.js')>();
  return {
    ...actual,
    initRateLimiter: (requestsPerMinute: number) => {
      initRateLimiterSpy(requestsPerMinute);
      actual.initRateLimiter(requestsPerMinute);
    },
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const APP_PASSWORD = 'abcd efgh ijkl mnop qrst uvwx';
const BASIC_BLOB = Buffer.from(`admin:${APP_PASSWORD}`).toString('base64');

const CONFIGURE_ARGS = {
  dashboard_url: 'https://dashboard.example.com',
  username: 'admin',
  application_password: APP_PASSWORD,
};

const sampleAbility = {
  name: 'mainwp/list-sites-v1',
  label: 'List Sites',
  description: 'Get all managed sites',
  category: 'mainwp-sites',
  input_schema: { type: 'object', properties: {} },
  meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
};

function policyOf(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  const {
    dashboardUrl: _dashboardUrl,
    authType: _authType,
    username: _username,
    appPassword: _appPassword,
    apiToken: _apiToken,
    ...policy
  } = makeBaseConfig();
  return { ...policy, ...overrides };
}

function unconfiguredState(overrides: Partial<PolicyConfig> = {}): ConfigState {
  return ConfigState.fromResolution({
    status: 'unconfigured',
    missing: 'credentials',
    message: 'Authentication required',
    policy: policyOf(overrides),
  });
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

const noopNotify = async () => {};

describe('validateConfigureUrl', () => {
  it('normalizes an https URL and strips trailing slashes', () => {
    expect(validateConfigureUrl('https://dash.example.com/', false)).toBe(
      'https://dash.example.com'
    );
    expect(validateConfigureUrl('https://dash.example.com/wp/', false)).toBe(
      'https://dash.example.com/wp'
    );
  });

  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['an oversized value', `https://example.com/${'a'.repeat(600)}`],
    ['a value with surrounding spaces', ' https://dash.example.com '],
    ['a non-URL', 'dashboard.example.com'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['embedded credentials', 'https://user:pass@dash.example.com'],
    ['a query string', 'https://dash.example.com/?redirect=1'],
    ['a fragment', 'https://dash.example.com/#x'],
  ])('rejects %s', (_label, value) => {
    expect(() => validateConfigureUrl(value, false)).toThrow();
  });

  it('rejects http unless the operator already allowed it', () => {
    expect(() => validateConfigureUrl('http://dash.example.com', false)).toThrow(/https/);
    expect(validateConfigureUrl('http://dash.example.com', true)).toBe('http://dash.example.com');
  });
});

describe('setup tools', () => {
  it('lists both setup tools and honors the block list', () => {
    expect(getSetupTools(unconfiguredState()).map(tool => tool.name)).toEqual([
      SETUP_STATUS_TOOL,
      CONFIGURE_TOOL,
    ]);
    expect(
      getSetupTools(unconfiguredState({ blockedTools: [CONFIGURE_TOOL] })).map(tool => tool.name)
    ).toEqual([SETUP_STATUS_TOOL]);
  });

  it('annotates configure as consequential and open-world', () => {
    const configure = getSetupTools(unconfiguredState()).find(tool => tool.name === CONFIGURE_TOOL);
    expect(configure?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('refuses a blocked setup tool at execution, not only at listing', async () => {
    const state = unconfiguredState({ blockedTools: [CONFIGURE_TOOL] });

    await expect(
      executeSetupTool(state, CONFIGURE_TOOL, CONFIGURE_ARGS, makeMockLogger(), noopNotify)
    ).rejects.toMatchObject({ code: -32008 });
  });
});

describe('mainwp_configure preconditions', () => {
  const savedEnv = new Map<string, string | undefined>();
  let root: string;
  let home: string;
  let cwd: string;

  // Individual keys, never a wholesale `process.env = {...}` replacement: that
  // detaches the JS object from the real environment, and os.homedir() reads
  // the real one, so the writer would target the developer's own home.
  function setEnv(key: string, value: string | undefined): void {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearKnownSecrets();
    savedEnv.clear();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MAINWP_')) setEnv(key, undefined);
    }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-mcp-setup-'));
    home = path.join(root, 'home');
    cwd = path.join(root, 'cwd');
    fs.mkdirSync(home);
    fs.mkdirSync(cwd);
    setEnv('HOME', home);
    expect(os.homedir()).toBe(home);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    // A passing run still writes a real settings.json under this root; leaving
    // it behind litters the temp dir with credential-shaped files.
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses when connection environment variables are authoritative', async () => {
    setEnv('MAINWP_URL', 'https://env.example.com');
    const state = unconfiguredState();

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      noopNotify
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('ENV_CONFIGURED');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(false);
  });

  it('refuses when a working-directory settings file would shadow the write', async () => {
    fs.writeFileSync(path.join(cwd, 'settings.json'), '{}');
    const state = unconfiguredState();

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      noopNotify
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('SHADOWED_BY_WORKING_DIRECTORY_FILE');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(false);
  });

  it('refuses when the server is already connected', async () => {
    const state = ConfigState.fromConfig(makeBaseConfig());

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      noopNotify
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('ALREADY_CONFIGURED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses when the server has credentials that are only unreachable', async () => {
    // Degraded is not unconfigured: an operator's credentials are loaded and
    // the Dashboard was down. A chat tuple must not overwrite them, and the
    // refusal has to point at the credential-free retry.
    const state = ConfigState.fromConfig(makeBaseConfig());
    state.markDegraded('Network error: Cannot reach MAINWP_URL.');

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      noopNotify
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('ALREADY_CONFIGURED');
    expect(resultText(result)).toContain(SETUP_STATUS_TOOL);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(false);
    expect(state.retainedConfig).toMatchObject({ dashboardUrl: 'https://test.local' });
  });

  it('keeps no catalog from an identity that lost the readiness race', async () => {
    // The other ALREADY_CONFIGURED path: the recheck inside the mutex. By then
    // validateCredentials has already filled the shared cache slot from the
    // model-supplied origin, so the refusal must not leave that catalog
    // readable under the rejected candidate's signature.
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockFetch.mockImplementationOnce(async () => {
      await gate;
      return {
        ok: true,
        json: async () => [{ ...sampleAbility, label: 'Catalog from the rejected identity' }],
        headers: new Headers(),
      };
    });
    const state = unconfiguredState();

    // handleConfigure runs synchronously up to the validation fetch, so the
    // server can only be promoted here: after the early readiness check, while
    // the candidate's own fetch is in flight.
    const configure = executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      noopNotify
    );
    state.adopt(makeBaseConfig());
    release();
    const result = await configure;

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('ALREADY_CONFIGURED');

    // Read back under the refused candidate's own identity: a retained slot
    // would serve its catalog with no second request.
    const candidate: Config = {
      ...policyOf(),
      dashboardUrl: 'https://dashboard.example.com',
      authType: 'basic',
      username: 'admin',
      appPassword: APP_PASSWORD,
      configSource: 'settings file',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ ...sampleAbility, name: 'mainwp/get-site-v1' }],
      headers: new Headers(),
    });

    const served = await fetchAbilities(candidate, false, makeMockLogger());

    expect(served.map(ability => ability.name)).toEqual(['mainwp/get-site-v1']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a second call while one is in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockFetch.mockImplementation(async () => {
      await gate;
      return { ok: true, json: async () => [sampleAbility], headers: new Headers() };
    });
    const state = unconfiguredState();
    const logger = makeMockLogger();

    const first = executeSetupTool(state, CONFIGURE_TOOL, CONFIGURE_ARGS, logger, noopNotify);
    const second = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      logger,
      noopNotify
    );

    expect(second.isError).toBe(true);
    expect(resultText(second)).toContain('CONFIGURE_IN_PROGRESS');
    release();
    const firstResult = await first;
    expect(firstResult.isError).toBeUndefined();
  });

  it.each([
    ['a non-string password', { ...CONFIGURE_ARGS, application_password: 42 }],
    ['an oversized username', { ...CONFIGURE_ARGS, username: 'u'.repeat(500) }],
    ['an http URL', { ...CONFIGURE_ARGS, dashboard_url: 'http://dash.example.com' }],
  ])('rejects %s without contacting the Dashboard', async (_label, args) => {
    const state = unconfiguredState();

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      args,
      makeMockLogger(),
      noopNotify
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('INVALID_INPUT');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(false);
  });

  it('writes nothing when the Dashboard rejects the credentials', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"code":"rest_forbidden"}',
      headers: new Headers(),
    });
    const state = unconfiguredState();

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      noopNotify
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('CONNECTION_FAILED');
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(false);
    expect(state.state).toBe('unconfigured');
  });

  it('validates, persists, swaps state, and re-arms the rate limiter', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [sampleAbility],
      headers: new Headers(),
    });
    const notify = vi.fn(async () => {});
    const state = unconfiguredState({ rateLimit: 42 });

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      notify
    );

    expect(result.isError).toBeUndefined();
    expect(state.state).toBe('ready');
    expect(state.readyConfig).toMatchObject({
      dashboardUrl: 'https://dashboard.example.com',
      username: 'admin',
      appPassword: APP_PASSWORD,
      authType: 'basic',
    });
    expect(initRateLimiterSpy).toHaveBeenCalledWith(42);
    expect(resultText(result)).toContain(home);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(trustedSettingsPath(home), 'utf-8'))).toEqual({
      dashboardUrl: 'https://dashboard.example.com',
      username: 'admin',
      appPassword: APP_PASSWORD,
    });
    expect(fs.statSync(trustedSettingsPath(home)).mode & 0o777).toBe(0o600);
  });

  it('still reports success when the listChanged notification fails after the save', async () => {
    // The config is adopted and the credentials are on disk by then, so a
    // client that rejects the notification must not turn a completed setup
    // into an error the user has to act on.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [sampleAbility],
      headers: new Headers(),
    });
    const state = unconfiguredState();
    const notify = vi.fn(async () => {
      throw new Error('client transport closed');
    });

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      notify
    );

    expect(result.isError).toBeUndefined();
    expect(state.state).toBe('ready');
    const payload = JSON.parse(resultText(result)) as { status: string; savedTo: string };
    expect(payload.status).toBe('connected');
    expect(payload.savedTo).toBe(trustedSettingsPath(home));
    expect(resultText(result)).not.toContain('client transport closed');
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(true);
  });

  it('does not run the degraded retry while a configure holds the setup mutex', async () => {
    // Both paths write readiness, so they share one guard. Otherwise a retry
    // that started first can fail after the configure adopted a new identity
    // and mark that identity degraded over a connection it never tested.
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockFetch.mockImplementation(async () => {
      await gate;
      return { ok: true, json: async () => [sampleAbility], headers: new Headers() };
    });
    const state = unconfiguredState();
    const logger = makeMockLogger();

    const configure = executeSetupTool(state, CONFIGURE_TOOL, CONFIGURE_ARGS, logger, noopNotify);
    // Configure is refused outright once a config is loaded, so the two paths
    // can only overlap when the state becomes degraded while the configure's
    // validation fetch is still in flight.
    state.adopt(makeBaseConfig());
    state.markDegraded('Network error: Cannot reach MAINWP_URL.');
    const status = await executeSetupTool(state, SETUP_STATUS_TOOL, {}, logger, noopNotify);

    expect(resultText(status)).toContain('Another setup operation is already running');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    release();
    await configure;
  });

  it('does not register a refused password as a process-wide secret', async () => {
    // Registration is permanent and every entry is scanned by every later
    // redaction, so a call that never reaches the persist path must leave the
    // registry exactly as it found it.
    const refused = 'refused zzzz yyyy xxxx wwww vvvv';
    const state = ConfigState.fromConfig(makeBaseConfig());

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      { ...CONFIGURE_ARGS, application_password: refused },
      makeMockLogger(),
      noopNotify
    );

    expect(resultText(result)).toContain('ALREADY_CONFIGURED');
    expect(sanitizeError(`upstream echoed ${refused}`)).toContain(refused);
  });

  it.each([
    ['a password the failed call never registered', 'abcdefghijkl'],
    ['a password containing a JSON-escaped character', 'abcdefgh"ijkl'],
  ])('scrubs %s reflected in a Dashboard error body', async (_label, password) => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({ error: password }),
      headers: new Headers(),
    });
    const state = unconfiguredState();

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      { ...CONFIGURE_ARGS, application_password: password },
      makeMockLogger(),
      noopNotify
    );

    // Parsed, not raw: the raw result is itself JSON, so a JSON-escaped
    // password inside it is escaped twice and a check on the raw text would
    // pass without the value ever being removed.
    const payload = JSON.parse(resultText(result)) as { code: string; message: string };
    expect(payload.code).toBe('CONNECTION_FAILED');
    expect(payload.message).not.toContain(password);
    expect(payload.message).not.toContain(JSON.stringify(password));
  });

  it('refuses a password too short for the redaction registry to hold', async () => {
    // Saving a value the registry ignores would leave a credential this server
    // can never scrub from its own later output, and no Application Password
    // is that short.
    const state = unconfiguredState();

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      { ...CONFIGURE_ARGS, application_password: 'abc' },
      makeMockLogger(),
      noopNotify
    );

    const payload = JSON.parse(resultText(result)) as { code: string; message: string };
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.message).toContain('six groups of four characters');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(trustedSettingsPath(home))).toBe(false);
    expect(state.state).toBe('unconfigured');
  });

  it('still accepts an Application Password pasted with surrounding whitespace', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [sampleAbility],
      headers: new Headers(),
    });
    const state = unconfiguredState();

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      { ...CONFIGURE_ARGS, application_password: ` ${APP_PASSWORD} ` },
      makeMockLogger(),
      noopNotify
    );

    expect(result.isError).toBeUndefined();
    expect(state.readyConfig).toMatchObject({ appPassword: ` ${APP_PASSWORD} ` });
  });

  it('never logs the submitted password reflected in a successful catalog', async () => {
    // The password is not a registered secret while it is being validated, so
    // a Dashboard that reflects it in an ability name or a label is logged
    // through a sanitizer that has never seen the value.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        { ...sampleAbility, name: `mainwp/${APP_PASSWORD}` },
        {
          ...sampleAbility,
          label: `Sites ${APP_PASSWORD}`,
          description: `Managed by ${APP_PASSWORD}`,
        },
      ],
      headers: new Headers(),
    });
    const logger = makeMockLogger();

    const result = await executeSetupTool(
      unconfiguredState(),
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      logger,
      noopNotify
    );

    const logged = JSON.stringify(
      Object.values(logger).flatMap(method => (method as { mock: { calls: unknown[] } }).mock.calls)
    );
    expect(result.isError).toBeUndefined();
    expect(logged).not.toContain(APP_PASSWORD);
    expect(logged).not.toContain(BASIC_BLOB);
    expect(JSON.stringify(result)).not.toContain(APP_PASSWORD);
  });

  it('is already ready when the listChanged notification fires', async () => {
    // A client that re-lists the moment the notification lands must see the
    // real tools; if readiness were still gated on the configure mutex it
    // would get the setup tools and never be told again.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [sampleAbility],
      headers: new Headers(),
    });
    const state = unconfiguredState();
    const observed: Array<{ state: string; hasConfig: boolean }> = [];

    const result = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      makeMockLogger(),
      async () => {
        observed.push({ state: state.state, hasConfig: state.readyConfig !== null });
      }
    );

    expect(result.isError).toBeUndefined();
    expect(observed).toEqual([{ state: 'ready', hasConfig: true }]);
  });

  it('never echoes the submitted password, in any encoding, on success or failure', async () => {
    // Hostile echo: the Dashboard reflects the credentials it received. The
    // configure path registers them as known secrets before the request, so a
    // reflected value is scrubbed out of the result and the logs.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => `auth debug: ${APP_PASSWORD} / Authorization: Basic ${BASIC_BLOB}`,
      headers: new Headers(),
    });
    const logger = makeMockLogger();
    const state = unconfiguredState();

    const failure = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      logger,
      noopNotify
    );

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [sampleAbility],
      headers: new Headers(),
    });
    const success = await executeSetupTool(
      state,
      CONFIGURE_TOOL,
      CONFIGURE_ARGS,
      logger,
      noopNotify
    );

    const observed = [
      JSON.stringify(failure),
      JSON.stringify(success),
      JSON.stringify(
        Object.values(logger).flatMap(
          method => (method as { mock: { calls: unknown[] } }).mock.calls
        )
      ),
    ].join('\n');
    expect(failure.isError).toBe(true);
    expect(observed).not.toContain(APP_PASSWORD);
    expect(observed).not.toContain(BASIC_BLOB);
  });
});

describe('mainwp_get_setup_status', () => {
  it('returns both setup paths with the chat-history caveat when unconfigured', async () => {
    const result = await executeSetupTool(
      unconfiguredState(),
      SETUP_STATUS_TOOL,
      {},
      makeMockLogger(),
      noopNotify
    );

    const text = resultText(result);
    expect(text).toContain('Option 1 (recommended)');
    expect(text).toContain('Option 2');
    expect(text).toContain('conversation');
    expect(text).toContain('revoke');
  });

  it('offers only the manual path when configure is blocked by policy', async () => {
    const result = await executeSetupTool(
      unconfiguredState({ blockedTools: [CONFIGURE_TOOL] }),
      SETUP_STATUS_TOOL,
      {},
      makeMockLogger(),
      noopNotify
    );

    const text = resultText(result);
    expect(text).toContain('Option 1 (recommended)');
    expect(text).not.toContain('Option 2');
  });

  it('retries a degraded connection and promotes to ready on success', async () => {
    clearCache();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [sampleAbility],
      headers: new Headers(),
    });
    const state = ConfigState.fromConfig(makeBaseConfig());
    state.markDegraded('Network error: Cannot reach MAINWP_URL.');
    const notify = vi.fn(async () => {});

    const result = await executeSetupTool(state, SETUP_STATUS_TOOL, {}, makeMockLogger(), notify);

    expect(state.state).toBe('ready');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(resultText(result)).toContain('Connected to');
  });

  it('stays ready when the listChanged notification fails after a successful retry', async () => {
    // The notification is outside the validation catch: a client transport
    // failure must not undo a connection that just worked, or be reported to
    // the user as the Dashboard problem.
    clearCache();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [sampleAbility],
      headers: new Headers(),
    });
    const state = ConfigState.fromConfig(makeBaseConfig());
    state.markDegraded('Network error: Cannot reach MAINWP_URL.');
    const notify = vi.fn(async () => {
      throw new Error('client transport closed');
    });

    const result = await executeSetupTool(state, SETUP_STATUS_TOOL, {}, makeMockLogger(), notify);

    expect(state.state).toBe('ready');
    expect(resultText(result)).toContain('Connected to');
    expect(resultText(result)).not.toContain('client transport closed');
  });

  it('gives the manual fix for wrong credentials even when chat setup is blocked', async () => {
    // Blocked configure is exactly when the user has no other way out of a
    // wrong tuple, so the manual instructions cannot be conditional on it.
    clearCache();
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND test.local'));
    const state = ConfigState.fromConfig(makeBaseConfig({ blockedTools: [CONFIGURE_TOOL] }));
    state.markDegraded('Network error: Cannot reach MAINWP_URL.');

    const result = await executeSetupTool(
      state,
      SETUP_STATUS_TOOL,
      {},
      makeMockLogger(),
      noopNotify
    );

    expect(resultText(result)).toContain('If the credentials themselves are wrong');
  });

  it('stays degraded and reports the reason when the retry fails', async () => {
    clearCache();
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND test.local'));
    const state = ConfigState.fromConfig(makeBaseConfig());
    state.markDegraded('Network error: Cannot reach MAINWP_URL.');
    const notify = vi.fn(async () => {});

    const result = await executeSetupTool(state, SETUP_STATUS_TOOL, {}, makeMockLogger(), notify);

    expect(state.state).toBe('degraded');
    expect(notify).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('Network error');
  });
});
