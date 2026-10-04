import { normalizeRemoteText } from './abilities.js';

type UpdateType = 'core' | 'plugin' | 'theme' | 'translation';
type SkipReason = 'ignored_site' | 'ignored_global' | 'ignored_site_flag';

interface UpdateFlags {
  core: boolean;
  major: boolean | null;
}

interface ItemFields {
  type: UpdateType;
  slug: string;
  name: string;
  from: string;
  to: string;
  requested: boolean;
}

interface UpdateItem extends ItemFields {
  flags: UpdateFlags;
}

interface SkippedItem extends ItemFields {
  reason: SkipReason;
}

interface UpdateSite {
  siteId: number;
  name: string;
  items: UpdateItem[];
  skipped: SkippedItem[];
}

interface GroupedItem {
  type: UpdateType;
  siteCount: number;
  flags: UpdateFlags;
}

export interface UpdatePlan {
  sites: UpdateSite[];
  byItem: GroupedItem[];
  siteCount: number;
  truncated: boolean;
  hasCore: boolean;
  hasPreviewToken: boolean;
}

const MAX_FIELD_LENGTH = 80;
const MAX_LINES = 50;
const VERSION_CAVEAT =
  'Versions are the ones pending now. If a newer version syncs before you confirm, the newer one is applied.';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function displayText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH) return undefined;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    // Line and paragraph separators are whitespace to trim() but break a summary line in two.
    if (
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      character === '\uFEFF' ||
      character === '\u2028' ||
      character === '\u2029'
    )
      return undefined;
    // Check one character so ordinary spacing survives the shared normalizer.
    if (
      character.trim() !== '' &&
      normalizeRemoteText(character, character.length, 'flatten') === ''
    ) {
      return undefined;
    }
  }
  return value;
}

function list<T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: T[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return undefined;
    const entry = parse(value[index]);
    if (entry === undefined) return undefined;
    result.push(entry);
  }
  return result;
}

function updateType(value: unknown): UpdateType | undefined {
  switch (value) {
    case 'core':
    case 'plugin':
    case 'theme':
    case 'translation':
      return value;
    default:
      return undefined;
  }
}

function flags(value: unknown): UpdateFlags | undefined {
  if (!isObject(value)) return undefined;
  const core = own(value, 'core');
  const major = own(value, 'major');
  if (typeof core !== 'boolean' || (typeof major !== 'boolean' && major !== null)) return undefined;
  return { core, major };
}

function itemFields(value: unknown): ItemFields | undefined {
  if (!isObject(value)) return undefined;
  const type = updateType(own(value, 'type'));
  const slug = displayText(own(value, 'slug'));
  const name = displayText(own(value, 'name'));
  const from = displayText(own(value, 'from'));
  const to = displayText(own(value, 'to'));
  const requested = own(value, 'requested');
  if (
    type === undefined ||
    slug === undefined ||
    name === undefined ||
    from === undefined ||
    to === undefined ||
    typeof requested !== 'boolean'
  )
    return undefined;
  return { type, slug, name, from, to, requested };
}

function updateItem(value: unknown): UpdateItem | undefined {
  const item = itemFields(value);
  if (!item || !isObject(value)) return undefined;
  const itemFlags = flags(own(value, 'flags'));
  return itemFlags ? { ...item, flags: itemFlags } : undefined;
}

function skippedItem(value: unknown): SkippedItem | undefined {
  const item = itemFields(value);
  if (!item || !isObject(value)) return undefined;
  const reason = own(value, 'reason');
  switch (reason) {
    case 'ignored_site':
    case 'ignored_global':
    case 'ignored_site_flag':
      return { ...item, reason };
    default:
      return undefined;
  }
}

function updateSite(value: unknown): UpdateSite | undefined {
  if (!isObject(value)) return undefined;
  const siteId = own(value, 'site_id');
  const name = displayText(own(value, 'site_name'));
  const items = list(own(value, 'items'), updateItem);
  const skipped = list(own(value, 'skipped'), skippedItem);
  if (
    !isCount(siteId) ||
    typeof own(value, 'site_url') !== 'string' ||
    name === undefined ||
    !items ||
    !skipped
  ) {
    return undefined;
  }
  return { siteId, name, items, skipped };
}

function groupedItem(value: unknown): GroupedItem | undefined {
  if (!isObject(value)) return undefined;
  const type = updateType(own(value, 'type'));
  const siteCount = own(value, 'site_count');
  const itemFlags = flags(own(value, 'flags'));
  if (
    type === undefined ||
    !isCount(siteCount) ||
    !itemFlags ||
    displayText(own(value, 'name')) === undefined ||
    displayText(own(value, 'slug')) === undefined ||
    !list(own(value, 'to'), displayText)
  )
    return undefined;
  return { type, siteCount, flags: itemFlags };
}

function previewError(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value) || !isCount(own(value, 'site_id'))) return undefined;
  for (const key of ['site_url', 'type', 'slug', 'code', 'message']) {
    if (typeof own(value, key) !== 'string') return undefined;
  }
  if (Object.hasOwn(value, 'site_name') && typeof own(value, 'site_name') !== 'string')
    return undefined;
  return value;
}

