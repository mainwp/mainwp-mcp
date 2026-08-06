import { parseToolJson } from '../lib/client.js';
import type { ScenarioDefinition } from './types.js';

const SETUP_TOOLS = ['mainwp_get_setup_status', 'mainwp_configure'];

interface SetupStatusPayload {
  state?: string;
  guidance?: string;
  relayInstructions?: string;
}

interface RefusalPayload {
  status?: string;
  code?: string;
  message?: string;
}

// Valid enough to pass input validation, so a refusal can only come from a
// precondition.
const SUBMITTED_PASSWORD = 'aaaa bbbb cccc dddd eeee ffff';

/**
 * Whole strings, never a prefix: a prefix comparison only catches an echo that
 * starts at the first character, so a reflected middle run passes it. The
 * compact form is checked too because WordPress removes every non-alphanumeric
 * before comparing, which makes it the same credential.
 */
function echoesPassword(data: unknown, password: string): boolean {
  const serialized = JSON.stringify(data);
  return [password, password.replace(/[^a-z\d]/gi, '')].some(
    form => form !== '' && serialized.includes(form)
  );
}

export const setupModeUnconfigured: ScenarioDefinition = {
  id: 'setup-mode-unconfigured',
  purpose: 'Start with no credentials at all and expose only the two setup tools.',
  kind: 'read',
  targets: ['live', 'fixture'],
  preconditions: () => ({ launch: { omitCredentialEnv: true } }),
  async run(ctx) {
    ctx.assert.equal(
      'unconfigured server still initializes',
      ctx.client.serverInfo?.name,
      'mainwp-mcp'
    );

    const tools = await ctx.client.listTools();
    ctx.assert.deepEqual(
      'only the setup tools are listed',
      tools.tools.map(tool => tool.name),
      SETUP_TOOLS
    );

    const resources = await ctx.client.listResources();
    ctx.assert.equal('no resources are listed', resources.resources.length, 0);
    const prompts = await ctx.client.listPrompts();
    ctx.assert.equal('no prompts are listed', prompts.prompts.length, 0);

    const { data } = await ctx.client.callToolJson('mainwp_get_setup_status');
    const status = data as SetupStatusPayload;
    ctx.assert.equal('setup status reports unconfigured', status.state, 'unconfigured');
    ctx.assert.truthy(
      'guidance leads with the manual option',
      status.guidance?.includes('Option 1 (recommended)')
    );
    ctx.assert.truthy(
      'guidance welcomes chat entry with the history caveat',
      status.guidance?.includes('Option 2') && status.guidance?.includes('conversation')
    );

    // Execution boundary: a Dashboard tool name from a previous session must
    // be refused, not resolved.
    const denied = await ctx.client.callTool('list_sites_v1', {});
    const deniedPayload = parseToolJson(denied) as RefusalPayload;
    ctx.assert.equal('hidden Dashboard tool call is an error', denied.isError, true);
    ctx.assert.equal(
      'hidden Dashboard tool call is refused',
      deniedPayload.status,
      'not_configured'
    );
  },
};

export const setupConfigureRefusals: ScenarioDefinition = {
  id: 'setup-configure-refusals',
  purpose:
    'Refuse chat-supplied configuration when env vars or a working-directory file outrank it.',
  kind: 'read',
  targets: ['live', 'fixture'],
  preconditions: ctx => ({
    launch: {
      omitCredentialEnv: true,
      // A URL with no credentials leaves the server unconfigured while making
      // the environment authoritative, and the settings file exists without
      // configuring anything, so it can only shadow. A configured URL is
      // validated even when credentials are missing, and the fixture Dashboard
      // is plain HTTP, so the operator-level opt-in has to be present.
      env: { MAINWP_URL: ctx.credentials.dashboardUrl, MAINWP_ALLOW_HTTP: 'true' },
      settings: { safeMode: false },
    },
  }),
  async run(ctx) {
    const { result, data } = await ctx.client.callToolJson('mainwp_configure', {
      dashboard_url: 'https://dashboard.invalid',
      username: 'admin',
      application_password: SUBMITTED_PASSWORD,
    });
    const payload = data as RefusalPayload;

    ctx.assert.equal('configure refusal is an error result', result.isError, true);
    // Exactly ENV_CONFIGURED: the environment precondition is checked before
    // the shadowing one, so accepting either code would let a regression in it
    // pass as long as the shadowing refusal still fires.
    ctx.assert.equal('the environment precondition refuses first', payload.code, 'ENV_CONFIGURED');
    ctx.assert.truthy(
      'refusal never echoes the submitted password',
      !echoesPassword(data, SUBMITTED_PASSWORD)
    );

    // The environment precondition is checked first, so the working-directory
    // file can only refuse on its own in a launch with no connection variables.
    // The home directory carries over from the launch above, which saved
    // nothing because it was refused.
    const shadowed = await ctx.relaunch({ env: {} });
    try {
      const second = await shadowed.client.callToolJson('mainwp_configure', {
        dashboard_url: 'https://dashboard.invalid',
        username: 'admin',
        application_password: SUBMITTED_PASSWORD,
      });
      const secondPayload = second.data as RefusalPayload;

      ctx.assert.equal('working-directory refusal is an error result', second.result.isError, true);
      ctx.assert.equal(
        'a working-directory settings.json refuses the save on its own',
        secondPayload.code,
        'SHADOWED_BY_WORKING_DIRECTORY_FILE'
      );
      ctx.assert.truthy(
        'working-directory refusal never echoes the submitted password',
        !echoesPassword(second.data, SUBMITTED_PASSWORD)
      );
    } finally {
      await shadowed.close();
    }
  },
};

