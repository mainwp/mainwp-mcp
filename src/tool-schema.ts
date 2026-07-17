/**
 * Tool Schema Conversion
 *
 * Converts MainWP Abilities into MCP Tool definitions with schema compression,
 * safety annotations, and LLM instruction generation.
 * All functions are pure — no module-level state.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Ability, AbilityAnnotations } from './abilities.js';
import type { SchemaVerbosity } from './config.js';
import { abilityNameToToolName } from './naming.js';

/**
 * Convert an Ability's JSON Schema to MCP tool input schema format
 *
 * The Abilities API uses standard JSON Schema, which maps directly to
 * MCP's tool input schema (also JSON Schema based).
 */
function convertInputSchema(ability: Ability): Tool['inputSchema'] {
  const schema = ability.input_schema ? structuredClone(ability.input_schema) : undefined;

  if (!schema) {
    // No input required
    return {
      type: 'object' as const,
      properties: {},
    };
  }

  // The abilities API uses JSON Schema, which is compatible with MCP
  // We just need to ensure it has the required structure
  // Cast to the expected MCP SDK type
  //
  // PHP dashboards serialize empty associative arrays as [] — an array-typed
  // `properties` (or malformed `required`) invalidates the whole tools/list
  // response for spec-compliant clients, so coerce anything non-conforming.
  const rawProperties = schema.properties;
  const rawPropertyMap = (
    rawProperties && typeof rawProperties === 'object' && !Array.isArray(rawProperties)
      ? rawProperties
      : {}
  ) as Record<string, unknown>;
  // Sanitize each property too: a primitive or array value would throw on the
  // description backfill below, failing the whole tools/list response instead
  // of isolating one malformed property.
  const properties: { [key: string]: Record<string, unknown> } = {};
  for (const [name, prop] of Object.entries(rawPropertyMap)) {
    properties[name] =
      prop !== null && typeof prop === 'object' && !Array.isArray(prop)
        ? (prop as Record<string, unknown>)
        : {};
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];

  // Backfill missing descriptions from parameter names.
  // Some upstream abilities omit descriptions; LLMs need them for accurate tool use.
  for (const [name, prop] of Object.entries(properties)) {
    if (!prop.description || String(prop.description).trim() === '') {
      prop.description = paramNameToDescription(name);
    }
  }

  return {
    type: 'object' as const,
    properties,
    required,
  };
}

/**
 * Generate a human-readable description from a parameter name.
 * "client_id_or_email" → "Client ID or email."
 * "address_1" → "Address 1."
 */
function paramNameToDescription(name: string): string {
  const words = name.replace(/_/g, ' ').replace(/\bid\b/gi, 'ID');
  return words.charAt(0).toUpperCase() + words.slice(1) + '.';
}

/** Descriptions at or under this length are kept as-is */
const TARGET_DESC_LENGTH = 60;
/** A first sentence may exceed the target by this small tolerance */
const SENTENCE_TOLERANCE = 5;
/** Hard-truncate length; +3 for the ellipsis lands near the target */
const HARD_TRUNCATE_LENGTH = TARGET_DESC_LENGTH - 3;

/**
 * Truncate a description to the first sentence or ~TARGET_DESC_LENGTH characters
 *
 * Strategy:
 * - Preserve full description if already within the target length
 * - Return first sentence if it's within target + tolerance
 * - Otherwise hard-truncate with ellipsis
 */
function truncateDescription(description: string | undefined | null): string {
  if (!description) {
    return '';
  }

  // If already short enough, return as-is
  if (description.length <= TARGET_DESC_LENGTH) {
    return description;
  }

  // Try to find first sentence boundary
  const sentenceMatch = description.match(/^[^.!?]+[.!?](?:\s|$)/);
  if (sentenceMatch) {
    const sentence = sentenceMatch[0].trim();
    if (sentence.length <= TARGET_DESC_LENGTH + SENTENCE_TOLERANCE) {
      return sentence;
    }
  }

  // No suitable sentence found
  return description.slice(0, HARD_TRUNCATE_LENGTH) + '...';
}

/**
 * Recursively compress a JSON Schema by truncating descriptions
 *
 * Preserves critical fields: type, enum, items, default, minimum, maximum, required, format
 * Removes: examples field
 */
function compressSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // If no properties field, return schema as-is
  if (!schema.properties || typeof schema.properties !== 'object') {
    return schema;
  }

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const compressedProperties: Record<string, Record<string, unknown>> = {};

  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object') {
      compressedProperties[key] = prop;
      continue;
    }

    // Create compressed property, preserving critical fields
    const compressedProp: Record<string, unknown> = {};

    // Always preserve these critical fields
    const criticalFields = [
      'type',
      'enum',
      'default',
      'minimum',
      'maximum',
      'format',
      'required',
      'minItems',
      'maxItems',
      'minLength',
      'maxLength',
      'pattern',
    ];
    for (const field of criticalFields) {
      if (field in prop) {
        compressedProp[field] = prop[field];
      }
    }

    // Truncate description
    if (typeof prop.description === 'string') {
      compressedProp.description = truncateDescription(prop.description);
    }

    // Handle items (for arrays) - recursively compress if it has properties
    if (prop.items && typeof prop.items === 'object') {
      const items = prop.items as Record<string, unknown>;
      if (items.properties) {
        compressedProp.items = compressSchema(items);
      } else {
        // Simple items (e.g., { type: 'string' })
        compressedProp.items = items;
      }
    }

    // Handle nested properties (for objects) - recursively compress
    if (prop.properties && typeof prop.properties === 'object') {
      const nested = compressSchema(prop as Record<string, unknown>);
      compressedProp.properties = nested.properties;
      if (nested.required) {
        compressedProp.required = nested.required;
      }
    }

    // Note: 'examples' field is intentionally NOT copied (removed in compact mode)

    compressedProperties[key] = compressedProp;
  }

  return {
    ...schema,
    properties: compressedProperties,
  };
}

/**
 * Generate contextual LLM instruction text from ability metadata.
 *
 * Produces safety guidance that tells the AI how to use a tool correctly:
 * preview-first workflows, dry-run suggestions, or read-only assurance.
 * API-provided instructions are prepended (they take priority).
 * @internal
 */
export function generateInstructions(
  meta: AbilityAnnotations | undefined,
  hasDryRun: boolean,
  hasConfirm: boolean
): string {
  const parts: string[] = [];

  // API-provided instructions take priority (ensure trailing punctuation for clean concatenation)
  if (meta?.instructions) {
    const instr = meta.instructions;
    parts.push(/[.!?]$/.test(instr) ? instr : `${instr}.`);
  }

  if (meta?.destructive) {
    if (hasConfirm && hasDryRun) {
      parts.push('Always preview with dry_run or confirm before executing. Show preview to user.');
    } else {
      parts.push('This is destructive. Confirm intent with user first.');
    }
    if (!meta.idempotent) {
      parts.push('Not idempotent — repeating may cause different results.');
    }
  } else if (meta?.readonly) {
    parts.push('Read-only. Safe to call without confirmation.');
  } else {
    parts.push('Write operation.');
  }

  return parts.join(' ');
}

/**
 * Build safety tag string for tool descriptions.
 *
 * Standard mode: verbose tags like `[DESTRUCTIVE, Requires two-step confirmation]`
 * Compact mode:  short tags like `[destructive, confirm]`
 * @internal
 */
export function buildSafetyTags(
  meta: AbilityAnnotations | undefined,
  hasDryRun: boolean,
  hasConfirm: boolean,
  verbosity: SchemaVerbosity
): string {
  if (verbosity === 'standard') {
    if (meta?.destructive) {
      const hints: string[] = [];
      if (hasConfirm) hints.push('Requires two-step confirmation');
      if (hasDryRun) hints.push('Supports dry_run');
      if (!meta.idempotent) hints.push('Not idempotent');
      return hints.length > 0 ? `[DESTRUCTIVE, ${hints.join(', ')}]` : '[DESTRUCTIVE]';
    }
    const notes: string[] = [];
    if (hasDryRun) notes.push('Supports dry_run');
    if (meta?.readonly) notes.push('Read-only');
    return notes.length > 0 ? `[${notes.join(', ')}]` : '';
  }

  // Compact mode — short tags
  const tags: string[] = [];
  if (meta?.destructive) tags.push('destructive');
  if (hasConfirm) tags.push('confirm');
  if (hasDryRun) tags.push('dry_run');
  return tags.length > 0 ? `[${tags.join(', ')}]` : '';
}

/**
 * Build the full-detail tool description for standard verbosity:
 * category prefix, full ability description, contextual LLM instructions,
 * safety tags, and the two-phase confirmation workflow.
 */
