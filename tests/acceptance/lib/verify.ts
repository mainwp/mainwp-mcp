import { Agent, request } from 'undici';
import type { AcceptanceCredentials } from './env.js';
import { BoundedPagination } from './pagination.js';

interface AbilityAnnotations {
  readonly: boolean;
  destructive: boolean;
  idempotent: boolean;
}

interface AbilityDefinition {
  name: string;
  input_schema?: {
    properties?: Record<string, { items?: { enum?: unknown[] } }>;
  };
  meta?: { annotations?: AbilityAnnotations };
}

export interface VerifiedSite {
  id: number;
  url: string;
  name: string;
  status?: string;
  last_sync?: string | null;
  [key: string]: unknown;
}

export interface VerifiedPlugin {
  slug: string;
  name: string;
  version: string;
  active: boolean;
  update_version?: string | null;
  [key: string]: unknown;
}

export interface VerifiedPluginResponse {
  site_id: number;
  site_url: string;
  plugins: VerifiedPlugin[];
  total: number;
}

export function serializeToPhpQueryString(input: Record<string, unknown>): string {
  const params: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === 'object') {
          throw new Error(`Unsupported nested query parameter at "${key}": arrays need scalars`);
        }
        params.push(`input[${encodeURIComponent(key)}][]=${encodeURIComponent(String(item))}`);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subValue !== null && typeof subValue === 'object') {
          throw new Error(
            `Unsupported nested query parameter at "${key}": objects may be only one level deep`
          );
        }
        params.push(
          `input[${encodeURIComponent(key)}][${encodeURIComponent(subKey)}]=${encodeURIComponent(String(subValue))}`
        );
      }
    } else if (value !== undefined && value !== null) {
      params.push(`input[${encodeURIComponent(key)}]=${encodeURIComponent(String(value))}`);
    }
  }
  return params.length > 0 ? `?${params.join('&')}` : '';
}

export class IndependentVerifier {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly dispatcher?: Agent;
  private catalog?: AbilityDefinition[];

  constructor(credentials: AcceptanceCredentials, skipTlsVerify: boolean) {
    this.baseUrl = `${credentials.dashboardUrl.replace(/\/+$/, '')}/wp-json/wp-abilities/v1`;
    this.authorization = `Basic ${Buffer.from(
      `${credentials.username}:${credentials.appPassword}`
    ).toString('base64')}`;
    if (skipTlsVerify) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  getAuthorizationHeader(): string {
    return this.authorization;
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }

  async fetchCatalog(): Promise<AbilityDefinition[]> {
    if (this.catalog) return this.catalog;
    const abilities: AbilityDefinition[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const response = await this.requestJsonResponse<AbilityDefinition[]>(
        `${this.baseUrl}/abilities?per_page=100&page=${page}`,
        'GET'
      );
      if (!Array.isArray(response.data)) {
        throw new Error(`Independent verifier expected an ability array on catalog page ${page}`);
      }
      abilities.push(...response.data);
      const rawTotalPages = response.headers['x-wp-totalpages'];
      const totalPages = Number(
        Array.isArray(rawTotalPages) ? rawTotalPages[0] : (rawTotalPages ?? 1)
      );
      if (page >= totalPages) break;
      if (page === 50) throw new Error('Independent verifier catalog exceeded the 50-page cap');
    }
    this.catalog = abilities;
    return this.catalog;
  }

  async getAbilityInputArrayEnum(abilityName: string, argumentName: string): Promise<string[]> {
    const ability = (await this.fetchCatalog()).find(candidate => candidate.name === abilityName);
    if (!ability) throw new Error(`Independent verifier could not find ability ${abilityName}`);
    const values = ability.input_schema?.properties?.[argumentName]?.items?.enum;
    if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) {
      throw new Error(
        `Independent verifier found no string enum for ${abilityName} argument ${argumentName}`
      );
    }
    return values as string[];
  }

  async execute(abilityName: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const catalog = await this.fetchCatalog();
    const ability = catalog.find(candidate => candidate.name === abilityName);
    if (!ability) throw new Error(`Independent verifier could not find ability ${abilityName}`);

    const annotations = ability.meta?.annotations;
    const isReadonly = annotations?.readonly ?? false;
    const isDestructive = annotations?.destructive ?? true;
    const isIdempotent = annotations?.idempotent ?? false;
    const endpoint = `${this.baseUrl}/abilities/${abilityName}/run`;

    if (isReadonly || (isDestructive && isIdempotent)) {
      const method = isReadonly ? 'GET' : 'DELETE';
      return this.requestJson(
        endpoint + (Object.keys(input).length > 0 ? serializeToPhpQueryString(input) : ''),
        method
      );
    }
    return this.requestJson(endpoint, 'POST', JSON.stringify({ input }));
  }

  async listSites(): Promise<VerifiedSite[]> {
    const sites: VerifiedSite[] = [];
    let page = 1;
    const pagination = new BoundedPagination('Independent verifier list-sites-v1');
    for (;;) {
      const response = (await this.execute('mainwp/list-sites-v1', {
        page,
        per_page: 100,
      })) as { items: VerifiedSite[]; total: number };
      sites.push(...response.items);
      const hasMore = sites.length < response.total && response.items.length > 0;
      pagination.record(page, response.items, hasMore);
      if (!hasMore) return sites;
      page += 1;
    }
  }

  async countSites(): Promise<number> {
    const response = (await this.execute('mainwp/count-sites-v1')) as { total: number };
    return response.total;
  }

  async getSite(siteIdOrDomain: number | string): Promise<VerifiedSite> {
    return (await this.execute('mainwp/get-site-v1', {
      site_id_or_domain: siteIdOrDomain,
    })) as VerifiedSite;
  }

  async getSitePlugins(siteIdOrDomain: number | string): Promise<VerifiedPluginResponse> {
    return (await this.execute('mainwp/get-site-plugins-v1', {
      site_id_or_domain: siteIdOrDomain,
    })) as VerifiedPluginResponse;
  }

  private async requestJson<T = unknown>(
    url: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: string
  ): Promise<T> {
    return (await this.requestJsonResponse<T>(url, method, body)).data;
  }

  private async requestJsonResponse<T>(
    url: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: string
  ): Promise<{ data: T; headers: Record<string, string | string[] | undefined> }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await request(url, {
        method,
        headers: {
          authorization: this.authorization,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        ...(body ? { body } : {}),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
      const responseBody = await response.body.text();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(
          `Independent verifier request failed with HTTP ${response.statusCode}: ${responseBody}`
        );
      }
      return {
        data: JSON.parse(responseBody) as T,
        headers: response.headers,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
