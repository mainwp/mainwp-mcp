/**
 * MCP Tool Conversion
 *
 * Converts MainWP Abilities to MCP Tool definitions and handles
 * tool execution by forwarding to the Abilities API.
 */

import { Tool, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { Ability, fetchAbilities, executeAbility } from './abilities.js';
import { Config } from './config.js';
import { validateInput, sanitizeError } from './security.js';
import { McpErrorFactory, formatErrorResponse } from './errors.js';

/**
 * Options for tool execution
 */
export interface ExecuteToolOptions {
  /** AbortSignal for cancellation support */
  signal?: AbortSignal;
}

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
  const properties = (schema.properties || {}) as { [key: string]: object };
  const required = (schema.required as string[]) || [];

  return {
    type: 'object' as const,
    properties,
    required,
  };
}

/**
 * Convert a MainWP Ability to an MCP Tool definition
 *
 * Enhances tool metadata with:
 * - MCP semantic annotations (readOnlyHint, destructiveHint, idempotentHint)
 * - Highlighted safety parameters (dry_run, confirm) in descriptions
 */
function abilityToTool(ability: Ability): Tool {
  // Create a tool name from the ability name
  // e.g., "mainwp/list-sites-v1" -> "mainwp_list_sites_v1"
  const toolName = abilityNameToToolName(ability.name);
  const meta = ability.meta?.annotations;
  const inputSchema = convertInputSchema(ability);

  // Build description with safety hints
  let description = ability.description;

  // Add custom instructions from annotations if present
  if (meta?.instructions) {
    description += ` ${meta.instructions}`;
  }

  // Detect safety parameters in schema
  const props = (inputSchema.properties || {}) as Record<string, object>;
  const hasDryRun = 'dry_run' in props;
  const hasConfirm = 'confirm' in props;

  // Build description tags based on tool characteristics
  if (meta?.destructive) {
    // Destructive tools: highlight safety requirements prominently
    const hints: string[] = [];
    if (hasConfirm) hints.push('Requires confirm: true');
    if (hasDryRun) hints.push('Supports dry_run');
    if (!meta.idempotent) hints.push('Not idempotent');
    if (hints.length > 0) {
      description += ` [DESTRUCTIVE, ${hints.join(', ')}]`;
    } else {
      description += ' [DESTRUCTIVE]';
    }
  } else {
    // Non-destructive tools: note available features
    const notes: string[] = [];
    if (hasDryRun) notes.push('Supports dry_run');
    if (meta?.readonly) notes.push('Read-only');
    if (notes.length > 0) {
      description += ` [${notes.join(', ')}]`;
    }
  }

  return {
    name: toolName,
    description,
    inputSchema,
    // MCP semantic annotations for client UI hints
    annotations: meta ? {
      readOnlyHint: meta.readonly,
      destructiveHint: meta.destructive,
      idempotentHint: meta.idempotent,
    } : undefined,
  };
}

/**
 * Fetch all MainWP abilities and convert them to MCP tools
 */
export async function getTools(config: Config): Promise<Tool[]> {
  const abilities = await fetchAbilities(config);
  return abilities.map(abilityToTool);
}

/**
 * Convert ability name to MCP tool name
 * e.g., "mainwp/list-sites-v1" -> "mainwp_list_sites_v1"
 */
export function abilityNameToToolName(abilityName: string): string {
  return abilityName.replace(/\//g, '_').replace(/-/g, '_');
}

/**
 * Map MCP tool name back to ability name
 * e.g., "mainwp_list_sites_v1" -> "mainwp/list-sites-v1"
 */
export function toolNameToAbilityName(toolName: string): string {
  // First underscore becomes slash, rest become hyphens
  const parts = toolName.split('_');
  if (parts.length < 2) {
    throw McpErrorFactory.invalidParams(
      `Invalid tool name format: ${toolName}`,
      { tool: toolName }
    );
  }

  const namespace = parts[0];
  const rest = parts.slice(1).join('-');
  return `${namespace}/${rest}`;
}

/**
 * Execute an MCP tool call by forwarding to the corresponding ability
 */
export async function executeTool(
  config: Config,
  toolName: string,
  args: Record<string, unknown>,
  options?: ExecuteToolOptions
): Promise<TextContent[]> {
  try {
    // Check for cancellation before starting
    if (options?.signal?.aborted) {
      throw McpErrorFactory.cancelled();
    }

    // Validate input before forwarding to API
    validateInput(args);

    const abilityName = toolNameToAbilityName(toolName);
    const result = await executeAbility(config, abilityName, args);

    // Check for cancellation after execution
    if (options?.signal?.aborted) {
      throw McpErrorFactory.cancelled();
    }

    // Format the result as JSON for the AI to parse
    const formattedResult = JSON.stringify(result, null, 2);

    return [
      {
        type: 'text',
        text: formattedResult,
      },
    ];
  } catch (error) {
    // Use standardized error format with code
    return [
      {
        type: 'text',
        text: formatErrorResponse(error, sanitizeError),
      },
    ];
  }
}
