import { describe, expect, it } from 'vitest';
import { buildUpdatePlanSummary, validateUpdatePlan } from './update-plan.js';

const caveat =
  'Versions are the ones pending now. If a newer version syncs before you confirm, the newer one is applied.';

function envelope() {
  const item = (
    type: string,
    slug: string,
    name: string,
    from: string,
    to: string,
    major: boolean | null
  ) => ({
    type,
    slug,
    name,
    from,
    to,
    requested: true,
    flags: { core: type === 'core', major },
  });
  const skipped = (name: string, reason: string) => ({
    type: 'plugin',
    slug: name.toLowerCase(),
    name,
    from: '1.0',
    to: '2.0',
    requested: true,
    reason,
  });
  const sites = [
    {
      site_id: 4,
      site_url: 'https://aichild4.example/',
      site_name: 'aichild4',
      items: [
        item('core', 'wordpress', 'WordPress', '6.7', '6.8', true),
        item('plugin', 'akismet', 'Akismet', '5.3', '5.4', false),
        item('plugin', 'woocommerce', 'WooCommerce', '9.9', '10.0', true),
        item('theme', 'twentytwentyfive', 'Twenty Twenty-Five', '1.1', '1.2', false),
      ],
      skipped: [skipped('Yoast SEO', 'ignored_site'), skipped('Jetpack', 'ignored_global')],
    },
    {
      site_id: 7,
      site_url: 'https://aichild7.example/',
      site_name: 'aichild7',
      items: [
        item('core', 'wordpress', 'WordPress', '6.7', '6.8', true),
        item('translation', 'default', 'WordPress core', '', '6.8.1', false),
        item('plugin', 'unknown', 'Unknown version', '', '1.0', null),
      ],
      skipped: [],
    },
    {
      site_id: 9,
      site_url: 'https://aichild9.example/',
      site_name: 'aichild9',
      items: [],
      skipped: [skipped('Contact Form 7', 'ignored_site_flag')],
    },
  ];
  const byItem = [
    {
      type: 'core',
      slug: 'wordpress',
      name: 'WordPress',
      to: ['6.8'],
      site_count: 2,
      flags: { core: true, major: true },
    },
    ...sites.flatMap(site =>
      site.items
        .filter(entry => entry.type !== 'core')
        .map(entry => ({
          type: entry.type,
          slug: entry.slug,
          name: entry.name,
          to: [entry.to],
          site_count: 1,
          flags: entry.flags,
        }))
    ),
  ];
  return {
    dry_run: true,
    would_affect: {
      sites,
      by_item: byItem,
      summary: {
        site_count: 2,
        item_count: 7,
        skipped_count: 3,
        all_sites: false,
        queued: false,
        truncated: false,
        has_core: true,
        has_major: true,
        has_unknown_version: true,
        requested_not_found: [],
      },
    },
    count: 7,
    warnings: ['Remote warning prose must not appear in plan_summary.\u202e'],
    errors: [
      {
        site_id: 10,
        site_url: '',
        type: 'site',
        slug: '',
        code: 'mainwp_site_offline',
        message: 'Site is offline.',
      },
    ],
  };
}

type Preview = ReturnType<typeof envelope>;

function summary(preview: unknown): string[] {
  const plan = validateUpdatePlan(preview);
  expect(plan).toBeDefined();
  return buildUpdatePlanSummary(plan!);
}

function replace(preview: unknown, path: readonly (string | number)[], value: unknown) {
  let parent = preview as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  parent[path[path.length - 1]] = value;
}

const site = ['would_affect', 'sites', 0] as const;
const item = [...site, 'items', 0] as const;
const skipped = [...site, 'skipped', 0] as const;
const grouped = ['would_affect', 'by_item', 0] as const;
const totals = ['would_affect', 'summary'] as const;

