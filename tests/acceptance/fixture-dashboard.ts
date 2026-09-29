import { FixtureKnowledge } from './fixture-knowledge.js';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ownSchema, propertySchema } from '../../src/security.js';

export const FIXTURE_USERNAME = 'fixture-user';
export const FIXTURE_APP_PASSWORD = 'fixture app password';
export const FIXTURE_OVERSIZED_SEARCH = '__mainwp_acceptance_oversized_response__';
export const FIXTURE_DELAY_SEARCH = '__mainwp_acceptance_delayed_response__';

/**
 * Destructive ability that declares `confirm` but no `dry_run`, so the server
 * has to answer a preview request with `preview: null`. It lives in the
 * acceptance-only catalog rather than `tests/evals/fixtures/abilities-full.json`
 * because `tests/evals/safety-coverage.test.ts` asserts every destructive
 * confirm-capable ability there also declares `dry_run`.
 */
export const FIXTURE_CONFIRM_ONLY_ABILITY = 'mainwp/purge-site-cache-v1';
export const FIXTURE_CONFIRM_ONLY_TOOL = 'purge_site_cache_v1';

/** Oracle marker the confirm-only ability writes on the site it purges. */
export const FIXTURE_CACHE_PURGED_NOTE = 'Cache purged by the acceptance fixture.';

export const FIXTURE_REQUIRED_CONFIRM_ABILITY = 'mainwp/replace-site-note-v1';
export const FIXTURE_REQUIRED_CONFIRM_TOOL = 'replace_site_note_v1';

// The standard acceptance runner needs this strict schema without changing the eval catalog.
const requiredConfirmAbility = {
  name: FIXTURE_REQUIRED_CONFIRM_ABILITY,
  label: 'Replace Site Note',
  description: 'Replace a fixture site note after a dry-run preview and confirmation.',
  category: 'mainwp-sites',
  input_schema: {
    type: 'object',
    required: ['site_id_or_domain', 'note', 'confirm', 'dry_run'],
    additionalProperties: false,
    properties: {
      site_id_or_domain: { type: ['integer', 'string'], description: 'Site ID or domain' },
      note: { type: 'string', description: 'Replacement site note' },
      confirm: { type: 'boolean', description: 'Approve execution' },
      dry_run: { type: 'boolean', description: 'Preview the replacement' },
    },
  },
  meta: {
    annotations: { readonly: false, destructive: true, idempotent: true },
    show_in_rest: true,
  },
};

export const FIXTURE_PREVIEW_TOKEN_ABILITY = 'mainwp/clear-site-note-v1';
export const FIXTURE_PREVIEW_TOKEN_TOOL = 'clear_site_note_v1';
export const FIXTURE_NULLABLE_DELETE_ABILITY = 'mainwp/reset-site-note-v1';
export const FIXTURE_NULLABLE_DELETE_TOOL = 'reset_site_note_v1';

const previewTokenAbility = {
  name: FIXTURE_PREVIEW_TOKEN_ABILITY,
  label: 'Clear Site Note',
  description: 'Clear a fixture site note using the token issued by its dry-run preview.',
  category: 'mainwp-sites',
  input_schema: {
    type: 'object',
    required: ['site_id_or_domain', 'request_id', 'confirm', 'dry_run', 'preview_token'],
    properties: {
      site_id_or_domain: { type: ['integer', 'string'], description: 'Site ID or domain' },
      request_id: {
        type: 'string',
        description: 'Request identifier shared by preview and execution',
      },
      confirm: { type: 'boolean', description: 'Approve execution' },
      dry_run: { type: 'boolean', description: 'Preview the note clear' },
      preview_token: { type: ['string', 'null'], minLength: 43, maxLength: 128 },
    },
  },
  meta: {
    annotations: { readonly: false, destructive: true, idempotent: false },
    show_in_rest: true,
  },
};

const FIXTURE_OVERSIZED_BYTES = 256 * 1024;
const FIXTURE_DELAY_MS = 750;

interface FixturePlugin {
  slug: string;
  name: string;
  version: string;
  active: boolean;
  update_version: string | null;
}

type FixtureTheme = FixturePlugin;

