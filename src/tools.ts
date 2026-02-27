/**
 * MCP Tool Conversion
 *
 * Converts MainWP Abilities to MCP Tool definitions and handles
 * tool execution by forwarding to the Abilities API.
 */

import crypto from 'crypto';
import { Tool, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { Ability, AbilityAnnotations, fetchAbilities, executeAbility, getAbility } from './abilities.js';
import { Config, SchemaVerbosity, formatJson } from './config.js';
import { validateInput, sanitizeError } from './security.js';
import { McpErrorFactory, formatErrorResponse } from './errors.js';
import { Logger, withRequestId } from './logging.js';
import { abilityNameToToolName, toolNameToAbilityName } from './naming.js';
import {
  buildSafeModeBlockedResponse,
  buildInvalidParameterResponse,
  buildConflictingParametersResponse,
  buildConfirmationRequiredResponse,
  buildPreviewRequiredResponse,
  buildPreviewExpiredResponse,
  buildNoChangeResponse,
} from './confirmation-responses.js';

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
 * Preview tracking for two-phase confirmation flow.
 * Maps preview keys to timestamps for validation and expiry.
 */
const pendingPreviews = new Map<string, number>();

/**
 * Token index for confirmation flow.
 * Maps confirmation tokens (UUIDs) to preview keys for secure token-based confirmation.
 */
const tokenIndex = new Map<string, string>();

/** Preview expiry time: 5 minutes in milliseconds */
const PREVIEW_EXPIRY_MS = 5 * 60 * 1000;

/** Maximum number of pending previews to prevent memory exhaustion */
const MAX_PENDING_PREVIEWS = 100;

/**
 * No-op error codes and their human-readable descriptions.
 * Single source of truth: NOOP_ERROR_CODES is derived from this map's keys.
 * When adding new idempotent abilities that return new error codes, add them here.
 */
const NOOP_DESCRIPTIONS: Record<string, string> = {
  already_active: 'Already active — no action needed',
  already_inactive: 'Already inactive — no action needed',
  already_installed: 'Already installed — no action needed',
  already_connected: 'Already connected — no action needed',
  already_disconnected: 'Already disconnected — no action needed',
  already_suspended: 'Already suspended — no action needed',
  already_unsuspended: 'Already unsuspended — no action needed',
  no_updates_available: 'No updates available',
  nothing_to_update: 'Nothing to update',
};

const NOOP_ERROR_CODES = new Set(Object.keys(NOOP_DESCRIPTIONS));

/**
 * Format byte counts as human-readable strings (e.g., "50.0 MB", "2.5 KB").
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/**
 * Check whether an error represents an idempotent no-op (already in desired state).
 * Only matches 4xx HTTP errors with a recognized no-op error code.
 * @internal
 */
export function isNoOpError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (typeof status !== 'number' || status < 400 || status > 499) return false;
  if (typeof code !== 'string') return false;
  return NOOP_ERROR_CODES.has(code);
}

/**
 * Get the current cumulative session data usage in bytes and the configured limit.
 */
export function getSessionDataUsage(config: Config): { used: number; limit: number } {
  return { used: sessionDataBytes, limit: config.maxSessionData };
}

/**
 * Reset the cumulative session data counter to zero.
 */
export function resetSessionData(): void {
  sessionDataBytes = 0;
}

/**
 * Clear pending previews (for testing only).
 * @internal
 */
export function clearPendingPreviews(): void {
  pendingPreviews.clear();
  tokenIndex.clear();
}

/**
 * Generate a unique preview key for a tool call.
 * Excludes confirmation-related parameters (confirm, user_confirmed, dry_run)
 * from the key to ensure preview and execution calls match.
 *
 * Note: Uses JSON.stringify with sorted top-level keys. Nested object key
 * ordering is not normalized, which may cause different keys for semantically
 * identical nested structures.
 */
function getPreviewKey(toolName: string, args: Record<string, unknown>): string {
  const {
    confirm: _confirm,
    user_confirmed: _user_confirmed,
    dry_run: _dry_run,
    confirmation_token: _confirmation_token,
    ...relevantArgs
  } = args;
  const sortedKeys = Object.keys(relevantArgs).sort();
  return `${toolName}:${JSON.stringify(relevantArgs, sortedKeys)}`;
}

