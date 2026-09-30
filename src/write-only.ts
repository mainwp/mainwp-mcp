/**
 * Schema-driven redaction for caller values marked `writeOnly: true`.
 *
 * These values are intentionally scoped to one Ability call. They must not be
 * registered as process-wide credentials. Parsed previews and results are
 * matched against values from the Ability input schema. The carried flag
 * lets the caller withhold upstream error text for the whole call.
 */

import { McpErrorFactory } from './errors.js';
import { DEPTH_LIMIT_MARKER } from './security.js';

const REDACTED = '[redacted]';
const MAX_DEPTH = 100;
const MIN_REDACTED_LENGTH = 4;
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;
const PHP_NUMERIC_STRING = /^[ \t\n\v\f\r]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\v\f\r]*$/;

type JsonSchema = Record<string, unknown>;
export interface WriteOnlyRedactor {
  carriesWriteOnly: boolean;
  text(value: string): string;
  mentions(value: string): boolean;
  deep(value: unknown): unknown;
}

function asSchema(value: unknown): JsonSchema | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

function splitWordPressArray(value: string | number): string[] {
  return String(value)
    .split(/[ \t\n\v\f\r,]+/)
    .filter(Boolean);
}

function collectScalarLeaves(
  value: unknown,
  privateStrings: Set<string>,
  privateNumbers: Set<number>,
  seen: WeakSet<object>,
  depth: number
): void {
  if (depth >= MAX_DEPTH) {
    throw McpErrorFactory.invalidParams(
      `Write-only input exceeds maximum nesting depth (${MAX_DEPTH})`
    );
  }
  if (typeof value === 'string') {
    if (value.length > 0) {
      privateStrings.add(value);
    }
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    privateNumbers.add(value);
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    throw McpErrorFactory.invalidParams(
      `Write-only input exceeds maximum nesting depth (${MAX_DEPTH})`
    );
  }
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectScalarLeaves(child, privateStrings, privateNumbers, seen, depth + 1);
  }
}

function canonicalCompound(value: unknown, maxLength = Infinity, depth = 0): string | null {
  if (depth >= MAX_DEPTH) {
    return null;
  }
  if (typeof value === 'string' && value.length + 2 > maxLength) {
    return null;
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && String(value).length > maxLength) return null;
    const serialized = JSON.stringify(value);
    return serialized !== undefined && serialized.length <= maxLength ? serialized : null;
  }
  if (Array.isArray(value)) {
    let serialized = '[';
    for (const child of value) {
      if (serialized.length > 1) serialized += ',';
      const part = canonicalCompound(child, maxLength - serialized.length - 1, depth + 1);
      if (part === null) return null;
      serialized += part;
    }
    return serialized.length + 1 <= maxLength ? `${serialized}]` : null;
  }
  let serialized = '{';
  for (const key of Object.keys(value).sort()) {
    if (serialized.length > 1) serialized += ',';
    if (key.length + 3 > maxLength - serialized.length) return null;
    const field = `${JSON.stringify(key)}:`;
    const child = canonicalCompound(
      (value as Record<string, unknown>)[key],
      maxLength - serialized.length - field.length - 1,
      depth + 1
    );
    if (child === null) {
      return null;
    }
    serialized += field + child;
  }
  return serialized.length + 1 <= maxLength ? `${serialized}}` : null;
}

function collectWriteOnlyScalars(
  schemaValue: unknown,
  input: unknown,
  privateStrings: Set<string>,
  privateNumbers: Set<number>,
  privateCompounds: Set<string>,
  carried: { value: boolean },
  depth = 0
): void {
  if (depth >= MAX_DEPTH) {
    throw McpErrorFactory.invalidParams(
      `Write-only schema exceeds maximum nesting depth (${MAX_DEPTH})`
    );
  }
  const schema = asSchema(schemaValue);
  if (!schema) {
    return;
  }
  const arrayShaped =
    schema.items !== undefined ||
    Array.isArray(schema.prefixItems) ||
    schema.type === 'array' ||
    (Array.isArray(schema.type) && schema.type.includes('array'));
  if (schema.writeOnly === true) {
    carried.value = true;
    collectScalarLeaves(input, privateStrings, privateNumbers, new WeakSet<object>(), depth);
    if (
      arrayShaped &&
      (typeof input === 'string' || (typeof input === 'number' && Number.isFinite(input)))
    ) {
      for (const part of splitWordPressArray(input)) {
        privateStrings.add(part);
      }
    }
    if (input !== null && typeof input === 'object') {
      const signature = canonicalCompound(input);
      if (signature !== null) {
        privateCompounds.add(signature);
      }
    }
    return;
  }

  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const properties = asSchema(schema.properties);
    if (properties) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          collectWriteOnlyScalars(
            childSchema,
            (input as Record<string, unknown>)[key],
            privateStrings,
            privateNumbers,
            privateCompounds,
            carried,
            depth + 1
          );
        }
      }
    }
    const patterns = asSchema(schema.patternProperties);
    if (patterns) {
      for (const childSchema of Object.values(patterns)) {
        for (const child of Object.values(input)) {
          collectWriteOnlyScalars(
            childSchema,
            child,
            privateStrings,
            privateNumbers,
            privateCompounds,
            carried,
            depth + 1
          );
        }
      }
    }
    const additional = asSchema(schema.additionalProperties);
    if (additional) {
      for (const [key, child] of Object.entries(input)) {
        if (!properties || !Object.prototype.hasOwnProperty.call(properties, key)) {
          collectWriteOnlyScalars(
            additional,
            child,
            privateStrings,
            privateNumbers,
            privateCompounds,
            carried,
            depth + 1
          );
        }
      }
    }
  }

  let list: unknown[] | undefined;
  if (Array.isArray(input)) {
    list = input;
  } else if (arrayShaped) {
    if (typeof input === 'string' || (typeof input === 'number' && Number.isFinite(input))) {
      list = splitWordPressArray(input);
    } else if (input !== null && typeof input === 'object') {
      list = Object.values(input);
    }
  }
  if (list) {
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((childSchema, index) => {
        if (index < list.length) {
          collectWriteOnlyScalars(
            childSchema,
            list[index],
            privateStrings,
            privateNumbers,
            privateCompounds,
            carried,
            depth + 1
          );
        }
      });
    }
    if (schema.items !== undefined) {
      for (const child of list) {
        collectWriteOnlyScalars(
          schema.items,
          child,
          privateStrings,
          privateNumbers,
          privateCompounds,
          carried,
          depth + 1
        );
      }
    }
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        collectWriteOnlyScalars(
          branch,
          input,
          privateStrings,
          privateNumbers,
          privateCompounds,
          carried,
          depth + 1
        );
      }
    }
  }
}

