/**
 * Help Documentation Generation
 *
 * Generates structured help documents from MainWP ability metadata.
 * Purely functional — no state, no side effects.
 */

import { abilityNameToToolName } from './naming.js';
import { declaresUsableBooleanParam } from './policy.js';
import type { Ability } from './abilities.js';

/**
 * Help documentation for a single tool
 */
export interface ToolHelp {
  toolName: string;
  abilityName: string;
  label: string;
  description: string;
  category: string;
  annotations: {
    readonly: boolean;
    destructive: boolean;
    idempotent: boolean;
    instructions?: string;
  };
  safetyFeatures: {
    supportsDryRun: boolean;
    requiresConfirm: boolean;
  };
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
  }>;
}

/**
 * Complete help document structure
 */
export interface HelpDocument {
  version: string;
  generated: string;
  overview: {
    totalTools: number;
    categories: string[];
    safetyConventions: Record<string, string>;
  };
  destructiveTools: string[];
  toolsWithDryRun: string[];
  toolsRequiringConfirm: string[];
  toolsByCategory: Record<string, ToolHelp[]>;
}

/**
 * Coerce a remote schema property's `type` into a display string.
 *
 * Remote schemas are hostile (abilities.ts bounds their string lengths but not
 * their JSON types): `type` may be any JSON value. A string passes through
 * (matching the previous `String(prop.type || 'unknown')`); a JSON Schema type
 * array such as `['integer', 'string']` joins its string members (also matching
 * the previous `String([...])`); any other shape falls back to 'unknown'
 * instead of rendering something like '[object Object]'.
 */
function coerceParamType(type: unknown): string {
  if (typeof type === 'string') {
    return type || 'unknown';
  }
  if (Array.isArray(type)) {
    const names = type.filter((entry): entry is string => typeof entry === 'string');
    if (names.length > 0) {
      return names.join(',');
    }
  }
  return 'unknown';
}

/**
 * Generate help documentation for a single ability
 */
function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function generateToolHelp(ability: Ability, primaryNamespace: string): ToolHelp {
  const toolName = abilityNameToToolName(ability.name, primaryNamespace);
  // Remote properties can be any JSON shape: the container may be an array or
  // primitive, and each entry may be null/primitive/array — bare-casting made
  // prop.type below throw on the first malformed entry. Normalize to safe
  // records. Null prototype so a remote "__proto__" key cannot hit the
  // prototype setter and vanish (or pollute).
  const rawProps: unknown = ability.input_schema?.properties;
  const props: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  if (isSchemaRecord(rawProps)) {
    for (const [name, value] of Object.entries(rawProps)) {
      props[name] = isSchemaRecord(value) ? value : {};
    }
  }
  // Remote schema fields are hostile: `required` can arrive as any JSON type.
  // Bare-casting to string[] and calling .includes() throws TypeError on a
  // truthy non-array (42, {}, true), which would abort the whole help document.
  // Mirror tool-schema.ts's convertInputSchema — treat it as unknown and keep
  // only the string entries — so help and ListTools agree on the required set.
  const rawRequired: unknown = ability.input_schema?.required;
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const parameters = Object.entries(props).map(([name, prop]) => ({
    name,
    type: coerceParamType(prop.type),
    required: required.includes(name),
    description: typeof prop.description === 'string' ? prop.description : undefined,
  }));

  return {
    toolName,
    abilityName: ability.name,
    label: ability.label,
    description: ability.description,
    category: ability.category,
    annotations: {
      readonly: ability.meta?.annotations?.readonly ?? false,
      destructive: ability.meta?.annotations?.destructive ?? true,
      idempotent: ability.meta?.annotations?.idempotent ?? false,
      instructions: ability.meta?.annotations?.instructions,
    },
    safetyFeatures: {
      // RAW properties, not the normalized map: normalization turns a `false`
      // or malformed entry into {}, and {} accepts anything — help would then
      // advertise dry_run/confirm that execution (which reads raw) refuses.
      supportsDryRun: declaresUsableBooleanParam(rawProps, 'dry_run'),
      requiresConfirm: declaresUsableBooleanParam(rawProps, 'confirm'),
    },
    parameters,
  };
}

/**
 * Generate complete help document from all abilities
 */
export function generateHelpDocument(abilities: Ability[], primaryNamespace: string): HelpDocument {
  // Isolate per-ability failures: even with the field-level guards in
  // generateToolHelp, one hostile ability must degrade to being omitted from
  // the document rather than throwing and taking down help for the ENTIRE
  // catalog (while ListTools keeps advertising it). No logging here — this
  // module is pure by contract; the fetch boundary already warns on the
  // malformed metadata that gets this far.
  const toolHelps: ToolHelp[] = [];
  for (const ability of abilities) {
    try {
      toolHelps.push(generateToolHelp(ability, primaryNamespace));
    } catch {
      // Skip only the offending ability; the rest of the catalog stays documented.
    }
  }
  const normalizeCategory = (c: string | undefined) => c?.trim() || 'uncategorized';

  const categories = [...new Set(toolHelps.map(h => normalizeCategory(h.category)))].sort();

  const toolsByCategory: Record<string, ToolHelp[]> = {};
  for (const help of toolHelps) {
    const cat = normalizeCategory(help.category);
    if (!toolsByCategory[cat]) toolsByCategory[cat] = [];
    toolsByCategory[cat].push(help);
  }

  return {
    version: '1.0',
    generated: new Date().toISOString(),
    overview: {
      // Count what was actually documented, so a skipped malformed ability
      // does not overstate the catalog. Equals abilities.length for a
      // well-formed catalog where every ability generates help.
      totalTools: toolHelps.length,
      categories,
      safetyConventions: {
        dryRun: 'Pass dry_run: true to preview the operation without making changes',
        confirm:
          'Pass confirm: true to begin the confirmation flow for destructive operations; execution requires a follow-up call with user_confirmed: true and the issued confirmation_token',
        destructive: 'These tools can permanently delete or modify data',
        readonly: 'These tools only read data and never modify anything',
      },
    },
    destructiveTools: toolHelps.filter(h => h.annotations.destructive).map(h => h.toolName),
    toolsWithDryRun: toolHelps.filter(h => h.safetyFeatures.supportsDryRun).map(h => h.toolName),
    toolsRequiringConfirm: toolHelps
      .filter(h => h.safetyFeatures.requiresConfirm)
      .map(h => h.toolName),
    toolsByCategory,
  };
}
