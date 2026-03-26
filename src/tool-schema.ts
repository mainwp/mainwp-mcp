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
  const schema = ability.input_schema;

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
  const properties = (schema.properties || {}) as { [key: string]: Record<string, unknown> };
  const required = (schema.required as string[]) || [];

  // Backfill missing descriptions from parameter names.
  // Some upstream abilities omit descriptions; LLMs need them for accurate tool use.
  for (const [name, prop] of Object.entries(properties)) {
    if (prop && (!prop.description || String(prop.description).trim() === '')) {
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

/**
 * Truncate a description to the first sentence or ~60 characters
 *
 * Strategy:
 * - Preserve full description if already ≤60 characters
 * - Return first sentence if it's within limit (≤65 chars, small tolerance)
 * - Otherwise truncate to 57 characters with ellipsis
 */
function truncateDescription(description: string | undefined | null): string {
  if (!description) {
    return '';
  }

  // If already short enough, return as-is
  if (description.length <= 60) {
    return description;
  }

  // Try to find first sentence boundary
  const sentenceMatch = description.match(/^[^.!?]+[.!?](?:\s|$)/);
  if (sentenceMatch) {
    const sentence = sentenceMatch[0].trim();
    // Only use sentence if it's within limit (allow small tolerance of 5 chars)
    if (sentence.length <= 65) {
      return sentence;
    }
  }

  // No suitable sentence found, truncate to ~60 chars
  return description.slice(0, 57) + '...';
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
export function abilityToTool(ability: Ability, verbosity: SchemaVerbosity = 'standard'): Tool {
  // Create a tool name from the ability name
  // e.g., "mainwp/list-sites-v1" -> "mainwp_list_sites_v1"
  const toolName = abilityNameToToolName(ability.name);
  const meta = ability.meta?.annotations;
  let inputSchema = convertInputSchema(ability);

  // Detect safety parameters in schema (before compression, needed for user_confirmed injection)
  const props = (inputSchema.properties || {}) as Record<string, object>;
  const hasDryRun = 'dry_run' in props;
  const hasConfirm = 'confirm' in props;
  const isDestructive = meta?.destructive ?? false;

  // Add user_confirmed parameter for destructive tools with confirm parameter
  // This must happen BEFORE schema compression so it applies to all verbosity modes
  if (isDestructive && hasConfirm) {
    const mutableProps = inputSchema.properties as Record<string, object>;
    mutableProps['user_confirmed'] = {
      type: 'boolean',
      description:
        'Confirm execution after reviewing preview. ' +
        'FLOW: 1) confirm:true for preview, 2) show user, 3) user_confirmed:true if approved.',
    };
  }

  // Apply schema compression in compact mode (after user_confirmed injection)
  if (verbosity === 'compact') {
    inputSchema = compressSchema(inputSchema as Record<string, unknown>) as Tool['inputSchema'];
  }

  // Build description with safety context
  let description: string;

  if (verbosity === 'standard') {
    // Category prefix for standard mode (e.g., "[sites] ...")
    const categoryLabel = ability.category?.replace(/^mainwp-/, '').replace(/-/g, ' ');
    description = categoryLabel ? `[${categoryLabel}] ${ability.description}` : ability.description;

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

    // Append confirmation workflow for destructive tools with confirm parameter
    if (isDestructive && hasConfirm) {
      description +=
        '\n\nCONFIRMATION FLOW: ' +
        '1) Call with confirm:true to preview what will be affected. ' +
        '2) Show preview to user and ask for confirmation. ' +
        '3) If confirmed, call again with user_confirmed:true to execute. ' +
        'Do NOT set user_confirmed:true without explicit user consent.';
    }
  } else {
    // Compact mode: truncated description + short safety tags
    description = truncateDescription(ability.description);
    const tags = buildSafetyTags(meta, hasDryRun, hasConfirm, 'compact');
    if (tags) {
      description += ` ${tags}`;
    }
    if (isDestructive && hasConfirm) {
      description += ' FLOW: confirm:true -> preview -> user_confirmed:true + confirmation_token';
    }
  }

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
