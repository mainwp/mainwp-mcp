const DEFAULT_MAX_PAGES = 50;

function itemSignature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(itemSignature).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${itemSignature(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export class BoundedPagination {
  private readonly seenPages = new Set<string>();
  private readonly seenItems = new Set<string>();

  constructor(
    private readonly label: string,
    private readonly maxPages = DEFAULT_MAX_PAGES
  ) {}

  record(page: number, items: unknown[], hasMore: boolean): void {
    if (page > this.maxPages) {
      throw new Error(`${this.label} exceeded the ${this.maxPages}-page cap`);
    }

    const pageSignature = itemSignature(items);
    const uniqueBefore = this.seenItems.size;
    for (const item of items) this.seenItems.add(itemSignature(item));

    if (!hasMore) return;
    if (this.seenPages.has(pageSignature)) {
      throw new Error(`${this.label} returned a repeated page at page ${page}`);
    }
    if (items.length > 0 && this.seenItems.size === uniqueBefore) {
      throw new Error(`${this.label} made no pagination progress at page ${page}`);
    }
    if (page >= this.maxPages) {
      throw new Error(`${this.label} exceeded the ${this.maxPages}-page cap`);
    }
    this.seenPages.add(pageSignature);
  }
}