describe('update plan summaries', () => {
  it('renders updates, holds, major versions and core counts in order without warning prose', () => {
    const preview = envelope();
    const original = JSON.stringify(preview);
    expect(summary(preview)).toEqual([
      'aichild4: WordPress 6.7 → 6.8',
      'aichild4: Akismet 5.3 → 5.4',
      'aichild4: WooCommerce 9.9 → 10.0',
      'aichild4: Twenty Twenty-Five 1.1 → 1.2',
      'aichild7: WordPress 6.7 → 6.8',
      'aichild7: WordPress core translation → 6.8.1',
      'aichild7: Unknown version → 1.0',
      'Held back: Yoast SEO on aichild4 (ignored on this site)',
      'Held back: Jetpack on aichild4 (ignored globally)',
      'Held back: Contact Form 7 on aichild9 (site ignores all updates of that type)',
      'Major version: WordPress 6.7 → 6.8',
      'Major version: WooCommerce 9.9 → 10.0',
      'Major version: WordPress 6.7 → 6.8',
      'Core update on 2 sites',
      caveat,
    ]);
    expect(JSON.stringify(preview)).toBe(original);
  });

  it('uses the singular for a core update on one site', () => {
    const preview = envelope();
    preview.would_affect.sites.splice(1, 1);
    preview.would_affect.summary.truncated = true;
    preview.would_affect.by_item[0].site_count = 1;
    expect(summary(preview)).toContain('Core update on 1 site');
  });

  it('uses complete core aggregates and counts only visible sites with items when truncated', () => {
    const preview = envelope();
    preview.would_affect.sites.splice(1, 1);
    preview.would_affect.summary.truncated = true;
    const lines = summary(preview);
    expect(lines).toContain('Core update on 2 sites');
    expect(lines.slice(-2)).toEqual([
      'Partial site list: showing 1 of 2 sites with updates.',
      caveat,
    ]);
    expect(lines).not.toContain('aichild7: WordPress 6.7 → 6.8');
  });

  it('accepts an empty update plan', () => {
    const preview = envelope();
    preview.would_affect.sites = [];
    preview.would_affect.by_item = [];
    Object.assign(preview.would_affect.summary, {
      site_count: 0,
      item_count: 0,
      skipped_count: 0,
      has_core: false,
      has_major: false,
      has_unknown_version: false,
    });
    preview.count = 0;
    expect(summary(preview)).toEqual([caveat]);
  });

  it('keeps core and partial-list notices when a truncated summary reaches the line cap', () => {
    const preview = envelope();
    const entry = preview.would_affect.sites[0];
    entry.items = Array.from({ length: 60 }, () => ({ ...entry.items[1] }));
    entry.skipped = [];
    preview.would_affect.sites = [entry];
    Object.assign(preview.would_affect.summary, {
      site_count: 200,
      item_count: 1000,
      skipped_count: 500,
      truncated: true,
    });
    preview.count = 1000;
    const lines = summary(preview);
    expect(lines).toHaveLength(50);
    expect(lines.slice(-4)).toEqual([
      'Core update on 2 sites',
      'Partial site list: showing 1 of 200 sites with updates.',
      caveat,
      '+14 more',
    ]);
  });

  it.each([undefined, '', 'upstream-plan-token'])(
    'bounds output to 50 lines with preview_token=%s',
    token => {
      const preview = envelope();
      const entry = preview.would_affect.sites[0];
      entry.items = Array.from({ length: 60 }, (_, index) => ({
        ...entry.items[1],
        name: `Plugin ${index}`,
        slug: `plugin-${index}`,
      }));
      entry.skipped = [];
      preview.would_affect.sites = [entry];
      preview.would_affect.by_item = entry.items.map(value => ({
        type: value.type,
        slug: value.slug,
        name: value.name,
        to: [value.to],
        site_count: 1,
        flags: value.flags,
      }));
      Object.assign(preview.would_affect.summary, {
        site_count: 1,
        item_count: 60,
        skipped_count: 0,
        has_core: false,
        has_major: false,
      });
      preview.count = 60;
      if (token !== undefined) Object.assign(preview, { preview_token: token });
      const lines = summary(preview);
      expect(lines).toHaveLength(50);
      expect(lines[0]).toBe('aichild4: Plugin 0 5.3 → 5.4');
      expect(lines.at(-1)).toBe(token ? '+11 more' : '+12 more');
      if (token) expect(lines).not.toContain(caveat);
      else expect(lines.at(-2)).toBe(caveat);
    }
  );

  it('keeps exactly 50 lines without an overflow marker', () => {
    const preview = envelope();
    const entry = preview.would_affect.sites[0];
    entry.items = Array.from({ length: 49 }, () => ({ ...entry.items[1] }));
    entry.skipped = [];
    preview.would_affect.sites = [entry];
    preview.would_affect.by_item = [
      {
        type: 'plugin',
        slug: 'akismet',
        name: 'Akismet',
        to: ['5.4'],
        site_count: 1,
        flags: { core: false, major: false },
      },
    ];
    Object.assign(preview.would_affect.summary, {
      site_count: 1,
      item_count: 49,
      skipped_count: 0,
      has_core: false,
      has_major: false,
    });
    preview.count = 49;
    const lines = summary(preview);
    expect(lines).toHaveLength(50);
    expect(lines.at(-1)).toBe(caveat);
  });

  it('omits the version caveat only for a non-empty own string preview_token', () => {
    expect(summary({ ...envelope(), preview_token: 'locked-plan' }).at(-1)).toBe(
      'Core update on 2 sites'
    );
    expect(summary({ ...envelope(), preview_token: '' }).at(-1)).toBe(caveat);
    expect(
      summary(Object.assign(Object.create({ preview_token: 'inherited' }), envelope())).at(-1)
    ).toBe(caveat);
  });

  it.each(['item_count', 'site_count', 'skipped_count'])('rejects inconsistent %s', field => {
    const preview = envelope();
    replace(preview, [...totals, field], 20);
    if (field === 'item_count') preview.count = 20;
    expect(validateUpdatePlan(preview)).toBeUndefined();
  });

  // Core flags, has_core and by_item come from the complete plan, so they must agree with
  // each other; a truncated list only bounds them from below.
  it.each([
    [
      'an item core flag that disagrees with its type',
      (p: Preview) => {
        p.would_affect.sites[0].items[0].flags.core = false;
      },
    ],
    [
      'a core flag on a non-core item',
      (p: Preview) => {
        p.would_affect.sites[0].items[1].flags.core = true;
      },
    ],
    [
      'a grouped core flag that disagrees with its type',
      (p: Preview) => {
        p.would_affect.by_item[0].flags.core = false;
      },
    ],
    [
      'has_core false with core updates',
      (p: Preview) => {
        p.would_affect.summary.has_core = false;
      },
    ],
    [
      'has_core true without core updates',
      (p: Preview) => {
        for (const entry of p.would_affect.sites)
          entry.items = entry.items.filter(i => i.type !== 'core');
        p.would_affect.by_item.shift();
        p.would_affect.summary.item_count = 5;
        p.count = 5;
      },
    ],
    [
      'a core group count that disagrees with the visible core sites',
      (p: Preview) => {
        p.would_affect.by_item[0].site_count = 1;
      },
    ],
    [
      'a grouped site count of zero',
      (p: Preview) => {
        p.would_affect.by_item[1].site_count = 0;
      },
    ],
    [
      'a grouped site count above the plan site count',
      (p: Preview) => {
        p.would_affect.summary.truncated = true;
        p.would_affect.by_item[0].site_count = 999;
      },
    ],
    [
      'a truncated plan with fewer sites than shown',
      (p: Preview) => {
        p.would_affect.summary.truncated = true;
        p.would_affect.summary.site_count = 1;
      },
    ],
    [
      'a truncated plan with fewer items than shown',
      (p: Preview) => {
        p.would_affect.summary.truncated = true;
        p.would_affect.summary.item_count = 6;
        p.count = 6;
      },
    ],
    [
      'a truncated plan with fewer held items than shown',
      (p: Preview) => {
        p.would_affect.summary.truncated = true;
        p.would_affect.summary.skipped_count = 2;
      },
    ],
    [
      'a truncated plan with fewer core sites than shown',
      (p: Preview) => {
        p.would_affect.summary.truncated = true;
        p.would_affect.by_item[0].site_count = 1;
      },
    ],
  ] as const)('rejects %s', (_label, mutate) => {
    const preview = envelope();
    mutate(preview);
    expect(validateUpdatePlan(preview)).toBeUndefined();
  });

  // by_item has one group per type and slug counting distinct sites; a complete list must
  // reconcile with it exactly, a truncated one can only show less.
  it.each([
    [
      'a duplicate grouped item',
      (p: Preview) => {
        p.would_affect.by_item.push({ ...p.would_affect.by_item[1] });
      },
    ],
    [
      'a duplicate core group in a truncated plan',
      (p: Preview) => {
        p.would_affect.summary.truncated = true;
        p.would_affect.by_item.push({ ...p.would_affect.by_item[0] });
      },
    ],
    [
      'a group whose site count disagrees with a complete list',
      (p: Preview) => {
        p.would_affect.sites[0].items.splice(1, 1);
        p.would_affect.summary.item_count = 6;
        p.count = 6;
      },
    ],
    [
      'a group with no listed item in a complete list',
      (p: Preview) => {
        p.would_affect.by_item.push({ ...p.would_affect.by_item[1], slug: 'not-listed' });
      },
    ],
    [
      'a listed item without a group',
      (p: Preview) => {
        p.would_affect.by_item.splice(1, 1);
      },
    ],
    [
      'a listed item without a group in a truncated plan',
      (p: Preview) => {
        p.would_affect.summary.truncated = true;
        p.would_affect.by_item.splice(1, 1);
      },
    ],
    [
      'a truncated group counting fewer sites than it lists',
      (p: Preview) => {
        p.would_affect.summary.truncated = true;
        p.would_affect.sites[1].items.push({ ...p.would_affect.sites[0].items[1] });
        p.would_affect.summary.item_count = 8;
        p.count = 8;
      },
    ],
    [
      'a site listed twice',
      (p: Preview) => {
        p.would_affect.sites[1].site_id = 4;
      },
    ],
    [
      'a truncated plan with groups but no items',
      (p: Preview) => {
        p.would_affect.sites = [];
        Object.assign(p.would_affect.summary, { truncated: true, item_count: 0, skipped_count: 0 });
        p.count = 0;
      },
    ],
    [
      'a truncated plan with more group-site pairs than items',
      (p: Preview) => {
        p.would_affect.sites = [];
        Object.assign(p.would_affect.summary, { truncated: true, item_count: 6, skipped_count: 0 });
        p.count = 6;
      },
    ],
    [
      'a truncated plan with items but no groups',
      (p: Preview) => {
        p.would_affect.sites = [];
        p.would_affect.by_item = [];
        Object.assign(p.would_affect.summary, {
          truncated: true,
          skipped_count: 0,
          has_core: false,
        });
      },
    ],
    [
      'an item with a blank name and slug',
      (p: Preview) => {
        Object.assign(p.would_affect.sites[0].items[1], { name: '  ', slug: ' ' });
        Object.assign(p.would_affect.by_item[1], { slug: ' ' });
      },
    ],
  ] as const)('rejects %s', (_label, mutate) => {
    const preview = envelope();
    mutate(preview);
    expect(validateUpdatePlan(preview)).toBeUndefined();
  });

  it('accepts one translation slug listed twice on a site as one grouped site', () => {
    const preview = envelope();
    const translation = preview.would_affect.sites[1].items[1];
    preview.would_affect.sites[1].items.push({ ...translation, to: '6.8.2' });
    preview.would_affect.summary.item_count = 8;
    preview.count = 8;
    expect(summary(preview)).toContain('aichild7: WordPress core translation → 6.8.2');
  });

  it('falls back to the site ID and slug when names are blank', () => {
    const preview = envelope();
    preview.would_affect.sites[0].site_name = '   ';
    preview.would_affect.sites[0].items[1].name = ' ';
    const lines = summary(preview);
    expect(lines).toContain('Site 4: akismet 5.3 → 5.4');
    expect(lines).toContain('Held back: Yoast SEO on Site 4 (ignored on this site)');
  });

  it('accepts complete aggregates above the visible counts when truncated', () => {
    const preview = envelope();
    Object.assign(preview.would_affect.summary, {
      truncated: true,
      site_count: 40,
      item_count: 90,
      skipped_count: 12,
    });
    preview.count = 90;
    preview.would_affect.by_item[0].site_count = 30;
    expect(summary(preview)).toContain('Core update on 30 sites');
  });

  it('rejects count disagreement even when the site list is truncated', () => {
    const preview = envelope();
    preview.count++;
    preview.would_affect.summary.truncated = true;
    expect(validateUpdatePlan(preview)).toBeUndefined();
  });

  const textPaths = [
    [...site, 'site_name'],
    ...['name', 'slug', 'from', 'to'].map(field => [...item, field]),
    ...['name', 'slug'].map(field => [...skipped, field]),
    ...['name', 'slug'].map(field => [...grouped, field]),
    [...grouped, 'to', 0],
  ];
  const badText: unknown[] = [
    null,
    false,
    3,
    [],
    {},
    'x'.repeat(81),
    'bad\u0000',
    'bad\n',
    'bad\t',
    'bad\u007f',
    'bad\u0085',
    'bad\u202e',
    'bad\u2066',
    'bad\u200b',
    'bad\u200d',
    'bad\uFEFF',
    'bad\u2028',
    'bad\u2029',
  ];
  it.each(textPaths.flatMap(path => badText.map(value => ({ path, value }))))(
    'rejects unsafe display text at $path: $value',
    ({ path, value }) => {
      const preview = envelope();
      replace(preview, path, value);
      expect(validateUpdatePlan(preview)).toBeUndefined();
    }
  );

  it('accepts 80-character names and ordinary Unicode spacing', () => {
    const preview = envelope();
    preview.would_affect.sites[0].items[0].name = 'x'.repeat(80);
    preview.would_affect.sites[0].site_name = ' Site\u00a0  four ';
    expect(summary(preview)[0]).toBe(` Site\u00a0  four : ${'x'.repeat(80)} 6.7 → 6.8`);
  });

  const objectPaths = [
    ['would_affect'],
    totals,
    site,
    item,
    [...item, 'flags'],
    skipped,
    grouped,
    [...grouped, 'flags'],
    ['errors', 0],
  ];
  it.each(objectPaths.flatMap(path => [null, []].map(value => ({ path, value }))))(
    'rejects a non-object at $path: $value',
    ({ path, value }) => {
      const preview = envelope();
      replace(preview, path, value);
      expect(validateUpdatePlan(preview)).toBeUndefined();
    }
  );

  it.each([
    { path: ['dry_run'], value: false },
    { path: ['count'], value: '7' },
    { path: [...totals, 'item_count'], value: -1 },
    { path: [...totals, 'site_count'], value: 1.5 },
    { path: [...totals, 'skipped_count'], value: Number.MAX_SAFE_INTEGER + 1 },
    ...['all_sites', 'queued', 'truncated', 'has_core', 'has_major', 'has_unknown_version'].map(
      field => ({ path: [...totals, field], value: 'true' })
    ),
    { path: [...site, 'items'], value: {} },
    { path: [...site, 'skipped'], value: null },
    { path: [...site, 'site_id'], value: '4' },
    { path: [...site, 'site_url'], value: false },
    { path: [...item, 'flags', 'core'], value: 1 },
    { path: [...item, 'flags', 'major'], value: 'true' },
    { path: [...item, 'requested'], value: 1 },
    { path: [...item, 'type'], value: '__proto__' },
    { path: [...item, 'type'], value: 'constructor' },
    { path: [...skipped, 'reason'], value: '__proto__' },
    { path: [...skipped, 'reason'], value: 'constructor' },
    { path: [...grouped, 'site_count'], value: '2' },
    { path: ['would_affect', 'by_item'], value: {} },
    { path: ['warnings'], value: [1] },
    { path: ['errors'], value: [null] },
    { path: ['errors', 0, 'message'], value: [] },
    { path: [...totals, 'requested_not_found'], value: [false] },
    { path: ['preview_token'], value: 42 },
  ])('rejects field type errors at $path: $value', ({ path, value }) => {
    const preview = envelope();
    replace(preview, path, value);
    expect(validateUpdatePlan(preview)).toBeUndefined();
  });

  it.each([null, [], 'preview', 0, false])('rejects a non-object envelope: %s', preview => {
    expect(validateUpdatePlan(preview)).toBeUndefined();
  });

  it('ignores own __proto__ and constructor extras without reading their values', () => {
    const preview = envelope();
    for (const object of [
      preview,
      preview.would_affect,
      preview.would_affect.summary,
      preview.would_affect.sites[0],
      preview.would_affect.sites[0].items[0],
    ]) {
      for (const key of ['__proto__', 'constructor'])
        Object.defineProperty(object, key, {
          enumerable: true,
          get: () => {
            throw new Error('Extra property was read');
          },
        });
    }
    expect(summary(preview)).toEqual(summary(envelope()));
    const jsonExtras = JSON.parse(
      JSON.stringify(envelope()).replace(
        '"dry_run":true',
        '"dry_run":true,"__proto__":{"dry_run":false},"constructor":null'
      )
    );
    expect(summary(jsonExtras)).toEqual(summary(envelope()));
  });

  it('treats constructor and __proto__ labels as bounded strings', () => {
    const preview = envelope();
    preview.would_affect.sites[0].site_name = '__proto__';
    preview.would_affect.sites[0].items[1].name = 'constructor';
    expect(summary(preview)).toContain('__proto__: constructor 5.3 → 5.4');
  });

  it.each([
    ['dry_run'],
    totals,
    [...site, 'site_name'],
    [...item, 'name'],
    [...item, 'flags', 'major'],
  ])('rejects inherited required fields at %s', (...path) => {
    const preview = envelope();
    let parent = preview as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    const key = path.at(-1)!;
    const value = parent[key];
    delete parent[key];
    Object.setPrototypeOf(parent, { [key]: value });
    expect(validateUpdatePlan(preview)).toBeUndefined();
  });

  it('rejects inherited array entries', () => {
    const preview = envelope();
    const sites = preview.would_affect.sites;
    const first = sites[0];
    delete sites[0];
    Object.setPrototypeOf(sites, { 0: first });
    expect(validateUpdatePlan(preview)).toBeUndefined();
  });

  it('accepts required fields on null-prototype objects', () => {
    const preview = JSON.parse(JSON.stringify(envelope()), (_key, value) => {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.assign(Object.create(null), value)
        : value;
    });
    expect(summary(preview)).toEqual(summary(envelope()));
  });

  it('rejects the unignore preview envelope', () => {
    expect(
      validateUpdatePlan({
        dry_run: true,
        would_affect: {
          site_id: 4,
          site_url: 'https://aichild4.example/',
          site_name: 'aichild4',
          holds: [
            {
              type: 'plugin',
              slug: 'akismet',
              name: 'Akismet',
              held: true,
              still_held_by: null,
              pending: { from: '5.3', to: '5.4' },
            },
          ],
        },
        count: 1,
        warnings: [],
        errors: [],
      })
    ).toBeUndefined();
  });
});
