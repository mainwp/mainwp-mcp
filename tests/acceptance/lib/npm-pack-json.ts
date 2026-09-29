export interface NpmPackRecord {
  name: string;
  version: string;
  filename: string;
  shasum: string;
  integrity: string;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// npm 10 prints `npm pack --json` as an array of records; npm 12 prints an
// object keyed by package name. The npm 12 form keeps one record per name, so
// callers packing several packages must not put two versions of a name in one
// call, and the count check is what catches a record npm dropped.
export function parseNpmPackJson(stdout: string, expectedCount: number): NpmPackRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`npm pack --json output is not JSON: ${JSON.stringify(stdout.slice(0, 120))}`);
  }
  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed !== null && typeof parsed === 'object') {
    entries = Object.values(parsed);
  } else {
    throw new Error(
      `npm pack --json expected an array (npm 10) or an object keyed by package name (npm 12), got ${describeValue(parsed)}`
    );
  }
  if (entries.length !== expectedCount) {
    throw new Error(
      `npm pack produced ${entries.length} package records, expected ${expectedCount}`
    );
  }
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`npm pack record ${index} is ${describeValue(entry)}, expected an object`);
    }
    const fields = entry as Record<string, unknown>;
    for (const field of ['name', 'version', 'filename'] as const) {
      if (typeof fields[field] !== 'string' || fields[field] === '') {
        throw new Error(`npm pack record ${index} has no ${field}`);
      }
    }
    return {
      name: fields.name as string,
      version: fields.version as string,
      filename: fields.filename as string,
      shasum: typeof fields.shasum === 'string' ? fields.shasum : '',
      integrity: typeof fields.integrity === 'string' ? fields.integrity : '',
    };
  });
}