interface FixtureIgnoredUpdate {
  type: 'core' | 'plugin' | 'theme';
  slug: string;
  name: string;
  ignored_version: string;
}

interface FixtureChange {
  type: string;
  item: string;
  detected_at: string;
  detail: string;
}

interface FixtureSite {
  id: number;
  url: string;
  name: string;
  status: string;
  client_id: number | null;
  wp_version: string;
  php_version: string;
  last_sync: string;
  admin_username: string;
  child_version: string;
  notes: string;
  core_update: string | null;
  plugins: FixturePlugin[];
  themes: FixtureTheme[];
  ignored_updates: FixtureIgnoredUpdate[];
  security_issues: Record<string, number>;
  changes: FixtureChange[];
}

interface FixtureUpdate {
  type: 'core' | 'plugin' | 'theme' | 'translation';
  slug: string;
  name: string;
  current_version: string;
  new_version: string;
}

/** Ability input names for update types, and the type each row carries. */
const UPDATE_TYPE_BY_FILTER: Record<string, FixtureUpdate['type']> = {
  core: 'core',
  plugins: 'plugin',
  themes: 'theme',
  translations: 'translation',
};

export interface FixtureDashboard {
  url: string;
  /** Restore the site table to its on-disk state so repeated runs are independent. */
  reset(): void;
  close(): Promise<void>;
}

export interface FixtureDashboardOptions {
  /**
   * Serve the acceptance-only catalog additions (see
   * FIXTURE_CONFIRM_ONLY_ABILITY) on top of the shared eval catalog. Off by
   * default so the standard acceptance run sees the same catalog the eval
   * fixtures describe.
   */
  acceptanceOnlyAbilities?: boolean;
}

const ABILITIES_PATH = fileURLToPath(
  new URL('../evals/fixtures/abilities-full.json', import.meta.url)
);
const ACCEPTANCE_ABILITIES_PATH = fileURLToPath(
  new URL('./fixtures/abilities-acceptance.json', import.meta.url)
);
const SITES_PATH = fileURLToPath(new URL('./fixtures/sites.json', import.meta.url));
const API_PREFIX = '/wp-json/wp-abilities/v1';

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function parseScalar(value: string, schema?: Record<string, unknown>): string | number | boolean {
  const type = schema && Object.hasOwn(schema, 'type') ? schema.type : undefined;
  const types =
    typeof type === 'string'
      ? [type]
      : Array.isArray(type)
        ? type.filter(candidate => typeof candidate === 'string')
        : [];
  const lowerValue = value.toLowerCase();
  for (const candidate of types) {
    if (candidate === 'boolean' && ['1', '0', 'true', 'false'].includes(lowerValue)) {
      return lowerValue !== 'false' && lowerValue !== '0';
    }
    if (candidate === 'integer' && /^-?\d+$/.test(value)) return Number(value);
    if (candidate === 'number' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (candidate === 'string') return value;
  }
  if (types.length > 0) return value;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseQueryInput(url: URL, schema: unknown): Record<string, unknown> | null {
  const input: Record<string, unknown> = {};
  let hasInput = url.searchParams.has('input');
  for (const [rawKey, rawValue] of url.searchParams) {
    if (rawKey.startsWith('input[')) hasInput = true;
    const arrayMatch = rawKey.match(/^input\[([^\]]+)\]\[\]$/);
    if (arrayMatch) {
      const current = input[arrayMatch[1]];
      const values = Array.isArray(current) ? current : [];
      values.push(parseScalar(rawValue, ownSchema(propertySchema(schema, arrayMatch[1]), 'items')));
      input[arrayMatch[1]] = values;
      continue;
    }
    const scalarMatch = rawKey.match(/^input\[([^\]]+)\]$/);
    if (scalarMatch)
      input[scalarMatch[1]] = parseScalar(rawValue, propertySchema(schema, scalarMatch[1]));
  }
  return hasInput ? input : null;
}

class InputTransportError extends Error {}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidTransport(): never {
  throw new InputTransportError('The ability input transport is invalid.');
}

