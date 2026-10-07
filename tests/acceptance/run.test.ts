import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFixtureDashboard } from './fixture-dashboard.js';
import { createArtifacts, type Artifacts } from './lib/artifacts.js';
import { extractBundle, type ExtractedBundle } from './lib/bundle.js';
import { packAndInstall } from './lib/pack.js';
import { launchServer, type ServerConnection } from './lib/server.js';
import { parseArgs, runAcceptance } from './run.js';
import type { ScenarioDefinition } from './scenarios/types.js';

const probes = vi.hoisted(() => ({ scenarios: [] as ScenarioDefinition[] }));

vi.mock('./lib/server.js', () => ({ launchServer: vi.fn() }));
vi.mock('./lib/artifacts.js', () => ({ createArtifacts: vi.fn() }));
vi.mock('./lib/bundle.js', () => ({ extractBundle: vi.fn() }));
vi.mock('./lib/pack.js', () => ({ packAndInstall: vi.fn() }));
vi.mock('./scenarios/index.js', () => ({ scenarios: probes.scenarios }));
// The real fixture runs; the wrapper only lets a test reach the instance the
// runner started.
vi.mock('./fixture-dashboard.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./fixture-dashboard.js')>();
  return { ...actual, startFixtureDashboard: vi.fn(actual.startFixtureDashboard) };
});

const seededSiteIds = (
  JSON.parse(fs.readFileSync(new URL('./fixtures/sites.json', import.meta.url), 'utf8')) as Array<{
    id: number;
  }>
).map(site => site.id);

probes.scenarios.push(
  {
    id: 'bundle-discovery-probe',
    purpose: 'Discover tools using the manifest launch configuration.',
    kind: 'read',
    targets: ['live'],
    run: async ctx => {
      ctx.assert.truthy('bundle tools are discovered', (await ctx.client.listTools()).tools.length);
    },
  },
  {
    id: 'fixture-mutating-probe',
    purpose: 'Delete the first fixture site, as fixture-confirmation-flow does.',
    kind: 'write',
    targets: ['fixture'],
    run: async ctx => {
      const [first] = await ctx.verifier.listSites();
      const response = (await ctx.verifier.execute('mainwp/delete-site-v1', {
        site_id_or_domain: first.id,
        confirm: true,
      })) as { deleted: boolean };
      ctx.assert.equal('probe deleted a fixture site', response.deleted, true);
    },
  },
  {
    id: 'fixture-seeded-state-probe',
    purpose: 'Read the fixture site table and compare it with the seed file.',
    kind: 'read',
    targets: ['fixture'],
    run: async ctx => {
      ctx.assert.deepEqual(
        'fixture site table matches the seed file',
        (await ctx.verifier.listSites()).map(site => site.id),
        seededSiteIds
      );
    },
  }
);

afterEach(() => vi.unstubAllEnvs());

function stubArtifacts(): Artifacts {
  return {
    runId: 'run-test',
    runDir: '/acceptance/run-test',
    manifest: { packageVersion: '0.0.0-test', startTime: new Date().toISOString() },
    writeJson: vi.fn(),
    write: vi.fn(),
    finish: vi.fn(),
  } as unknown as Artifacts;
}

