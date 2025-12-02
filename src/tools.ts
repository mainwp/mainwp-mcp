/**
 * MCP Tool Conversion
 *
 * Converts MainWP Abilities to MCP Tool definitions and handles
 * tool execution by forwarding to the Abilities API.
 */

import { Tool, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { Ability, fetchAbilities, executeAbility } from './abilities.js';
import { Config } from './config.js';

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
 */
function abilityToTool(ability: Ability): Tool {
  // Create a tool name from the ability name
  // e.g., "mainwp/list-sites-v1" -> "mainwp_list_sites_v1"
  const toolName = ability.name.replace(/\//g, '_').replace(/-/g, '_');

  // Build description with annotations
  let description = ability.description;
  const annotations = ability.meta?.annotations;

  if (annotations) {
    const notes: string[] = [];
    if (annotations.readonly) notes.push('Read-only');
    if (annotations.destructive) notes.push('DESTRUCTIVE');
    if (!annotations.idempotent) notes.push('Not idempotent');
    if (annotations.instructions) notes.push(annotations.instructions);

    if (notes.length > 0) {
      description += ` [${notes.join(', ')}]`;
    }
  }

  return {
    name: toolName,
    description,
    inputSchema: convertInputSchema(ability),
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
 * Map MCP tool name back to ability name
 * e.g., "mainwp_list_sites_v1" -> "mainwp/list-sites-v1"
 */
function toolNameToAbilityName(toolName: string): string {
  // First underscore becomes slash, rest become hyphens
  const parts = toolName.split('_');
  if (parts.length < 2) {
    throw new Error(`Invalid tool name format: ${toolName}`);
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
  args: Record<string, unknown>
): Promise<TextContent[]> {
  try {
    const abilityName = toolNameToAbilityName(toolName);
    const result = await executeAbility(config, abilityName, args);

    // Format the result as JSON for the AI to parse
    const formattedResult = JSON.stringify(result, null, 2);

    return [
      {
        type: 'text',
        text: formattedResult,
      },
    ];
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return [
      {
        type: 'text',
        text: JSON.stringify({
          error: true,
          message: errorMessage,
        }, null, 2),
      },
    ];
  }
}