async function parseInput(
  request: IncomingMessage,
  url: URL,
  schema: unknown
): Promise<{ input: Record<string, unknown> | null; body: string }> {
  const hasQueryInput = [...url.searchParams.keys()].some(key => /^input(?:\[|$)/.test(key));
  if (request.method === 'GET') {
    if (!url.searchParams.has('input_json'))
      return { input: parseQueryInput(url, schema), body: '' };
    const encoded = url.searchParams.get('input_json')!;
    if (hasQueryInput || Buffer.byteLength(encoded, 'utf8') > 8192) invalidTransport();
    let input: unknown;
    try {
      input = JSON.parse(encoded);
    } catch {
      invalidTransport();
    }
    if (!isJsonObject(input)) invalidTransport();
    return { input, body: '' };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size <= 1024 * 1024) chunks.push(buffer);
  }
  // Drain before rejecting so the fixture can send its transport error.
  if (size > 1024 * 1024) {
    if (request.method === 'DELETE') invalidTransport();
    throw new Error('Fixture request body too large');
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (request.method === 'DELETE') {
    if (!body) return { input: parseQueryInput(url, schema), body };
    if (hasQueryInput || url.searchParams.has('input_json')) invalidTransport();
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
      invalidTransport();
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      invalidTransport();
    }
    if (
      !isJsonObject(envelope) ||
      Object.keys(envelope).length !== 1 ||
      !Object.hasOwn(envelope, 'input') ||
      !isJsonObject(envelope.input)
    )
      invalidTransport();
    return { input: envelope.input, body };
  }
  if (!body) return { input: {}, body };
  const parsed = JSON.parse(body) as { input?: unknown };
  return {
    input:
      parsed.input && typeof parsed.input === 'object'
        ? (parsed.input as Record<string, unknown>)
        : {},
    body,
  };
}

interface FixtureTransport {
  method: string;
  body: string;
  contentType: string;
  query: string;
}

type PublicSite = Omit<
  FixtureSite,
  'core_update' | 'plugins' | 'themes' | 'ignored_updates' | 'security_issues' | 'changes'
>;

/**
 * The site record `mainwp/get-site-v1` returns. The inventories behind the
 * per-site abilities stay out of it: a Dashboard does not inline them into the
 * site record, and the read-only command scenarios snapshot this shape.
 */
function publicSite(site: FixtureSite): PublicSite {
  const {
    core_update: _coreUpdate,
    plugins: _plugins,
    themes: _themes,
    ignored_updates: _ignoredUpdates,
    security_issues: _securityIssues,
    changes: _changes,
    ...siteData
  } = site;
  return siteData;
}

/** Update types the request asked for; an empty or absent list means all. */
function requestedUpdateTypes(input: Record<string, unknown>): Set<FixtureUpdate['type']> {
  const requested = Array.isArray(input.types)
    ? input.types.filter((value): value is string => typeof value === 'string')
    : [];
  if (requested.length === 0) return new Set(Object.values(UPDATE_TYPE_BY_FILTER));
  return new Set(
    requested
      .map(filter => UPDATE_TYPE_BY_FILTER[filter])
      .filter((type): type is FixtureUpdate['type'] => type !== undefined)
  );
}

function siteUpdates(site: FixtureSite, types: Set<FixtureUpdate['type']>): FixtureUpdate[] {
  const updates: FixtureUpdate[] = [];
  if (site.core_update && types.has('core')) {
    updates.push({
      type: 'core',
      slug: 'wordpress',
      name: 'WordPress',
      current_version: site.wp_version,
      new_version: site.core_update,
    });
  }
  const inventories: Array<[FixtureUpdate['type'], FixturePlugin[]]> = [
    ['plugin', site.plugins],
    ['theme', site.themes],
  ];
  for (const [type, items] of inventories) {
    if (!types.has(type)) continue;
    for (const item of items) {
      if (!item.update_version) continue;
      updates.push({
        type,
        slug: item.slug,
        name: item.name,
        current_version: item.version,
        new_version: item.update_version,
      });
    }
  }
  return updates;
}

function updateSummary(updates: FixtureUpdate[]): Record<string, number> {
  const count = (type: FixtureUpdate['type']): number =>
    updates.filter(update => update.type === type).length;
  return {
    core: count('core'),
    plugins: count('plugin'),
    themes: count('theme'),
    translations: count('translation'),
    total: updates.length,
  };
}