/**
 * Clean up expired preview keys and enforce maximum preview limit.
 * Two-pass cleanup strategy:
 * 1. Remove all expired entries (older than PREVIEW_EXPIRY_MS)
 * 2. If still over MAX_PENDING_PREVIEWS, remove oldest entries until at limit
 *
 * This bounds memory without requiring periodic timers (suitable for stdio server).
 */
function cleanupExpiredPreviews(): void {
  const now = Date.now();

  // First pass: Remove expired entries
  for (const [key, timestamp] of pendingPreviews.entries()) {
    if (now - timestamp > PREVIEW_EXPIRY_MS) {
      pendingPreviews.delete(key);
    }
  }

  // Second pass: Enforce max size limit by removing oldest entries
  if (pendingPreviews.size > MAX_PENDING_PREVIEWS) {
    // Sort by timestamp (oldest first)
    const sortedEntries = Array.from(pendingPreviews.entries()).sort((a, b) => a[1] - b[1]);

    // Remove oldest entries until at limit
    const toRemove = sortedEntries.slice(0, pendingPreviews.size - MAX_PENDING_PREVIEWS);
    for (const [key] of toRemove) {
      pendingPreviews.delete(key);
    }
  }

  // Third pass: Clean up orphaned tokens whose preview keys no longer exist
  for (const [token, previewKey] of tokenIndex.entries()) {
    if (!pendingPreviews.has(previewKey)) {
      tokenIndex.delete(token);
    }
  }
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
function abilityToTool(ability: Ability, verbosity: SchemaVerbosity = 'standard'): Tool {
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

/**
 * Cached tool list to avoid re-converting abilities on every ListTools call.
 * Invalidated by abilities array reference change or config fingerprint change.
 */
let cachedTools: Tool[] | null = null;
let cachedToolsAbilitiesRef: Ability[] | null = null;
let cachedToolsFingerprint: string | null = null;

/**
 * Clear the cached tool list (for testing).
 * @internal
 */
export function clearToolsCache(): void {
  cachedTools = null;
  cachedToolsAbilitiesRef = null;
  cachedToolsFingerprint = null;
}

/**
 * Fetch all MainWP abilities and convert them to MCP tools
 *
 * Applies optional filtering based on config:
 * - allowedTools: If set, only include tools in this list
 * - blockedTools: If set, exclude tools in this list
 *
 * Caches the converted tool list by abilities array reference and config
 * fingerprint. fetchAbilities() returns the same cached array while valid,
 * so reference equality is a reliable cache key.
 *
 * @param config - Server configuration
 * @param logger - Optional structured logger for filtering/verbosity messages
 */
export async function getTools(config: Config, logger?: Logger): Promise<Tool[]> {
  const abilities = await fetchAbilities(config, false, logger);
  const fingerprint = `${config.schemaVerbosity}|${config.allowedTools?.join(',') ?? ''}|${config.blockedTools?.join(',') ?? ''}`;

  if (cachedTools && abilities === cachedToolsAbilitiesRef && fingerprint === cachedToolsFingerprint) {
    return cachedTools;
  }

  let tools = abilities.map(ability => abilityToTool(ability, config.schemaVerbosity));
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
  if (tools.length !== originalCount && logger) {
    const allowedCount = config.allowedTools?.length ?? 'all';
    const blockedCount = config.blockedTools?.length ?? 0;
    logger.info('Tool filtering applied', {
      originalCount,
      filteredCount: tools.length,
      allowedCount,
      blockedCount,
    });
  }

  // Log when non-default schema verbosity is active
  if (config.schemaVerbosity !== 'standard' && logger) {
    logger.info('Schema verbosity mode active', {
      verbosity: config.schemaVerbosity,
      note: 'Reduces token usage by ~30% with minimal descriptions',
    });
  }

  cachedTools = tools;
  cachedToolsAbilitiesRef = abilities;
  cachedToolsFingerprint = fingerprint;
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
  const requestId = crypto.randomUUID();

  // Create a child logger that includes requestId in every log entry
  // for end-to-end tracing of this tool call through retry and API execution
  const reqLogger = withRequestId(logger, requestId);

  // SECURITY: Only log metadata (toolName, hasArguments boolean), never log actual
  // argument values or response content as they may contain sensitive data.
  reqLogger.debug('Tool execution started', { toolName, hasArguments });

  let abilityName: string | undefined;
  let annotations: AbilityAnnotations | undefined;

  try {
    // Check for cancellation before starting
    if (options?.signal?.aborted) {
      throw McpErrorFactory.cancelled();
    }

    // Validate input before forwarding to API
    validateInput(args);

    // Convert tool name to ability name
    // Hardcoded 'mainwp' namespace - this server only supports MainWP abilities
    abilityName = toolNameToAbilityName(toolName, 'mainwp');

    // Fetch ability metadata to check if destructive
    const ability = await getAbility(config, abilityName, reqLogger);
    if (!ability) {
      throw new Error(`Ability not found: ${abilityName}`);
    }

    // Check annotations for destructive classification
    // Default-deny: treat missing annotations as destructive (fail-closed)
    annotations = ability.meta?.annotations;
    const isDestructive = annotations?.destructive ?? true;
    let effectiveArgs = args;

    // Always warn when annotations are missing — abilities without annotations
    // are treated as destructive and require confirmation as a safety default
    if (!annotations || typeof annotations.destructive !== 'boolean') {
      reqLogger.warning('Ability missing destructive annotation, defaulting to destructive', {
        toolName,
        abilityName,
        hasAnnotations: !!annotations,
      });
    }

    // Log all destructive operation attempts for audit purposes (regardless of safe mode)
    if (isDestructive) {
      reqLogger.info('Destructive operation invoked', {
        toolName,
        abilityName,
        safeMode: config.safeMode,
      });
    }

    // Safe mode handling
    if (config.safeMode) {

      // Always strip confirm parameter in safe mode (defensive approach)
      if ('confirm' in args) {
        const { confirm, ...safeArgs } = args;
        effectiveArgs = safeArgs;
        reqLogger.info('Stripped confirm parameter in safe mode', { toolName, hadConfirm: confirm });
      }

      // Block destructive operations with a clear user-visible message.
      // Note: Safe-mode early-return responses are intentionally excluded from
      // sessionDataBytes tracking. The session data limit is designed to prevent
      // runaway API responses, not small fixed-size local error messages.
      if (isDestructive) {
        reqLogger.warning('Destructive operation blocked by safe mode', { toolName, abilityName });
        const ctx = { tool: toolName, ability: abilityName };

        return [
          {
            type: 'text',
            text: formatJson(config, buildSafeModeBlockedResponse(ctx)),
          },
        ];
      }
    }

    // Two-phase confirmation flow for destructive operations
    // Only applies when requireUserConfirmation is enabled and tool is destructive
    if (config.requireUserConfirmation && isDestructive) {
      // Check if tool supports confirmation parameter
      const schemaProps = ability.input_schema?.properties;
      const hasConfirmParam =
        schemaProps !== null && typeof schemaProps === 'object' && 'confirm' in schemaProps;

      // Validation: user_confirmed on tools without confirm parameter
      if (!hasConfirmParam && args.user_confirmed === true) {
        reqLogger.warning('Invalid parameter: user_confirmed on tool without confirm support', {
          toolName,
          abilityName,
        });

        // Note: This fixed-size local error message is intentionally excluded from
        // sessionDataBytes tracking. The session data limit targets runaway API
        // responses, not small validation errors.
        const ctx = { tool: toolName, ability: abilityName };
        const errorResponse = formatJson(config, buildInvalidParameterResponse(ctx));

        return [{ type: 'text', text: errorResponse }];
      }

      if (hasConfirmParam) {
        // Validation: Conflicting parameters (user_confirmed + dry_run)
        if (args.user_confirmed === true && args.dry_run === true) {
          reqLogger.warning('Conflicting parameters: user_confirmed and dry_run both set', {
            toolName,
            abilityName,
            userConfirmed: args.user_confirmed,
            dryRun: args.dry_run,
          });

          // Note: This fixed-size local error message is intentionally excluded from
          // sessionDataBytes tracking. The session data limit targets runaway API
          // responses, not small validation errors.
          const ctx = { tool: toolName, ability: abilityName };
          const errorResponse = formatJson(config, buildConflictingParametersResponse(ctx));

          return [{ type: 'text', text: errorResponse }];
        }

        // Case 1: Explicit dry_run bypass - skip confirmation flow entirely
        if (args.dry_run === true) {
          reqLogger.debug('Explicit dry_run bypasses confirmation flow', { toolName });
          // Proceed to normal execution with effectiveArgs unchanged
        }
        // Case 2: Preview request (confirm: true without user_confirmed)
        else if (args.confirm === true && args.user_confirmed !== true) {
          cleanupExpiredPreviews();

          // Execute preview with dry_run: true
          const previewArgs = { ...effectiveArgs, dry_run: true, confirm: undefined };
          const previewResult = await executeAbility(config, abilityName, previewArgs, reqLogger);

          // Store preview for later validation
          const previewKey = getPreviewKey(toolName, args);
          pendingPreviews.set(previewKey, Date.now());

          // Clean up any existing token for this preview key before generating a new one
          for (const [existingToken, existingKey] of tokenIndex.entries()) {
            if (existingKey === previewKey) {
              tokenIndex.delete(existingToken);
              break;
            }
          }

          // Generate confirmation token for secure token-based confirmation
          const token = crypto.randomUUID();
          tokenIndex.set(token, previewKey);

          reqLogger.info('Preview generated for confirmation', { toolName });

          // Return structured preview response
          const ctx = { tool: toolName, ability: abilityName };
          const confirmationResponse = buildConfirmationRequiredResponse(ctx, previewResult, token);
          const previewResponse = formatJson(config, confirmationResponse);

          // Track preview response size (contains API data that could be large)
          const previewBytes = Buffer.byteLength(previewResponse, 'utf8');
          if (sessionDataBytes + previewBytes > config.maxSessionData) {
            reqLogger.error('Session data limit exceeded during preview', {
              toolName,
              previewBytes,
              sessionDataBytes,
              maxSessionData: config.maxSessionData,
              wouldBe: sessionDataBytes + previewBytes,
            });
            throw McpErrorFactory.resourceExhausted(
              `Session data limit reached (${formatBytes(sessionDataBytes + previewBytes)} of ${formatBytes(config.maxSessionData)}). Start a new session to continue.`
            );
          }
          sessionDataBytes += previewBytes;

          return [{ type: 'text', text: previewResponse }];
        }
        // Case 3: Confirmed execution (user_confirmed: true)
        else if (args.user_confirmed === true) {
          // Warning: Ambiguous parameters (confirm + user_confirmed both set)
          // Per PRD line 319: allow execution but log for tracking
          if (args.confirm === true) {
            reqLogger.warning(
              'Ambiguous parameters: both confirm and user_confirmed set, treating as confirmation',
              {
                toolName,
                abilityName,
              }
            );
          }

          // Resolve preview key: prefer token-based lookup, fall back to key-based
          let previewKey: string;
          const confirmationToken =
            typeof args.confirmation_token === 'string' ? args.confirmation_token : undefined;

          if (confirmationToken) {
            const tokenPreviewKey = tokenIndex.get(confirmationToken);
            if (!tokenPreviewKey) {
              // Token is invalid or already consumed
              reqLogger.warning('Confirmation failed - invalid confirmation token', { toolName });
              const ctx = { tool: toolName, ability: abilityName };
              return [
                { type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) },
              ];
            }
            // Verify token belongs to this tool (prevent cross-tool reuse)
            if (!tokenPreviewKey.startsWith(`${toolName}:`)) {
              tokenIndex.delete(confirmationToken);
              reqLogger.warning('Confirmation failed - token belongs to different tool', { toolName });
              const ctx = { tool: toolName, ability: abilityName };
              return [
                { type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) },
              ];
            }
            previewKey = tokenPreviewKey;
          } else {
            previewKey = getPreviewKey(toolName, args);
          }

          // Note: We intentionally check preview expiry BEFORE running cleanup.
          // This allows us to return the more helpful PREVIEW_EXPIRED error when
          // a user's preview timed out, rather than the generic PREVIEW_REQUIRED.
          // Memory management is handled by cleanup during preview generation.
          const previewTimestamp = pendingPreviews.get(previewKey);

          // Check if preview exists
          if (previewTimestamp === undefined) {
            reqLogger.warning('Confirmation failed - no preview found', { toolName });

            // Note: This fixed-size local error message is intentionally excluded from
            // sessionDataBytes tracking. The session data limit targets runaway API
            // responses, not small validation errors.
            const ctx = { tool: toolName, ability: abilityName };
            const errorResponse = formatJson(config, buildPreviewRequiredResponse(ctx));

            return [{ type: 'text', text: errorResponse }];
          }

          // Check if preview expired
          if (Date.now() - previewTimestamp > PREVIEW_EXPIRY_MS) {
            pendingPreviews.delete(previewKey);
            if (confirmationToken) tokenIndex.delete(confirmationToken);
            reqLogger.warning('Confirmation failed - preview expired', { toolName });

            // Note: This fixed-size local error message is intentionally excluded from
            // sessionDataBytes tracking. The session data limit targets runaway API
            // responses, not small validation errors.
            const ctx = { tool: toolName, ability: abilityName };
            const errorResponse = formatJson(config, buildPreviewExpiredResponse(ctx));

            return [{ type: 'text', text: errorResponse }];
          }

          // Preview is valid - proceed with execution
          pendingPreviews.delete(previewKey);
          if (confirmationToken) tokenIndex.delete(confirmationToken);
          const previewAge = Date.now() - previewTimestamp;
          reqLogger.info('User confirmation validated', { toolName, previewAge });

          // Remove user_confirmed and confirmation_token flags, keep confirm: true for the actual execution
          const {
            user_confirmed: _user_confirmed,
            confirmation_token: _confirmation_token,
            ...confirmedArgs
          } = effectiveArgs;
          effectiveArgs = { ...confirmedArgs, confirm: true };
        }
        // Default case: no confirm or user_confirmed provided
        else {
          // This shouldn't happen for tools with confirm param if schema is properly enforced
          // Log warning but proceed to maintain backward compatibility
          reqLogger.warning('Destructive tool called without confirmation parameters', {
            toolName,
            abilityName,
          });
        }
      }
    }

    const result = await executeAbility(config, abilityName, effectiveArgs, reqLogger);

    // Check for cancellation after execution
    if (options?.signal?.aborted) {
      throw McpErrorFactory.cancelled();
    }

    // Format the result as JSON for the AI to parse
    const formattedResult = formatJson(config, result);

    // Track response size and enforce session data limit
    const responseBytes = Buffer.byteLength(formattedResult, 'utf8');
    if (sessionDataBytes + responseBytes > config.maxSessionData) {
      reqLogger.error('Session data limit exceeded', {
        toolName,
        responseBytes,
        sessionDataBytes,
        maxSessionData: config.maxSessionData,
        wouldBe: sessionDataBytes + responseBytes,
      });
      throw McpErrorFactory.resourceExhausted(
        `Session data limit reached (${formatBytes(sessionDataBytes + responseBytes)} of ${formatBytes(config.maxSessionData)}). Start a new session to continue.`
      );
    }
    sessionDataBytes += responseBytes;

    const durationMs = Math.round(performance.now() - startTime);
    reqLogger.info('Tool execution succeeded', {
      toolName,
      success: true,
      durationMs,
      responseBytes,
      sessionDataBytes,
    });

    return [
      {
        type: 'text',
        text: formattedResult,
      },
    ];
  } catch (error) {
    // Idempotent no-op: tool already achieved the desired state (e.g. already_active)
    if (annotations?.idempotent && isNoOpError(error)) {
      const code = (error as { code: string }).code;
      const reason = NOOP_DESCRIPTIONS[code] ?? code;
      const ctx = { tool: toolName, ability: abilityName ?? toolName };
      const noChangeText = formatJson(config, buildNoChangeResponse(ctx, code, reason));
      const responseBytes = Buffer.byteLength(noChangeText, 'utf8');
      if (sessionDataBytes + responseBytes > config.maxSessionData) {
        reqLogger.error('Session data limit exceeded during no-op response', {
          toolName,
          responseBytes,
          sessionDataBytes,
          maxSessionData: config.maxSessionData,
          wouldBe: sessionDataBytes + responseBytes,
        });
        throw McpErrorFactory.resourceExhausted(
          `Session data limit reached (${formatBytes(sessionDataBytes + responseBytes)} of ${formatBytes(config.maxSessionData)}). Start a new session to continue.`
        );
      }
      sessionDataBytes += responseBytes;
      const durationMs = Math.round(performance.now() - startTime);
      reqLogger.info('Tool execution no-op (idempotent already-state)', {
        toolName,
        durationMs,
        responseBytes,
        sessionDataBytes,
      });
      return [{ type: 'text', text: noChangeText }];
    }

    const durationMs = Math.round(performance.now() - startTime);
    const errorMessage = sanitizeError(error instanceof Error ? error.message : String(error));
    reqLogger.error('Tool execution failed', {
      toolName,
      success: false,
      durationMs,
      error: errorMessage,
    });

    // Use standardized error format with code
    return [
      {
        type: 'text',
        text: formatErrorResponse(error, sanitizeError),
      },
    ];
  }
}
