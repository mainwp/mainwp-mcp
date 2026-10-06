import type { Ability } from '../../src/abilities.js';

// Mirrors the Dashboard 6.3 update abilities (class-mainwp-abilities-updates.php): registration and preview schemas.
export const UPDATE_ABILITIES = [
  'mainwp/run-updates-v1',
  'mainwp/update-all-v1',
  'mainwp/update-site-core-v1',
  'mainwp/update-site-plugins-v1',
  'mainwp/update-site-themes-v1',
  'mainwp/update-site-translations-v1',
] as const;

export type UpdateType = 'core' | 'plugin' | 'theme' | 'translation';
export interface PlanItem {
  type: UpdateType;
  slug: string;
  name: string;
  from: string;
  to: string;
  requested: boolean;
  flags: { core: boolean; major: boolean | null };
}
export interface PlanSite {
  site_id: number;
  site_url: string;
  site_name: string;
  items: PlanItem[];
  skipped: Array<Omit<PlanItem, 'flags'> & { reason: 'ignored_site' }>;
}

export function makeDashboard63Abilities(): Ability[] {
  const identifier = { type: ['integer', 'string'] };
  const strings = { type: 'array', items: { type: 'string' } };
  const gates = {
    dry_run: { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false },
  };
  const ability = (
    name: string,
    properties: Record<string, unknown>,
    required: string[],
    destructive: boolean,
    idempotent: boolean,
    nullable = false
  ): Ability => ({
    name,
    label: name.slice('mainwp/'.length),
    description: 'Dashboard update ability fixture',
    category: 'mainwp-updates',
    input_schema: {
      type: nullable ? ['object', 'null'] : 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    meta: { annotations: { readonly: false, destructive, idempotent } },
  });
  return [
    ...UPDATE_ABILITIES.map(name => {
      const batch = name === UPDATE_ABILITIES[0] || name === UPDATE_ABILITIES[1];
      return ability(
        name,
        {
          ...(batch
            ? {
                site_ids_or_domains: { type: 'array', items: identifier, default: [] },
                types: {
                  ...strings,
                  items: { type: 'string', enum: ['core', 'plugins', 'themes', 'translations'] },
                  default: [],
                },
                ...(name === UPDATE_ABILITIES[0] ? { specific_items: strings } : {}),
              }
            : {
                site_id_or_domain: identifier,
                ...(name === 'mainwp/update-site-core-v1' ? {} : { slugs: strings }),
              }),
          ...gates,
        },
        batch ? [] : ['site_id_or_domain'],
        true,
        false,
        batch
      );
    }),
    ability(
      'mainwp/unignore-site-updates-v1',
      {
        site_id_or_domain: identifier,
        type: { type: 'string', enum: ['core', 'plugin', 'theme'] },
        slugs: { ...strings, minItems: 1 },
        ...gates,
      },
      ['site_id_or_domain', 'type'],
      true,
      true
    ),
    ability(
      'mainwp/set-ignored-updates-v1',
      {
        site_id_or_domain: identifier,
        action: { type: 'string', enum: ['ignore', 'unignore'] },
        type: { type: 'string', enum: ['core', 'plugin', 'theme'] },
        slug: { type: 'string' },
      },
      ['action', 'site_id_or_domain', 'type', 'slug'],
      false,
      true
    ),
  ];
}

export function makeOldDashboardAbilities(): Ability[] {
  return makeDashboard63Abilities()
    .filter(ability => UPDATE_ABILITIES.some(name => name === ability.name))
    .map(ability => {
      const properties = ability.input_schema!.properties as Record<string, unknown>;
      delete properties.dry_run;
      delete properties.confirm;
      ability.meta!.annotations!.destructive = false;
      return ability;
    });
}

export function makePlanItem(
  type: UpdateType,
  slug: string,
  name: string,
  from: string,
  to: string,
  requested = false
): PlanItem {
  const oldVersion = from.match(/^\d+/)?.[0];
  const newVersion = to.match(/^\d+/)?.[0];
  const major =
    type === 'translation'
      ? false
      : oldVersion === undefined || newVersion === undefined
        ? null
        : oldVersion !== newVersion || (type === 'core' && from.split('.')[1] !== to.split('.')[1]);
  return { type, slug, name, from, to, requested, flags: { core: type === 'core', major } };
}

export function makePlanSites(): PlanSite[] {
  const held = makePlanItem('plugin', 'wordpress-seo/wp-seo.php', 'Yoast SEO', '25.9', '26.0');
  const { flags: _flags, ...heldFields } = held;
  return [
    {
      site_id: 1,
      site_url: 'https://alpine.example.test',
      site_name: 'Alpine Bakery',
      items: [
        makePlanItem('core', 'wordpress', 'WordPress', '6.8.1', '6.9'),
        makePlanItem('plugin', 'akismet/akismet.php', 'Akismet', '5.3.6', '5.3.7'),
        makePlanItem('theme', 'bakehouse', 'Bakehouse', '2.4.0', '2.5.0'),
        makePlanItem('translation', 'akismet-fr_FR', 'Akismet', '', '5.3.7'),
      ],
      skipped: [{ ...heldFields, reason: 'ignored_site' }],
    },
    {
      site_id: 2,
      site_url: 'https://beacon.example.test',
      site_name: 'Beacon Studio',
      items: [makePlanItem('plugin', 'akismet/akismet.php', 'Akismet', '5.3.5', '5.3.7')],
      skipped: [],
    },
    {
      site_id: 3,
      site_url: 'https://cedar.example.test',
      site_name: 'Cedar Nonprofit',
      items: [],
      skipped: [{ ...heldFields, reason: 'ignored_site' }],
    },
  ];
}

export function makeUpdatePreview(
  sites = makePlanSites(),
  allSites = false,
  requested: string[] = []
) {
  const items = sites.flatMap(site => site.items);
  const grouped = new Map<
    string,
    {
      type: UpdateType;
      slug: string;
      name: string;
      to: string[];
      site_count: number;
      flags: PlanItem['flags'];
    }
  >();
  for (const item of items) {
    const key = `${item.type}:${item.slug}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.site_count++;
      if (!existing.to.includes(item.to)) existing.to.push(item.to);
      if (item.flags.major === true) existing.flags.major = true;
      else if (item.flags.major === null && existing.flags.major !== true)
        existing.flags.major = null;
    } else {
      grouped.set(key, {
        type: item.type,
        slug: item.slug,
        name: item.name,
        to: [item.to],
        site_count: 1,
        flags: { ...item.flags },
      });
    }
  }
  const found = sites.flatMap(site => [...site.items, ...site.skipped].map(item => item.slug));
  return {
    dry_run: true,
    would_affect: {
      sites: sites.filter(site => site.items.length || site.skipped.length),
      by_item: [...grouped.values()],
      summary: {
        site_count: sites.filter(site => site.items.length).length,
        item_count: items.length,
        skipped_count: sites.reduce((total, site) => total + site.skipped.length, 0),
        all_sites: allSites,
        queued: false,
        truncated: false,
        has_core: items.some(item => item.flags.core),
        has_major: items.some(item => item.flags.major === true),
        has_unknown_version: items.some(item => item.flags.major === null),
        requested_not_found: requested.filter(slug => !found.includes(slug)),
      },
    },
    count: items.length,
    warnings: [
      ...(items.some(item => item.flags.core) ? ['The plan includes WordPress core updates.'] : []),
      ...(items.some(item => item.flags.major === true)
        ? ['The plan includes a major version change.']
        : []),
      ...(allSites ? ['No sites were named, so the plan covers every site you can access.'] : []),
    ],
    errors: [],
  };
}

export function makeExecutedUpdates(preview = makeUpdatePreview()) {
  return {
    dry_run: false,
    skipped: preview.would_affect.sites.flatMap(site =>
      site.skipped.map(item => ({
        site_id: site.site_id,
        site_url: site.site_url,
        site_name: site.site_name,
        ...item,
      }))
    ),
    updated: preview.would_affect.sites.flatMap(site =>
      site.items.map(item => ({
        site_id: site.site_id,
        type: item.type,
        slug: item.slug,
        success: true,
      }))
    ),
    errors: [],
    summary: {
      total_skipped: preview.would_affect.summary.skipped_count,
      total_updated: preview.count,
      total_errors: 0,
      sites_updated: preview.would_affect.summary.site_count,
    },
  };
}

export function makeUnignorePreview() {
  return {
    dry_run: true,
    would_affect: {
      site_id: 1,
      site_url: 'https://alpine.example.test',
      site_name: 'Alpine Bakery',
      holds: [
        {
          type: 'plugin',
          slug: 'wordpress-seo/wp-seo.php',
          name: 'Yoast SEO',
          held: true,
          still_held_by: null,
          pending: { from: '25.9', to: '26.0' },
        },
        {
          type: 'plugin',
          slug: 'akismet/akismet.php',
          name: 'Akismet',
          held: false,
          still_held_by: null,
          pending: { from: '5.3.6', to: '5.3.7' },
        },
      ],
    },
    count: 1,
    warnings: [
      'Removing a hold makes the update eligible for the next run, including update-all and queued runs.',
    ],
    errors: [],
  };
}