/** Sites named by a network-wide filter; an empty or absent list means all. */
function filterSites(sites: FixtureSite[], identifiers: unknown): FixtureSite[] | null {
  if (!Array.isArray(identifiers) || identifiers.length === 0) return sites;
  const selected: FixtureSite[] = [];
  for (const identifier of identifiers) {
    const site = findSite(sites, identifier);
    if (!site) return null;
    if (!selected.includes(site)) selected.push(site);
  }
  return selected;
}

function findSite(sites: FixtureSite[], identifier: unknown): FixtureSite | undefined {
  const value = String(identifier ?? '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return sites.find(site => {
    if (String(site.id) === value) return true;
    const url = site.url.replace(/\/+$/, '').toLowerCase();
    return url === value || new URL(url).hostname === value;
  });
}

function notFound(response: ServerResponse, message: string): void {
  json(response, 404, {
    code: 'mainwp_site_not_found',
    message,
    data: { status: 404 },
  });
}

export function getFixtureFaultMode(
  abilityName: string,
  input: Record<string, unknown>
): 'oversized' | 'delay' | null {
  if (abilityName !== 'mainwp/list-sites-v1') return null;
  if (input.search === FIXTURE_OVERSIZED_SEARCH) return 'oversized';
  if (input.search === FIXTURE_DELAY_SEARCH) return 'delay';
  return null;
}

/**
 * Abilities available to fixture agent passes. The catalog advertises far
 * more (the full eval catalog, for parity with what a real Dashboard lists),
 * so agent passes hide everything else behind MAINWP_ALLOWED_TOOLS and the
 * advertised-routes-resolve scenario holds this list to what really routes.
 */
export const FIXTURE_ROUTED_ABILITIES = [
  'mainwp/get-knowledge-record-v1',
  'mainwp/get-site-knowledge-v1',
  'mainwp/get-client-knowledge-v1',
  'mainwp/list-knowledge-v1',
  'mainwp/create-knowledge-record-v1',
  'mainwp/update-knowledge-record-v1',
  'mainwp/delete-knowledge-record-v1',
  'mainwp/list-sites-v1',
  'mainwp/get-sites-basic-v1',
  'mainwp/count-sites-v1',
  'mainwp/get-site-v1',
  'mainwp/get-site-plugins-v1',
  'mainwp/get-site-themes-v1',
  'mainwp/get-site-updates-v1',
  'mainwp/list-updates-v1',
  'mainwp/list-ignored-updates-v1',
  'mainwp/get-site-security-v1',
  'mainwp/get-site-changes-v1',
  'mainwp/check-site-v1',
  'mainwp/get-batch-job-status-v1',
  'mainwp/delete-site-v1',
  FIXTURE_CONFIRM_ONLY_ABILITY,
] as const;

/**
 * Answer one ability execution from in-memory fixture state. Writes mutate
 * the `sites` array in place, so scenarios can verify state before and after
 * a call. An ability with no handler here answers 404 like an unregistered
 * route.
 */
