import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_APP_PASSWORD,
  FIXTURE_USERNAME,
  FIXTURE_ROUTED_ABILITIES,
  startFixtureDashboard,
  type FixtureDashboard,
} from './fixture-dashboard.js';
import { UPDATE_ABILITIES, makeUpdatePreview } from '../helpers/update-gate.js';
import { validateUpdatePlan } from '../../src/update-plan.js';
import { advertisedRoutesResolve } from './scenarios/ability-reads.js';
import { AssertionRecorder, type ScenarioContext } from './scenarios/types.js';
import { IndependentVerifier } from './lib/verify.js';

const authorization = `Basic ${Buffer.from(`${FIXTURE_USERNAME}:${FIXTURE_APP_PASSWORD}`).toString('base64')}`;

async function run(fixture: FixtureDashboard, ability: string, input: unknown, method = 'POST') {
  const url = new URL(
    `${fixture.url}/wp-json/wp-abilities/v1/abilities/${encodeURIComponent(ability)}/run`
  );
  if (method === 'DELETE' || method === 'GET') {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(`input[${key}][]`, String(entry));
      } else
        url.searchParams.set(
          `input[${key}]`,
          typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
        );
    }
  }
  const response = await fetch(url, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ input }) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('acceptance Dashboard 6.3 update fixture', () => {
  it.each(['mainwp_unignore_moved', 'rest_no_route'])(
    'route probe uses previews and accepts only the moved-path error: %s',
    async errorCode => {
      const verifier = new IndependentVerifier(
        {
          dashboardUrl: 'http://fixture.example.test',
          username: FIXTURE_USERNAME,
          appPassword: FIXTURE_APP_PASSWORD,
        },
        false
      );
      const site = { id: 1, url: 'https://alpine.example.test', name: 'Alpine Bakery' };
      vi.spyOn(verifier, 'fetchCatalog').mockResolvedValue(
        FIXTURE_ROUTED_ABILITIES.map(name => ({ name }))
      );
      vi.spyOn(verifier, 'listSites').mockResolvedValue([site]);
      const execute = vi.spyOn(verifier, 'execute').mockImplementation(async (name, input = {}) => {
        if (
          UPDATE_ABILITIES.some(ability => ability === name) ||
          name === 'mainwp/unignore-site-updates-v1'
        ) {
          if (input.dry_run !== true || input.confirm === true)
            throw new Error('mainwp_confirmation_required');
        }
        if (name === 'mainwp/set-ignored-updates-v1') {
          if (input.action !== 'unignore') throw new Error('mainwp_invalid_input');
          throw new Error(errorCode);
        }
        return name === 'mainwp/get-sites-basic-v1'
          ? { items: [site], total: 1, per_page: 100 }
          : {};
      });
      const assert = new AssertionRecorder();
      await advertisedRoutesResolve.run({ verifier, assert } as ScenarioContext);
      const resolved = assert.results.find(
        result =>
          result.name === 'every advertised routed ability resolves with an expected outcome'
      )!;
      expect(resolved.pass).toBe(errorCode === 'mainwp_unignore_moved');
      for (const ability of UPDATE_ABILITIES) {
        expect(execute).toHaveBeenCalledWith(
          ability,
          ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1]
            ? { site_ids_or_domains: [1], dry_run: true }
            : { site_id_or_domain: 1, dry_run: true }
        );
      }
      expect(execute).toHaveBeenCalledWith('mainwp/unignore-site-updates-v1', {
        site_id_or_domain: 1,
        type: 'plugin',
        slugs: ['hello.php'],
        dry_run: true,
      });
      expect(
        assert.results.filter(result => result.name !== resolved.name).every(result => result.pass)
      ).toBe(true);
      await verifier.close();
    }
  );

  it('overlays gated metadata without duplicate abilities or changing the frozen eval catalog', async () => {
    const fixture = await startFixtureDashboard();
    try {
      const response = await fetch(`${fixture.url}/wp-json/wp-abilities/v1/abilities`, {
        headers: { authorization },
      });
      const abilities = (await response.json()) as Array<{
        name: string;
        input_schema: { properties: Record<string, unknown> };
        meta: { annotations: { destructive: boolean; idempotent: boolean } };
      }>;
      expect(new Set(abilities.map(ability => ability.name)).size).toBe(abilities.length);
      for (const name of UPDATE_ABILITIES) {
        const ability = abilities.find(entry => entry.name === name)!;
        expect(ability.meta.annotations).toMatchObject({ destructive: true, idempotent: false });
        expect(ability.input_schema.properties).toMatchObject({
          dry_run: { type: 'boolean' },
          confirm: { type: 'boolean' },
        });
      }
      expect(
        abilities.find(ability => ability.name === 'mainwp/unignore-site-updates-v1')!.meta
          .annotations
      ).toMatchObject({ destructive: true, idempotent: true });
    } finally {
      await fixture.close();
    }
  });

  it.each(UPDATE_ABILITIES)(
    'routes %s with neither/both errors and a nonmutating preview',
    async ability => {
      const fixture = await startFixtureDashboard();
      try {
        const batch = ability === UPDATE_ABILITIES[0] || ability === UPDATE_ABILITIES[1];
        const args = batch ? { site_ids_or_domains: [1] } : { site_id_or_domain: 1 };
        expect(await run(fixture, ability, args)).toMatchObject({
          status: 400,
          body: { code: 'mainwp_confirmation_required', data: { status: 400 } },
        });
        expect(
          await run(fixture, ability, { ...args, dry_run: true, confirm: true })
        ).toMatchObject({ status: 400, body: { code: 'mainwp_invalid_input' } });
        const before = await run(
          fixture,
          'mainwp/get-site-updates-v1',
          { site_id_or_domain: 1 },
          'GET'
        );
        const preview = await run(fixture, ability, { ...args, dry_run: true });
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({ dry_run: true, errors: [] });
        expect(validateUpdatePlan(preview.body)).toBeDefined();
        expect(
          await run(fixture, 'mainwp/get-site-updates-v1', { site_id_or_domain: 1 }, 'GET')
        ).toEqual(before);
        const confirmed = await run(fixture, ability, { ...args, confirm: true });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body).toMatchObject({
          dry_run: false,
          errors: [],
          summary: { total_updated: preview.body.count },
        });
        const after = await run(
          fixture,
          'mainwp/get-site-updates-v1',
          { site_id_or_domain: 1 },
          'GET'
        );
        expect((after.body.updates as unknown[]).length).toBe(
          (before.body.updates as unknown[]).length - Number(preview.body.count)
        );
        fixture.reset();
        expect(
          await run(fixture, 'mainwp/get-site-updates-v1', { site_id_or_domain: 1 }, 'GET')
        ).toEqual(before);
      } finally {
        await fixture.close();
      }
    }
  );

  it('accepts null input for batch abilities and reports the Dashboard gate error', async () => {
    const fixture = await startFixtureDashboard();
    try {
      for (const ability of UPDATE_ABILITIES.slice(0, 2)) {
        expect(await run(fixture, ability, null)).toMatchObject({
          status: 400,
          body: { code: 'mainwp_confirmation_required' },
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it('keeps held updates pending, then previews and confirms hold removal over DELETE', async () => {
    const fixture = await startFixtureDashboard();
    const slug = 'akismet/akismet.php';
    const hold = { site_id_or_domain: 1, type: 'plugin', slug };
    const removal = { site_id_or_domain: 1, type: 'plugin', slugs: [slug, 'missing/missing.php'] };
    try {
      expect(
        (await run(fixture, 'mainwp/set-ignored-updates-v1', { ...hold, action: 'ignore' })).status
      ).toBe(200);
      expect(
        await run(fixture, 'mainwp/set-ignored-updates-v1', { ...hold, action: 'unignore' })
      ).toEqual({
        status: 400,
        body: {
          code: 'mainwp_unignore_moved',
          message:
            'Removing an item from the ignored list needs confirmation. Use mainwp/unignore-site-updates-v1.',
          data: { status: 400, replacement: 'mainwp/unignore-site-updates-v1' },
        },
      });
      const updateArgs = { site_id_or_domain: 1, dry_run: true };
      const heldPreview = await run(fixture, 'mainwp/update-site-plugins-v1', updateArgs);
      expect(heldPreview.body).toMatchObject({
        count: 0,
        would_affect: {
          summary: { site_count: 0, skipped_count: 1 },
          sites: [{ items: [], skipped: [{ slug, reason: 'ignored_site' }] }],
        },
      });
      const heldRun = await run(fixture, 'mainwp/update-site-plugins-v1', {
        site_id_or_domain: 1,
        confirm: true,
      });
      expect(heldRun.body).toMatchObject({ updated: [], summary: { total_skipped: 1 } });
      expect((await run(fixture, 'mainwp/update-site-plugins-v1', updateArgs)).body).toEqual(
        heldPreview.body
      );

      expect(
        (await run(fixture, 'mainwp/unignore-site-updates-v1', { ...removal, confirm: true }))
          .status
      ).toBe(405);
      expect(
        await run(fixture, 'mainwp/unignore-site-updates-v1', removal, 'DELETE')
      ).toMatchObject({ status: 400, body: { code: 'mainwp_confirmation_required' } });
      expect(
        await run(
          fixture,
          'mainwp/unignore-site-updates-v1',
          { ...removal, dry_run: true, confirm: true },
          'DELETE'
        )
      ).toMatchObject({ status: 400, body: { code: 'mainwp_invalid_input' } });
      const preview = await run(
        fixture,
        'mainwp/unignore-site-updates-v1',
        { ...removal, dry_run: true },
        'DELETE'
      );
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        dry_run: true,
        count: 1,
        would_affect: {
          holds: [
            { slug, held: true },
            { slug: 'missing/missing.php', held: false },
          ],
        },
      });
      expect(validateUpdatePlan(preview.body)).toBeUndefined();
      expect((await run(fixture, 'mainwp/update-site-plugins-v1', updateArgs)).body).toEqual(
        heldPreview.body
      );
      expect(
        await run(
          fixture,
          'mainwp/unignore-site-updates-v1',
          { ...removal, confirm: true, dry_run: false },
          'DELETE'
        )
      ).toEqual({
        status: 200,
        body: { dry_run: false, removed: [slug], not_held: ['missing/missing.php'], count: 1 },
      });
      expect((await run(fixture, 'mainwp/update-site-plugins-v1', updateArgs)).body).toMatchObject({
        count: 1,
        would_affect: { summary: { skipped_count: 0 } },
      });
      expect(
        (
          await run(fixture, 'mainwp/update-site-plugins-v1', {
            site_id_or_domain: 1,
            confirm: true,
          })
        ).body
      ).toMatchObject({ summary: { total_updated: 1 } });
      fixture.reset();
      expect((await run(fixture, 'mainwp/update-site-plugins-v1', updateArgs)).body).toMatchObject({
        count: 1,
      });
    } finally {
      await fixture.close();
    }
  });

  it('serves the multi-site batch envelope with complete grouped counts', async () => {
    const fixture = await startFixtureDashboard();
    try {
      const response = await run(fixture, 'mainwp/run-updates-v1', { dry_run: true });
      expect(response.status).toBe(200);
      const preview = response.body as ReturnType<typeof makeUpdatePreview>;
      expect(validateUpdatePlan(preview)).toBeDefined();
      expect(preview).toMatchObject({
        count: 4,
        would_affect: {
          summary: { all_sites: true, site_count: 2, has_core: true, item_count: 4 },
        },
      });
      expect(preview.would_affect.by_item.reduce((count, item) => count + item.site_count, 0)).toBe(
        4
      );
    } finally {
      await fixture.close();
    }
  });
});