describe('acceptance runner', () => {
  it('accepts bundle mode with a default or explicit archive', () => {
    expect(parseArgs(['--mode', 'bundle']).bundle).toMatch(/test-results\/mcpb\/mainwp-mcp\.mcpb$/);
    expect(parseArgs(['--mode', 'bundle', '--bundle', '/tmp/custom.mcpb'])).toMatchObject({
      mode: 'bundle',
      bundle: '/tmp/custom.mcpb',
    });
    expect(() => parseArgs(['--mode', 'packed', '--bundle', '/tmp/custom.mcpb'])).toThrow(
      '--bundle requires --mode bundle'
    );
  });

  it('launches the bundle configuration and records its hash, entry point and tool count', async () => {
    vi.stubEnv('MAINWP_URL', 'https://dashboard.example.com');
    vi.stubEnv('MAINWP_USER', 'test-user');
    vi.stubEnv('MAINWP_APP_PASSWORD', 'test-password');
    vi.stubEnv('MAINWP_ALLOW_HTTP', 'true');
    const artifacts = stubArtifacts();
    const bundle: ExtractedBundle = {
      filename: 'custom.mcpb',
      sha256: 'bundle-sha256',
      extractDir: '/extracted',
      launch: {
        entry: '/extracted/dist/index.js',
        command: 'manifest-node',
        args: ['/extracted/dist/index.js', '--manifest-argument'],
        env: { BUNDLE_USER: 'test-user' },
      },
      cleanup: vi.fn(),
    };
    vi.mocked(extractBundle).mockResolvedValue(bundle);
    vi.mocked(createArtifacts).mockResolvedValue(artifacts);
    vi.mocked(launchServer).mockResolvedValue({
      client: { listTools: async () => ({ tools: [{ name: 'bundle-tool' }] }) },
      cwd: '/acceptance/cwd',
      home: '/acceptance/home',
      close: async () => {},
    } as ServerConnection);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(
      await runAcceptance([
        '--mode',
        'bundle',
        '--bundle',
        '/tmp/custom.mcpb',
        '--scenario',
        'bundle-discovery-probe',
      ])
    ).toBe(0);
    const launch = vi.mocked(launchServer).mock.calls[0][0];
    expect(launch).toMatchObject({
      entry: bundle.launch.entry,
      command: bundle.launch.command,
      args: bundle.launch.args,
      env: bundle.launch.env,
    });
    expect(launch.env.MAINWP_ALLOW_HTTP).toBe('true');
    expect(launch.env).not.toHaveProperty('MAINWP_URL');
    expect(launch.env).not.toHaveProperty('MAINWP_USER');
    expect(launch.env).not.toHaveProperty('MAINWP_APP_PASSWORD');
    expect(packAndInstall).not.toHaveBeenCalled();
    expect(vi.mocked(artifacts.writeJson).mock.lastCall?.[1]).toMatchObject({
      mode: 'bundle',
      target: 'live',
      bundle: { filename: 'custom.mcpb', sha256: bundle.sha256, entryPoint: bundle.launch.entry },
      scenarios: [{ id: 'bundle-discovery-probe', status: 'passed', toolCount: 1 }],
    });
    expect(bundle.cleanup).toHaveBeenCalledOnce();
  });

  it('fails bundle mode when extraction fails without falling back to a packed or source entry', async () => {
    vi.stubEnv('MAINWP_URL', 'https://dashboard.example.com');
    vi.stubEnv('MAINWP_USER', 'test-user');
    vi.stubEnv('MAINWP_APP_PASSWORD', 'test-password');
    vi.mocked(createArtifacts).mockResolvedValue(stubArtifacts());
    vi.mocked(extractBundle).mockRejectedValue(new Error('bundle extraction failed'));
    await expect(runAcceptance(['--mode', 'bundle'])).rejects.toThrow('bundle extraction failed');
    expect(launchServer).not.toHaveBeenCalled();
    expect(packAndInstall).not.toHaveBeenCalled();
  });

  it('resets the fixture before each scenario', async () => {
    const artifacts = stubArtifacts();
    vi.mocked(createArtifacts).mockResolvedValue(artifacts);
    vi.mocked(launchServer).mockResolvedValue({
      client: {},
      cwd: '/acceptance/cwd',
      home: '/acceptance/home',
      close: async () => {},
    } as ServerConnection);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = await runAcceptance([
      '--target',
      'fixture',
      '--mode',
      'source',
      '--scenario',
      'fixture-mutating-probe',
      '--scenario',
      'fixture-seeded-state-probe',
    ]);

    // A skipped probe also exits 0, so the totals have to show both ran.
    expect(vi.mocked(artifacts.writeJson).mock.lastCall?.[1]).toMatchObject({
      totals: { passed: 2, failed: 0, skipped: 0, unverified: 0 },
    });
    expect(exitCode).toBe(0);
  });

  it('closes the fixture and surfaces the error when artifact setup fails', async () => {
    vi.mocked(createArtifacts).mockRejectedValue(new Error('artifact setup failed'));

    await expect(runAcceptance(['--target', 'fixture', '--mode', 'source'])).rejects.toThrow(
      'artifact setup failed'
    );

    const fixture = await vi.mocked(startFixtureDashboard).mock.results[0].value;
    // Closing a listener twice rejects, so this only passes when the runner
    // already closed it. A fixture left listening keeps the process alive.
    await expect(fixture.close()).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' });
  });
});