async function runAbility(
  abilityName: string,
  input: Record<string, unknown>,
  sites: FixtureSite[],
  previewTokens: Map<string, string>,
  response: ServerResponse,
  knowledge: FixtureKnowledge,
  transport?: FixtureTransport
): Promise<void> {
  if (
    abilityName.includes('knowledge') &&
    FIXTURE_ROUTED_ABILITIES.some(name => name === abilityName)
  ) {
    const result = knowledge.run(abilityName, input, sites);
    json(response, result.status, result.body);
    return;
  }
  const faultMode = getFixtureFaultMode(abilityName, input);
  if (faultMode === 'oversized') {
    json(response, 200, { payload: 'x'.repeat(FIXTURE_OVERSIZED_BYTES) });
    return;
  }
  if (faultMode === 'delay') {
    await new Promise(resolve => setTimeout(resolve, FIXTURE_DELAY_MS));
  }

  if (abilityName === 'mainwp/list-sites-v1') {
    const page = typeof input.page === 'number' ? input.page : 1;
    const perPage = typeof input.per_page === 'number' ? input.per_page : 20;
    const status = typeof input.status === 'string' ? input.status : 'any';
    const search = typeof input.search === 'string' ? input.search.toLowerCase() : '';
    const filtered = sites.filter(site => {
      const statusMatches = status === 'any' || site.status === status;
      const searchMatches =
        !search ||
        site.name.toLowerCase().includes(search) ||
        site.url.toLowerCase().includes(search);
      return statusMatches && searchMatches;
    });
    const start = (page - 1) * perPage;
    json(response, 200, {
      items: filtered.slice(start, start + perPage).map(publicSite),
      page,
      per_page: perPage,
      total: filtered.length,
    });
    return;
  }

  if (abilityName === 'mainwp/get-sites-basic-v1') {
    const page = typeof input.page === 'number' ? input.page : 1;
    const perPage = typeof input.per_page === 'number' ? input.per_page : 20;
    const status = typeof input.status === 'string' ? input.status : null;
    const clientId = typeof input.client_id === 'number' ? input.client_id : null;
    const filtered = sites.filter(
      site =>
        (!status || site.status === status) && (clientId === null || site.client_id === clientId)
    );
    const start = (page - 1) * perPage;
    json(response, 200, {
      items: filtered
        .slice(start, start + perPage)
        .map(site => ({ id: site.id, url: site.url, name: site.name })),
      page,
      per_page: perPage,
      total: filtered.length,
    });
    return;
  }

  if (abilityName === 'mainwp/count-sites-v1') {
    const status = typeof input.status === 'string' ? input.status : null;
    json(response, 200, { total: sites.filter(site => !status || site.status === status).length });
    return;
  }

  if (abilityName === 'mainwp/get-batch-job-status-v1') {
    if (input.job_id !== 'sync_abc123') return notFound(response, 'The batch job was not found.');
    json(response, 200, {
      job_id: 'sync_abc123',
      type: 'sync',
      status: 'completed',
      progress: 100,
      processed: 1,
      total: 1,
      succeeded: 1,
      failed: 0,
    });
    return;
  }

  if (abilityName === 'mainwp/get-site-v1') {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    json(response, 200, publicSite(site));
    return;
  }

  if (abilityName === 'mainwp/get-site-plugins-v1') {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    const status = typeof input.status === 'string' ? input.status : 'all';
    const hasUpdate = input.has_update === true;
    const plugins = site.plugins.filter(plugin => {
      const statusMatches =
        status === 'all' ||
        (status === 'active' ? plugin.active : status === 'inactive' && !plugin.active);
      return statusMatches && (!hasUpdate || plugin.update_version !== null);
    });
    json(response, 200, {
      site_id: site.id,
      site_url: site.url,
      plugins,
      total: plugins.length,
    });
    return;
  }

  if (abilityName === 'mainwp/get-site-themes-v1') {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    const status = typeof input.status === 'string' ? input.status : 'all';
    const hasUpdate = input.has_update === true;
    const themes = site.themes.filter(theme => {
      const statusMatches =
        status === 'all' ||
        (status === 'active' ? theme.active : status === 'inactive' && !theme.active);
      return statusMatches && (!hasUpdate || theme.update_version !== null);
    });
    json(response, 200, {
      site_id: site.id,
      site_url: site.url,
      active_theme: site.themes.find(theme => theme.active)?.slug ?? '',
      themes,
      total: themes.length,
    });
    return;
  }

  if (abilityName === 'mainwp/get-site-updates-v1') {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    const updates = siteUpdates(site, requestedUpdateTypes(input));
    json(response, 200, {
      site_id: site.id,
      site_url: site.url,
      site_name: site.name,
      updates,
      rollback_items: { plugins: [], themes: [] },
      summary: updateSummary(updates),
    });
    return;
  }

  if (abilityName === 'mainwp/list-updates-v1') {
    const selected = filterSites(sites, input.site_ids_or_domains);
    if (!selected) return notFound(response, 'A requested MainWP site was not found.');
    const types = requestedUpdateTypes(input);
    const updates = selected.flatMap(site =>
      siteUpdates(site, types).map(update => ({
        site_id: site.id,
        site_url: site.url,
        site_name: site.name,
        ...update,
      }))
    );
    const page = typeof input.page === 'number' ? input.page : 1;
    const perPage = typeof input.per_page === 'number' ? input.per_page : 50;
    const start = (page - 1) * perPage;
    json(response, 200, {
      updates: updates.slice(start, start + perPage),
      // The ability documents the summary as counts across the whole filter,
      // not the returned page.
      summary: updateSummary(updates),
      page,
      per_page: perPage,
      total: updates.length,
      errors: [],
    });
    return;
  }

  if (abilityName === 'mainwp/list-ignored-updates-v1') {
    const selected = filterSites(sites, input.site_ids_or_domains);
    if (!selected) return notFound(response, 'A requested MainWP site was not found.');
    const types = requestedUpdateTypes(input);
    const ignored = selected.flatMap(site =>
      site.ignored_updates
        .filter(entry => types.has(entry.type))
        .map(entry => ({
          site_id: site.id,
          site_url: site.url,
          site_name: site.name,
          ...entry,
        }))
    );
    json(response, 200, { ignored, total: ignored.length, errors: [] });
    return;
  }

  if (abilityName === 'mainwp/get-site-security-v1') {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    json(response, 200, {
      site_id: site.id,
      security_issues: site.security_issues,
      total_issues: Object.values(site.security_issues).reduce((sum, count) => sum + count, 0),
    });
    return;
  }

  if (abilityName === 'mainwp/get-site-changes-v1') {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    const type = typeof input.type === 'string' ? input.type : '';
    const items = site.changes.filter(change => !type || change.type === type);
    const page = typeof input.page === 'number' ? input.page : 1;
    const perPage = typeof input.per_page === 'number' ? input.per_page : 20;
    const start = (page - 1) * perPage;
    json(response, 200, {
      items: items.slice(start, start + perPage),
      page,
      per_page: perPage,
      total: items.length,
    });
    return;
  }

  if (abilityName === 'mainwp/check-site-v1') {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    const online = site.status === 'connected';
    const responseTime = 0.01;
    json(response, 200, {
      site_id: site.id,
      response_time: responseTime,
      checked: true,
      site: { id: site.id, url: site.url, name: site.name },
      status: { online, http_code: online ? 200 : 503, response_time: responseTime },
    });
    return;
  }

  if (abilityName === 'mainwp/delete-site-v1') {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    if (input.dry_run === true) {
      json(response, 200, {
        dry_run: true,
        would_affect: publicSite(site),
        warnings: ['Fixture preview only. No site was changed.'],
        deleted: false,
      });
      return;
    }
    if (input.confirm === true) {
      sites.splice(sites.indexOf(site), 1);
      json(response, 200, {
        dry_run: false,
        deleted: true,
        site: publicSite(site),
      });
      return;
    }
    json(response, 403, {
      code: 'fixture_write_disabled',
      message: 'The fixture dashboard requires confirm: true for site deletion.',
      data: { status: 403 },
    });
    return;
  }

  if (abilityName === FIXTURE_CONFIRM_ONLY_ABILITY) {
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    // No dry_run branch: the ability declares none, so the server must never
    // send one. Anything other than confirm:true is a refusal, which is also
    // what a catalog-only ability would produce if the executor were missing.
    if (input.confirm !== true) {
      json(response, 403, {
        code: 'fixture_write_disabled',
        message: 'The fixture dashboard requires confirm: true for a cache purge.',
        data: { status: 403 },
      });
      return;
    }
    site.notes = FIXTURE_CACHE_PURGED_NOTE;
    json(response, 200, {
      purged: true,
      site: publicSite(site),
      entries_removed: 42,
    });
    return;
  }

  if (abilityName === FIXTURE_REQUIRED_CONFIRM_ABILITY) {
    // additionalProperties: false, as WordPress enforces it: the server's own
    // user_confirmed and confirmation_token must never arrive here.
    const declared = Object.keys(requiredConfirmAbility.input_schema.properties);
    const undeclared = Object.keys(input).find(key => !declared.includes(key));
    if (undeclared !== undefined) {
      json(response, 400, {
        code: 'ability_invalid_input',
        message: `Ability "${abilityName}" has invalid input. Reason: ${undeclared} is not a valid property of Object.`,
      });
      return;
    }
    for (const key of ['confirm', 'dry_run']) {
      if (!Object.hasOwn(input, key)) {
        json(response, 400, {
          code: 'ability_invalid_input',
          message: `Ability "${abilityName}" has invalid input. Reason: ${key} is a required property of input.`,
        });
        return;
      }
    }
    if (
      typeof input.confirm !== 'boolean' ||
      typeof input.dry_run !== 'boolean' ||
      input.confirm === input.dry_run
    ) {
      json(response, 400, {
        code: 'ability_invalid_input',
        message: `Ability "${abilityName}" has invalid input. Reason: confirm and dry_run must be opposite booleans.`,
      });
      return;
    }
    if (typeof input.note !== 'string') {
      json(response, 400, {
        code: 'ability_invalid_input',
        message: `Ability "${abilityName}" has invalid input. Reason: note is not of type string.`,
      });
      return;
    }
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    if (input.dry_run === true) {
      json(response, 200, {
        dry_run: true,
        updated: false,
        would_affect: { site_id: site.id, notes: input.note },
      });
      return;
    }
    site.notes = input.note;
    json(response, 200, { dry_run: false, updated: true, site: publicSite(site) });
    return;
  }

  if (
    abilityName === FIXTURE_PREVIEW_TOKEN_ABILITY ||
    abilityName === FIXTURE_NULLABLE_DELETE_ABILITY
  ) {
    for (const key of ['confirm', 'dry_run', 'preview_token']) {
      if (!Object.hasOwn(input, key)) {
        json(response, 400, {
          code: 'ability_invalid_input',
          message: `Ability "${abilityName}" has invalid input. Reason: ${key} is a required property of input.`,
        });
        return;
      }
    }
    if (
      typeof input.confirm !== 'boolean' ||
      typeof input.dry_run !== 'boolean' ||
      input.confirm === input.dry_run
    ) {
      json(response, 400, {
        code: 'ability_invalid_input',
        message: `Ability "${abilityName}" has invalid input. Reason: confirm and dry_run must be opposite booleans.`,
      });
      return;
    }
    if (typeof input.request_id !== 'string') {
      json(response, 400, {
        code: 'ability_invalid_input',
        message: `Ability "${abilityName}" has invalid input. Reason: request_id is not of type string.`,
      });
      return;
    }
    const site = findSite(sites, input.site_id_or_domain);
    if (!site) return notFound(response, 'The requested MainWP site was not found.');
    const tokenKey = JSON.stringify([site.id, input.request_id]);
    if (input.dry_run === true) {
      if (input.preview_token !== null) {
        json(response, 400, {
          code: 'ability_invalid_input',
          message: `Ability "${abilityName}" has invalid input. Reason: preview_token must be null during a dry run.`,
        });
        return;
      }
      const token = randomBytes(32).toString('base64url');
      previewTokens.set(tokenKey, token);
      json(response, 200, {
        dry_run: true,
        updated: false,
        would_affect: { site_id: site.id, notes: '' },
        preview_token: token,
        ...(transport ? { transport } : {}),
      });
      return;
    }
    if (
      typeof input.preview_token !== 'string' ||
      input.preview_token !== previewTokens.get(tokenKey)
    ) {
      json(response, 403, {
        code: 'fixture_preview_token_invalid',
        message: 'The preview token does not match an unused preview for this site and request.',
        data: { status: 403 },
      });
      return;
    }
    previewTokens.delete(tokenKey);
    site.notes = '';
    json(response, 200, {
      dry_run: false,
      updated: true,
      site: publicSite(site),
      ...(transport ? { transport } : {}),
    });
    return;
  }

  json(response, 404, {
    code: 'rest_no_route',
    message: `No route was found for ability ${abilityName}.`,
    data: { status: 404 },
  });
}