function buildStandardDescription(
  ability: Ability,
  meta: AbilityAnnotations | undefined,
  hasDryRun: boolean,
  hasConfirm: boolean,
  isDestructive: boolean
): string {
  // Category prefix (e.g., "[sites] ...")
  const categoryLabel = ability.category?.replace(/^mainwp-/, '').replace(/-/g, ' ');
  let description = categoryLabel
    ? `[${categoryLabel}] ${ability.description}`
    : ability.description;

  // Append contextual LLM instructions
  const instructions = generateInstructions(meta, hasDryRun, hasConfirm);
  if (instructions) {
    description += ` ${instructions}`;
  }

  // Append safety tags
  const tags = buildSafetyTags(meta, hasDryRun, hasConfirm, 'standard');
  if (tags) {
    description += ` ${tags}`;
  }

  // Append confirmation workflow for destructive tools with confirm parameter.
  // Only promise a preview when the ability declares dry_run — confirm-only
  // abilities issue a token without an upstream preview call.
  if (isDestructive && hasConfirm) {
    description +=
      '\n\nCONFIRMATION FLOW: ' +
      (hasDryRun
        ? '1) Call with confirm:true to preview what will be affected. ' +
          '2) Show preview to user and ask for confirmation. '
        : '1) Call with confirm:true to receive a confirmation token (no preview available). ' +
          '2) Ask the user for confirmation. ') +
      '3) If confirmed, call again with user_confirmed:true and the confirmation_token ' +
      'from the first response to execute. ' +
      'Do NOT set user_confirmed:true without explicit user consent.';
  }

  return description;
}

/**
 * Build the token-lean tool description for compact verbosity:
 * truncated description, short safety tags, one-line confirm flow.
 */
function buildCompactDescription(
  ability: Ability,
  meta: AbilityAnnotations | undefined,
  hasDryRun: boolean,
  hasConfirm: boolean,
  isDestructive: boolean
): string {
  let description = truncateDescription(ability.description);
  const tags = buildSafetyTags(meta, hasDryRun, hasConfirm, 'compact');
  if (tags) {
    description += ` ${tags}`;
  }
  if (isDestructive && hasConfirm) {
    description += ' FLOW: confirm:true -> preview -> user_confirmed:true + confirmation_token';
  }
  return description;
}

/**
 * Convert a MainWP Ability to an MCP Tool definition
 *
 * Enhances tool metadata with:
 * - MCP semantic annotations (readOnlyHint, destructiveHint, idempotentHint, title, openWorldHint)
 * - Contextual LLM instructions for safe tool usage
 * - Highlighted safety parameters (dry_run, confirm) in descriptions
 *
 * @param ability - The MainWP ability to convert
 * @param verbosity - Schema verbosity level ('compact' or 'standard')
 */
export function abilityToTool(
  ability: Ability,
  primaryNamespace: string,
  verbosity: SchemaVerbosity = 'standard'
): Tool {
  // e.g., 'mainwp/list-sites-v1' + primary='mainwp' -> 'list_sites_v1'
  //       'acme/do-thing-v1'   + primary='mainwp' -> 'acme__do_thing_v1'
  const toolName = abilityNameToToolName(ability.name, primaryNamespace);
  const meta = ability.meta?.annotations;
  let inputSchema = convertInputSchema(ability);

  // Detect safety parameters in schema (before compression, needed for user_confirmed injection)
  const props = (inputSchema.properties || {}) as Record<string, object>;
  const hasDryRun = 'dry_run' in props;
  const hasConfirm = 'confirm' in props;
  const isDestructive = meta?.destructive ?? false;

  // Add user_confirmed and confirmation_token parameters for destructive tools
  // with a confirm parameter. Both must be declared: confirmed execution is
  // token-bound, and a schema-validating client (or upstream
  // additionalProperties: false) would otherwise reject the token it is
  // required to send. This must happen BEFORE schema compression so it applies
  // to all verbosity modes.
  if (isDestructive && hasConfirm) {
    const mutableProps = inputSchema.properties as Record<string, object>;
    mutableProps['user_confirmed'] = {
      type: 'boolean',
      description:
        'Confirm execution after user approval. ' +
        'FLOW: 1) confirm:true, 2) show result to user, ' +
        '3) user_confirmed:true + confirmation_token if approved.',
    };
    mutableProps['confirmation_token'] = {
      type: 'string',
      description:
        'Token issued by the confirm:true response; required alongside user_confirmed:true.',
    };
  }

  // Apply schema compression in compact mode (after user_confirmed injection)
  if (verbosity === 'compact') {
    inputSchema = compressSchema(inputSchema as Record<string, unknown>) as Tool['inputSchema'];
  }

  // Build description with safety context
  const description =
    verbosity === 'standard'
      ? buildStandardDescription(ability, meta, hasDryRun, hasConfirm, isDestructive)
      : buildCompactDescription(ability, meta, hasDryRun, hasConfirm, isDestructive);

  return {
    name: toolName,
    description,
    inputSchema,
    // MCP semantic annotations for client UI hints (always included regardless of verbosity)
    annotations: meta
      ? {
          title: ability.label || undefined,
          readOnlyHint: meta.readonly,
          destructiveHint: meta.destructive,
          idempotentHint: meta.idempotent,
          openWorldHint: true,
        }
      : undefined,
  };
}