export const setupConfigureRoundTrip: ScenarioDefinition = {
  id: 'setup-configure-roundtrip',
  purpose:
    'Configure an unconfigured server from tool input and keep it configured across a restart.',
  kind: 'read',
  targets: ['live', 'fixture'],
  preconditions: ctx => {
    // omitCredentialEnv means the tuple reaches the server only through the
    // configure call, so a missing value would be submitted as undefined and
    // the scenario would grade an input-validation refusal as a real result.
    if (!ctx.credentials.username || !ctx.credentials.appPassword) {
      return {
        status: 'unverified',
        reason: 'No username or application password was available to configure the server with.',
      };
    }
    return {
      launch: {
        omitCredentialEnv: true,
        // The fixture Dashboard is plain HTTP, so the operator-level opt-in has
        // to be present for the URL validator to accept it. It only permits
        // http, so an https live Dashboard is unaffected.
        env: { MAINWP_ALLOW_HTTP: 'true', MAINWP_RATE_LIMIT: '0' },
      },
      state: {
        dashboardUrl: ctx.credentials.dashboardUrl,
        username: ctx.credentials.username,
        appPassword: ctx.credentials.appPassword,
      },
    };
  },
  async run(ctx) {
    const before = await ctx.client.listTools();
    ctx.assert.deepEqual(
      'server starts in setup mode',
      before.tools.map(tool => tool.name),
      SETUP_TOOLS
    );

    const { result, data } = await ctx.client.callToolJson('mainwp_configure', {
      dashboard_url: ctx.state.dashboardUrl,
      username: ctx.state.username,
      application_password: ctx.state.appPassword,
    });
    ctx.assert.equal('configure succeeds', result.isError, undefined);
    ctx.assert.equal(
      'configure reports connected',
      (data as { status?: string }).status,
      'connected'
    );
    ctx.assert.truthy(
      'configure never echoes the password',
      !echoesPassword(data, String(ctx.state.appPassword))
    );

    const after = await ctx.client.listTools();
    const afterNames = after.tools.map(tool => tool.name);
    ctx.assert.truthy(
      'Dashboard tools appear after configure',
      afterNames.includes('list_sites_v1')
    );
    ctx.assert.truthy(
      'setup tools disappear after configure',
      !afterNames.some(name => SETUP_TOOLS.includes(name))
    );

    const listed = await ctx.client.callToolJson('list_sites_v1', { per_page: 100 });
    ctx.assert.equal(
      'a Dashboard tool works in the same session',
      listed.result.isError,
      undefined
    );
    ctx.assert.equal(
      'configured session sees the Dashboard sites',
      (listed.data as { total: number }).total,
      await ctx.verifier.countSites()
    );

    const restarted = await ctx.relaunch();
    try {
      const restartedTools = await restarted.client.listTools();
      const restartedNames = restartedTools.tools.map(tool => tool.name);
      ctx.assert.truthy(
        'a restarted server loads the saved credentials',
        restartedNames.includes('list_sites_v1')
      );
      ctx.assert.truthy(
        'a restarted server no longer offers setup tools',
        !restartedNames.some(name => SETUP_TOOLS.includes(name))
      );
      const restartedList = await restarted.client.callToolJson('list_sites_v1', { per_page: 100 });
      ctx.assert.equal(
        'the restarted server can call the Dashboard',
        restartedList.result.isError,
        undefined
      );
    } finally {
      await restarted.close();
    }
  },
};

export const setupScenarios = [
  setupModeUnconfigured,
  setupConfigureRefusals,
  setupConfigureRoundTrip,
];