/**
 * Start a loopback HTTP server that stands in for a Dashboard's Abilities API:
 * Basic auth, the ability catalog, and ability execution against fixture
 * sites. It lets the acceptance suite run the packed server end to end
 * without a real Dashboard.
 */
export async function startFixtureDashboard(
  options: FixtureDashboardOptions = {}
): Promise<FixtureDashboard> {
  const abilities = [
    ...(JSON.parse(fs.readFileSync(ABILITIES_PATH, 'utf8')) as unknown[]),
    requiredConfirmAbility,
    previewTokenAbility,
    ...(
      JSON.parse(fs.readFileSync(ACCEPTANCE_ABILITIES_PATH, 'utf8')) as Array<{ name: string }>
    ).filter(
      ability => options.acceptanceOnlyAbilities || ability.name === FIXTURE_NULLABLE_DELETE_ABILITY
    ),
  ];
  const loadSites = (): FixtureSite[] =>
    JSON.parse(fs.readFileSync(SITES_PATH, 'utf8')) as FixtureSite[];
  // Reassignable so reset() can hand every run the same starting state; the
  // request handler reads this binding at call time.
  let sites = loadSites();
  const previewTokens = new Map<string, string>();
  let knowledge = new FixtureKnowledge();
  const expectedAuthorization = `Basic ${Buffer.from(
    `${FIXTURE_USERNAME}:${FIXTURE_APP_PASSWORD}`
  ).toString('base64')}`;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== expectedAuthorization) {
        response.setHeader('www-authenticate', 'Basic realm="MainWP fixture"');
        json(response, 401, {
          code: 'rest_not_logged_in',
          message: 'You are not currently logged in.',
          data: { status: 401 },
        });
        return;
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === `${API_PREFIX}/abilities`) {
        json(response, 200, abilities);
        return;
      }

      const prefix = `${API_PREFIX}/abilities/`;
      const suffix = '/run';
      if (url.pathname.startsWith(prefix) && url.pathname.endsWith(suffix)) {
        const abilityName = decodeURIComponent(url.pathname.slice(prefix.length, -suffix.length));
        const ability = (
          abilities as Array<{
            name: string;
            input_schema?: { type?: unknown; default?: unknown };
          }>
        ).find(candidate => candidate.name === abilityName);
        const schema = ability?.input_schema;
        const { input, body } = await parseInput(request, url, schema);
        if (abilityName === FIXTURE_NULLABLE_DELETE_ABILITY) {
          const requiredSchema = schema as {
            required: string[];
            properties: Record<string, { type: string | string[] }>;
          };
          for (const key of requiredSchema.required) {
            const type = requiredSchema.properties[key].type;
            if (
              !input ||
              !Object.hasOwn(input, key) ||
              (input[key] === null &&
                !(type === 'null' || (Array.isArray(type) && type.includes('null'))))
            ) {
              json(response, 400, {
                code: 'ability_invalid_input',
                message: `Ability input requires a valid "${key}" property.`,
              });
              return;
            }
          }
        }
        const schemaType = schema?.type;
        if (
          input === null &&
          FIXTURE_ROUTED_ABILITIES.some(candidate => candidate === abilityName) &&
          schema &&
          !Object.hasOwn(schema, 'default') &&
          (schemaType === 'object' || (Array.isArray(schemaType) && schemaType.includes('object')))
        ) {
          // The WP run controller reads a missing GET/DELETE input as null.
          json(response, 400, {
            code: 'rest_invalid_param',
            message: 'input is not of type object.',
          });
          return;
        }
        await runAbility(
          abilityName,
          input ?? {},
          sites,
          previewTokens,
          response,
          knowledge,
          abilityName === FIXTURE_NULLABLE_DELETE_ABILITY
            ? {
                method: request.method ?? '',
                body,
                contentType: request.headers['content-type'] ?? '',
                query: url.search,
              }
            : undefined
        );
        return;
      }

      json(response, 404, {
        code: 'rest_no_route',
        message: 'No route was found matching the URL and request method.',
        data: { status: 404 },
      });
    } catch (error) {
      if (error instanceof InputTransportError) {
        json(response, 400, {
          code: 'mainwp_abilities_invalid_input_transport',
          message: error.message,
          data: { status: 400 },
        });
        return;
      }
      json(response, 500, {
        code: 'fixture_internal_error',
        message: error instanceof Error ? error.message : 'Fixture error',
        data: { status: 500 },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Fixture dashboard did not bind to an IP socket');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    reset: () => {
      sites = loadSites();
      previewTokens.clear();
      knowledge = new FixtureKnowledge();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}