/** Returns only validated fields needed for summary lines; leaves the raw preview untouched. */
export function validateUpdatePlan(preview: unknown): UpdatePlan | undefined {
  if (!isObject(preview) || own(preview, 'dry_run') !== true) return undefined;
  const affected = own(preview, 'would_affect');
  if (!isObject(affected)) return undefined;
  const summary = own(affected, 'summary');
  if (!isObject(summary)) return undefined;
  const sites = list(own(affected, 'sites'), updateSite);
  const byItem = list(own(affected, 'by_item'), groupedItem);
  const count = own(preview, 'count');
  const siteCount = own(summary, 'site_count');
  const itemCount = own(summary, 'item_count');
  const skippedCount = own(summary, 'skipped_count');
  const truncated = own(summary, 'truncated');
  const hasCore = own(summary, 'has_core');
  if (
    !sites ||
    !byItem ||
    !isCount(count) ||
    !isCount(siteCount) ||
    !isCount(itemCount) ||
    !isCount(skippedCount) ||
    count !== itemCount ||
    typeof truncated !== 'boolean' ||
    typeof hasCore !== 'boolean'
  )
    return undefined;
  for (const key of ['all_sites', 'queued', 'has_major', 'has_unknown_version']) {
    if (typeof own(summary, key) !== 'boolean') return undefined;
  }
  if (
    !list(own(summary, 'requested_not_found'), displayText) ||
    !list(own(preview, 'warnings'), value => (typeof value === 'string' ? value : undefined)) ||
    !list(own(preview, 'errors'), previewError)
  )
    return undefined;
  const previewToken = own(preview, 'preview_token');
  if (Object.hasOwn(preview, 'preview_token') && typeof previewToken !== 'string') return undefined;

  const visibleItems = sites.reduce((total, site) => total + site.items.length, 0);
  const visibleSites = sites.filter(site => site.items.length > 0).length;
  const visibleSkipped = sites.reduce((total, site) => total + site.skipped.length, 0);
  if (
    truncated
      ? visibleItems > itemCount || visibleSites > siteCount || visibleSkipped > skippedCount
      : visibleItems !== itemCount || visibleSites !== siteCount || visibleSkipped !== skippedCount
  )
    return undefined;

  // The Dashboard sets flags.core from the type and builds by_item and has_core from every
  // site, including ones a truncated list leaves out, so they must agree with each other.
  if (
    sites.some(site => site.items.some(item => item.flags.core !== (item.type === 'core'))) ||
    byItem.some(
      group =>
        group.flags.core !== (group.type === 'core') ||
        group.siteCount < 1 ||
        group.siteCount > siteCount
    ) ||
    hasCore !== byItem.some(group => group.flags.core)
  )
    return undefined;
  const visibleCoreSites = sites.filter(site => site.items.some(item => item.flags.core)).length;
  const coreGroupSites = byItem
    .filter(group => group.flags.core)
    .reduce((total, group) => total + group.siteCount, 0);
  if (truncated ? visibleCoreSites > coreGroupSites : visibleCoreSites !== coreGroupSites)
    return undefined;

  return {
    sites,
    byItem,
    siteCount,
    truncated,
    hasCore,
    hasPreviewToken: typeof previewToken === 'string' && previewToken.length > 0,
  };
}

function itemName(item: ItemFields): string {
  // The Dashboard names a translation after the item it translates ("WordPress core", a
  // plugin name); the slug is a locale or "default" and means little to a user.
  return item.type === 'translation'
    ? `${item.name || item.slug} translation`
    : item.name || item.slug;
}

function versionChange(item: ItemFields): string {
  return item.from
    ? `${itemName(item)} ${item.from} → ${item.to}`
    : `${itemName(item)} → ${item.to}`;
}

function skipPhrase(reason: SkipReason): string {
  switch (reason) {
    case 'ignored_site':
      return 'ignored on this site';
    case 'ignored_global':
      return 'ignored globally';
    case 'ignored_site_flag':
      return 'site ignores all updates of that type';
  }
}

export function buildUpdatePlanSummary(plan: UpdatePlan): string[] {
  const lines: string[] = [];
  let lineCount = 0;
  const append = (line: string) => {
    lineCount++;
    if (lines.length < MAX_LINES) lines.push(line);
  };
  for (const site of plan.sites) {
    for (const item of site.items)
      append(`${site.name || `Site ${site.siteId}`}: ${versionChange(item)}`);
  }
  for (const site of plan.sites) {
    for (const item of site.skipped) {
      append(
        `Held back: ${itemName(item)} on ${site.name || `Site ${site.siteId}`} (${skipPhrase(item.reason)})`
      );
    }
  }
  for (const site of plan.sites) {
    for (const item of site.items) {
      if (item.flags.major === true) append(`Major version: ${versionChange(item)}`);
    }
  }
  const ending: string[] = [];
  if (plan.hasCore) {
    const coreSites = plan.truncated
      ? plan.byItem
          .filter(item => item.flags.core)
          .reduce((total, item) => total + item.siteCount, 0)
      : plan.sites.filter(site => site.items.some(item => item.flags.core)).length;
    ending.push(`Core update on ${coreSites} ${coreSites === 1 ? 'site' : 'sites'}`);
  }
  if (plan.truncated) {
    const visibleSites = plan.sites.filter(site => site.items.length > 0).length;
    ending.push(
      `Partial site list: showing ${visibleSites} of ${plan.siteCount} sites with updates.`
    );
  }
  if (!plan.hasPreviewToken) ending.push(VERSION_CAVEAT);
  if (lineCount + ending.length <= MAX_LINES) return [...lines, ...ending];
  // Keep aggregate notices and the caveat when plan lines are cut; the overflow marker stays last.
  const visibleLines = MAX_LINES - ending.length - 1;
  return [...lines.slice(0, visibleLines), ...ending, `+${lineCount - visibleLines} more`];
}