/** Build a call-scoped redactor from an Ability input schema and caller input. */
export function createWriteOnlyRedactor(
  inputSchema: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined
): WriteOnlyRedactor {
  const privateStrings = new Set<string>();
  const privateNumbers = new Set<number>();
  const privateCompounds = new Set<string>();
  const carried = { value: false };
  if (input !== undefined) {
    collectWriteOnlyScalars(
      inputSchema,
      input,
      privateStrings,
      privateNumbers,
      privateCompounds,
      carried
    );
  }

  // Values shorter than MIN_REDACTED_LENGTH are skipped: matching "0" or "ok"
  // wherever it appears mangles unrelated counts, revisions and keys, and a
  // value that short carries almost no secrecy. An equal parsed writeOnly
  // object is still caught by the compound signature.
  const redactedStrings = [...privateStrings].filter(value => value.length >= MIN_REDACTED_LENGTH);
  const redactedNumbers = new Set(
    [...privateNumbers].filter(value => String(value).length >= MIN_REDACTED_LENGTH)
  );
  // An all-digit string is matched like a number at alphanumeric boundaries in
  // text. Any string PHP's is_numeric accepts is also matched by value:
  // WordPress casts it for integer and number schemas, and the Dashboard can
  // echo the cast as a JSON number.
  const numericStrings = redactedStrings.filter(value => NUMERIC_STRING.test(value));
  for (const value of redactedStrings.filter(value => PHP_NUMERIC_STRING.test(value))) {
    // "0007" casts to 7, which is too short to redact without mangling output.
    const cast = Number(value.trim());
    if (Number.isFinite(cast) && String(cast).length >= MIN_REDACTED_LENGTH) {
      redactedNumbers.add(cast);
    }
  }
  const orderedStrings = redactedStrings
    .filter(value => !NUMERIC_STRING.test(value))
    .sort((left, right) => right.length - left.length);
  let maxCompoundLength = 0;
  for (const signature of privateCompounds) {
    maxCompoundLength = Math.max(maxCompoundLength, signature.length);
  }
  const numberForms = [...new Set([...[...redactedNumbers].map(String), ...numericStrings])].sort(
    (left, right) => right.length - left.length
  );
  const numberPatterns = numberForms.map(
    form =>
      new RegExp(
        `(?<![0-9A-Za-z])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`,
        'g'
      )
  );
  const privateKeys = new Set([...redactedStrings, ...[...redactedNumbers].map(String)]);

  const text = (value: string): string => {
    let redacted = value;
    for (const form of orderedStrings) {
      redacted = redacted.split(form).join(REDACTED);
    }
    for (const pattern of numberPatterns) {
      redacted = redacted.replace(pattern, REDACTED);
    }
    return redacted;
  };

  const privateForms = [
    ...new Set([...redactedStrings, ...numberForms].map(form => form.toLowerCase())),
  ];
  const mentions = (value: string): boolean => {
    const lowered = value.toLowerCase();
    return privateForms.some(form => lowered.includes(form));
  };

  const hasPrivateValues =
    orderedStrings.length > 0 || numberPatterns.length > 0 || privateCompounds.size > 0;

  const deep = (value: unknown, depth = 0): unknown => {
    if (!hasPrivateValues) {
      return value;
    }
    if (depth >= MAX_DEPTH) {
      return DEPTH_LIMIT_MARKER;
    }
    if (typeof value === 'string') {
      return text(value);
    }
    if (typeof value === 'number') {
      return redactedNumbers.has(value) ? REDACTED : value;
    }
    if (value === null || typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'object') {
      return value;
    }
    // Canonicalizing stringifies the whole subtree, so skip it when there is
    // no writeOnly object to compare against.
    if (privateCompounds.size > 0) {
      const signature = canonicalCompound(value, maxCompoundLength);
      if (signature !== null && privateCompounds.has(signature)) {
        return REDACTED;
      }
    }
    if (Array.isArray(value)) {
      return value.map(child => deep(child, depth + 1));
    }
    // Keys are field names, so only a key that is itself a private value is
    // replaced; substring matching here rewrote names like lookup_token.
    // fromEntries defines own properties, so a __proto__ key cannot reach the prototype.
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        privateKeys.has(key) ? REDACTED : key,
        deep(child, depth + 1),
      ])
    );
  };

  return { carriesWriteOnly: carried.value, text, mentions, deep };
}
