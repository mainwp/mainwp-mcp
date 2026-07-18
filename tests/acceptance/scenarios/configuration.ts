import type { ScenarioDefinition } from './types.js';

const REQUIRED_PACK_CHECKS = [
  'requiredFilesPresent',
  'forbiddenFilesAbsent',
  'installedEntryPresent',
  'mainwpBinPresent',
  'installedBinStartsServer',
  'installedVersionMatches',
] as const;

export const settingsFileConfig: ScenarioDefinition = {
  id: 'settings-file-config',
  purpose:
    'Load fake fixture credentials from an isolated consumer working-directory settings file.',
  kind: 'read',
  targets: ['fixture'],
  preconditions: ctx => ({
    launch: {
      omitCredentialEnv: true,
      settings: {
        dashboardUrl: ctx.credentials.dashboardUrl,
        username: ctx.credentials.username,
        appPassword: ctx.credentials.appPassword,
        allowHttp: true,
        rateLimit: 0,
      },
    },
  }),
  async run(ctx) {
    ctx.assert.equal(
      'settings-based initialization name',
      ctx.client.serverInfo?.name,
      'mainwp-mcp'
    );
    const { result, data } = await ctx.client.callToolJson('list_sites_v1', { per_page: 100 });
    ctx.assert.equal('settings-based list_sites succeeds', result.isError, undefined);
    ctx.assert.equal('settings-based fixture count', (data as { total: number }).total, 3);
  },
};

export const packedIntegrity: ScenarioDefinition = {
  id: 'packed-integrity',
  purpose: 'Surface tarball content, bin, entry-point, and installed-version assertions.',
  kind: 'read',
  targets: ['live', 'fixture'],
  preconditions: ctx =>
    ctx.mode === 'packed'
      ? {}
      : { status: 'skipped', reason: 'packed-integrity applies only to --mode packed.' },
  async run(ctx) {
    if (!ctx.packedPackage) throw new Error('Packed package metadata was unavailable');
    for (const name of REQUIRED_PACK_CHECKS) {
      ctx.assert.equal(`${name} check is present`, name in ctx.packedPackage.checks, true);
      ctx.assert.equal(name, ctx.packedPackage.checks[name], true);
    }
    ctx.assert.truthy('tarball sha256 recorded', /^[a-f0-9]{64}$/.test(ctx.packedPackage.sha256));
    ctx.assert.truthy('npm integrity recorded', ctx.packedPackage.integrity.startsWith('sha512-'));
  },
};

export const configurationScenarios = [settingsFileConfig, packedIntegrity];
