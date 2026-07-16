import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

export const FIXTURE_USERNAME = 'fixture-user';
export const FIXTURE_APP_PASSWORD = 'fixture app password';

interface FixturePlugin {
  slug: string;
  name: string;
  version: string;
  active: boolean;
  update_version: string | null;
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
  plugins: FixturePlugin[];
}

export interface FixtureDashboard {
  url: string;
  close(): Promise<void>;
}

const ABILITIES_PATH = fileURLToPath(
  new URL('../evals/fixtures/abilities-full.json', import.meta.url)
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

function parseScalar(value: string): string | number | boolean {
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function parseQueryInput(url: URL): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of url.searchParams) {
    const arrayMatch = rawKey.match(/^input\[([^\]]+)\]\[\]$/);
    if (arrayMatch) {
      const current = input[arrayMatch[1]];
      const values = Array.isArray(current) ? current : [];
      values.push(parseScalar(rawValue));
      input[arrayMatch[1]] = values;
      continue;
    }
    const scalarMatch = rawKey.match(/^input\[([^\]]+)\]$/);
    if (scalarMatch) input[scalarMatch[1]] = parseScalar(rawValue);
  }
  return input;
}

async function parseInput(request: IncomingMessage, url: URL): Promise<Record<string, unknown>> {
  if (request.method === 'GET' || request.method === 'DELETE') return parseQueryInput(url);
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((size, current) => size + current.length, 0) > 1024 * 1024) {
      throw new Error('Fixture request body too large');
    }
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: unknown };
  return parsed.input && typeof parsed.input === 'object'
    ? (parsed.input as Record<string, unknown>)
    : {};
}

function publicSite(site: FixtureSite): Omit<FixtureSite, 'plugins'> {
  const { plugins: _plugins, ...siteData } = site;
  return siteData;
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

function runAbility(
  abilityName: string,
  input: Record<string, unknown>,
  sites: FixtureSite[],
  response: ServerResponse
): void {
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

  if (abilityName === 'mainwp/count-sites-v1') {
    const status = typeof input.status === 'string' ? input.status : null;
    json(response, 200, { total: sites.filter(site => !status || site.status === status).length });
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

  json(response, 404, {
    code: 'rest_no_route',
    message: `No route was found for ability ${abilityName}.`,
    data: { status: 404 },
  });
}

export async function startFixtureDashboard(): Promise<FixtureDashboard> {
  const abilities = JSON.parse(fs.readFileSync(ABILITIES_PATH, 'utf8')) as unknown[];
  const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8')) as FixtureSite[];
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
        const input = await parseInput(request, url);
        runAbility(abilityName, input, sites, response);
        return;
      }

      json(response, 404, {
        code: 'rest_no_route',
        message: 'No route was found matching the URL and request method.',
        data: { status: 404 },
      });
    } catch (error) {
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}
