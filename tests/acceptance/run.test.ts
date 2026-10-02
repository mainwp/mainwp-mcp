import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { startFixtureDashboard } from './fixture-dashboard.js';
import { createArtifacts, type Artifacts } from './lib/artifacts.js';
import { launchServer, type ServerConnection } from './lib/server.js';
import { runAcceptance } from './run.js';
import type { ScenarioDefinition } from './scenarios/types.js';

const probes = vi.hoisted(() => ({ scenarios: [] as ScenarioDefinition[] }));

vi.mock('./lib/server.js', () => ({ launchServer: vi.fn() }));
vi.mock('./lib/artifacts.js', () => ({ createArtifacts: vi.fn() }));
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
