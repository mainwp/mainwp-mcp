/**
 * MCP Tool Conversion
 *
 * Converts MainWP Abilities to MCP Tool definitions and handles
 * tool execution by forwarding to the Abilities API.
 */

import { Tool, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { Ability, fetchAbilities, executeAbility, getAbility } from './abilities.js';
import { Config } from './config.js';
import { validateInput, sanitizeError } from './security.js';
import { McpErrorFactory, formatErrorResponse } from './errors.js';
import { Logger } from './logging.js';
import { abilityNameToToolName, toolNameToAbilityName } from './naming.js';

/**
 * Session-level cumulative data tracking.
 * Tracks total bytes of tool responses returned during the server's lifetime.
 *
 * Concurrency note: This module-level counter assumes MCP tool executions are
 * processed sequentially (stdio transport handles one request at a time).
 * If the architecture is later updated to support parallel tool execution,
 * this tracking should be moved to a per-session context or use synchronized
 * updates to prevent race conditions.
 */
let sessionDataBytes = 0;

/**
 * Get the current cumulative session data usage in bytes.
 */
export function getSessionDataUsage(): number {
  return sessionDataBytes;
}

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
 *
 * Applies optional filtering based on config:
 * - allowedTools: If set, only include tools in this list
 * - blockedTools: If set, exclude tools in this list
 */
export async function getTools(config: Config): Promise<Tool[]> {
  const abilities = await fetchAbilities(config);
  let tools = abilities.map(abilityToTool);
  const originalCount = tools.length;

  // Apply allowlist filter (whitelist)
  if (config.allowedTools && config.allowedTools.length > 0) {
    const allowedSet = new Set(config.allowedTools);
    tools = tools.filter(tool => allowedSet.has(tool.name));
  }

  // Apply blocklist filter (blacklist)
  if (config.blockedTools && config.blockedTools.length > 0) {
    const blockedSet = new Set(config.blockedTools);
    tools = tools.filter(tool => !blockedSet.has(tool.name));
  }

  // Log if tools were filtered
  if (tools.length !== originalCount) {
    const allowedCount = config.allowedTools?.length ?? 'all';
    const blockedCount = config.blockedTools?.length ?? 0;
    console.error(
      `[mainwp-mcp] Tool filtering: ${originalCount} → ${tools.length} tools ` +
      `(allowed: ${allowedCount}, blocked: ${blockedCount})`
    );
  }

  return tools;
}

// Re-export naming functions for backward compatibility
export { abilityNameToToolName, toolNameToAbilityName } from './naming.js';

/**
 * Execute an MCP tool call by forwarding to the corresponding ability
 */
export async function executeTool(
  config: Config,
  toolName: string,
  args: Record<string, unknown>,
  logger: Logger,
  options?: ExecuteToolOptions
): Promise<TextContent[]> {
  const startTime = performance.now();
  const hasArguments = Object.keys(args).length > 0;

  // SECURITY: Only log metadata (toolName, hasArguments boolean), never log actual
  // argument values or response content as they may contain sensitive data.
  logger.debug('Tool execution started', { toolName, hasArguments });

  try {
    // Check for cancellation before starting
    if (options?.signal?.aborted) {
      throw McpErrorFactory.cancelled();
    }

    // Validate input before forwarding to API
    validateInput(args);

    // Convert tool name to ability name
    const abilityName = toolNameToAbilityName(toolName, config.abilityNamespace);

    // Fetch ability metadata to check if destructive
    const ability = await getAbility(config, abilityName);
    if (!ability) {
      throw new Error(`Ability not found: ${abilityName}`);
    }

    // Check annotations for destructive classification
    const annotations = ability.meta?.annotations;
    const isDestructive = annotations?.destructive ?? false;
    let effectiveArgs = args;

    // Log all destructive operation attempts for audit purposes (regardless of safe mode)
    if (isDestructive) {
      logger.info('Destructive operation invoked', { toolName, abilityName, safeMode: config.safeMode });
    }

    // Safe mode handling
    if (config.safeMode) {
      // Warn if annotations are missing - can't reliably classify the ability
      if (!annotations || typeof annotations.destructive !== 'boolean') {
        logger.warning('Safe mode cannot reliably classify ability (missing annotations)', {
          toolName,
          abilityName,
          hasAnnotations: !!annotations,
        });
      }

      // Always strip confirm parameter in safe mode (defensive approach)
      if ('confirm' in args) {
        const { confirm, ...safeArgs } = args;
        effectiveArgs = safeArgs;
        logger.info('Stripped confirm parameter in safe mode', { toolName, hadConfirm: confirm });
      }

      // Block destructive operations with a clear user-visible message.
      // Note: Safe-mode early-return responses are intentionally excluded from
      // sessionDataBytes tracking. The session data limit is designed to prevent
      // runaway API responses, not small fixed-size local error messages.
      if (isDestructive) {
        logger.warning('Destructive operation blocked by safe mode', { toolName, abilityName });

        return [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'SAFE_MODE_BLOCKED',
              message: `Safe mode blocked destructive operation: ${toolName}`,
              details: {
                tool: toolName,
                ability: abilityName,
                reason: 'Destructive operations are disabled in safe mode.',
                resolution: 'To execute this operation, disable safe mode by setting MAINWP_SAFE_MODE=false or use a non-production environment.',
              },
            }, null, 2),
          },
        ];
      }
    }

    const result = await executeAbility(config, abilityName, effectiveArgs);

    // Check for cancellation after execution
    if (options?.signal?.aborted) {
      throw McpErrorFactory.cancelled();
    }

    // Format the result as JSON for the AI to parse
    const formattedResult = JSON.stringify(result, null, 2);

    // Track response size and enforce session data limit
    const responseBytes = Buffer.byteLength(formattedResult, 'utf8');
    if (sessionDataBytes + responseBytes > config.maxSessionData) {
      logger.error('Session data limit exceeded', {
        toolName,
        responseBytes,
        sessionDataBytes,
        maxSessionData: config.maxSessionData,
        wouldBe: sessionDataBytes + responseBytes,
      });
      throw McpErrorFactory.resourceExhausted(
        `Session data limit exceeded: ${sessionDataBytes + responseBytes} bytes would exceed ${config.maxSessionData} bytes limit`
      );
    }
    sessionDataBytes += responseBytes;

    const durationMs = Math.round(performance.now() - startTime);
    logger.info('Tool execution succeeded', { toolName, success: true, durationMs, responseBytes, sessionDataBytes });

    return [
      {
        type: 'text',
        text: formattedResult,
      },
    ];
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime);
    const errorMessage = sanitizeError(error instanceof Error ? error.message : String(error));
    logger.error('Tool execution failed', { toolName, success: false, durationMs, error: errorMessage });

    // Use standardized error format with code
    return [
      {
        type: 'text',
        text: formatErrorResponse(error, sanitizeError),
      },
    ];
  }
}
