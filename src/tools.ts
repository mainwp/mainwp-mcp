/**
 * MCP Tool Conversion
 *
 * Converts MainWP Abilities to MCP Tool definitions and handles
 * tool execution by forwarding to the Abilities API.
 */

import crypto from 'crypto';
import { Tool, TextContent } from '@modelcontextprotocol/sdk/types.js';
import {
  Ability,
  AbilityAnnotations,
  fetchAbilities,
  executeAbility,
  getAbilityByToolName,
} from './abilities.js';
import { Config, formatJson } from './config.js';
import { validateInput, sanitizeError } from './security.js';
import { McpErrorFactory, formatErrorResponse, getErrorMessage } from './errors.js';
import { Logger, withRequestId, withSecretRedaction } from './logging.js';
import {
  trackSessionData,
  getSessionDataUsage,
  isNoOpError,
  NOOP_DESCRIPTIONS,
} from './session.js';
import { abilityToTool } from './tool-schema.js';
import { handleConfirmationFlow } from './confirmation.js';
import {
  decidePolicy,
  classifyDestructive,
  isToolAllowed,
  pinnedConfirmationParams,
  resolveConfirmationParam,
} from './policy.js';
import { buildSafeModeBlockedResponse, buildNoChangeResponse } from './confirmation-responses.js';
import { createWriteOnlyRedactor, type WriteOnlyRedactor } from './write-only.js';

/**
 * Options for tool execution
 */
export interface ExecuteToolOptions {
  /** AbortSignal for cancellation support */
  signal?: AbortSignal;
}

/**
 * Result of a tool call, matching the MCP CallToolResult shape.
 * `isError: true` marks failed calls (unknown tool, validation failure,
 * execution failure, confirmation rejection) so clients can branch on it.
 * A type alias (not interface) so it gets an implicit index signature and
 * stays assignable to the SDK's CallToolResult handler return type.
 */
export type ToolCallResult = {
  content: TextContent[];
  isError?: boolean;
};

/**
 * Cached tool list to avoid re-converting abilities on every ListTools call.
 *
 * This is the second tier of a two-tier cache and deliberately uses a
 * different invalidation model than abilities.ts:
 * - abilities.ts owns the SOURCE cache: TTL + namespace signature, with
 *   stale-serving on upstream failures.
 * - this is a pure derivation memo: abilities → tools is deterministic given
 *   the config, so it's keyed on the abilities array identity (fetchAbilities
 *   returns the same array while its cache is valid) plus a fingerprint of
 *   the config fields that affect conversion. No TTL or staleness concept
 *   needed — freshness is entirely the source cache's problem.
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

// Re-exported for existing consumers; the implementation lives in the pure
// policy gate (policy.ts), the single policy authority for every surface.
export { isToolAllowed };

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
  // JSON.stringify (not delimiter-joining) so a tool or namespace name
  // containing the delimiter could never produce a colliding fingerprint
  const fingerprint = JSON.stringify([
    config.schemaVerbosity,
    config.allowedTools ?? [],
    config.blockedTools ?? [],
    config.abilityNamespaces,
  ]);

  if (
    cachedTools &&
    abilities === cachedToolsAbilitiesRef &&
    fingerprint === cachedToolsFingerprint
  ) {
    return cachedTools;
  }

  const primaryNamespace = config.abilityNamespaces[0];
  let tools = abilities.map(ability =>
    abilityToTool(ability, primaryNamespace, config.schemaVerbosity)
  );
  const originalCount = tools.length;

  // Apply allowlist filter (whitelist)
  tools = tools.filter(tool => isToolAllowed(config, tool.name));

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
      note: 'Uses minimal descriptions to reduce token usage',
    });
  }

  cachedTools = tools;
  cachedToolsAbilitiesRef = abilities;
  cachedToolsFingerprint = fingerprint;
  return tools;
}

/**
 * Execute an MCP tool call by forwarding to the corresponding ability
 */
export async function executeTool(
  config: Config,
  toolName: string,
  args: Record<string, unknown>,
  logger: Logger,
  options?: ExecuteToolOptions
): Promise<ToolCallResult> {
  const startTime = performance.now();
  const hasArguments = Object.keys(args).length > 0;
  const requestId = crypto.randomUUID();

  // Create a child logger that includes requestId in every log entry
  // for end-to-end tracing of this tool call through retry and API execution
  const reqLogger = withRequestId(logger, requestId);
  let callLogger = reqLogger;
  let writeOnlyRedactor: WriteOnlyRedactor | undefined;

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

    // Policy gate, listing stage: runs before ability resolution so a blocked
    // tool is indistinguishable from a nonexistent one (no ability-name leak).
    if (decidePolicy(config, toolName) !== 'allow') {
      throw McpErrorFactory.permissionDenied(`Tool is not allowed: ${toolName}`);
    }

    // Resolve tool name → ability via the cache reverse index built during
    // fetchAbilities. This handles both primary-namespace (unprefixed) tools
    // and prefixed `{ns}__tool` names from non-primary namespaces.
    const ability = await getAbilityByToolName(config, toolName, reqLogger);
    if (!ability) {
      throw McpErrorFactory.toolNotFound(toolName);
    }
    abilityName = ability.name;

    // Validate against the schema of this same ability object, which is what
    // executeAbility runs below, so the declared limits and the executed
    // ability cannot come from different fetches.
    validateInput(args, ability.input_schema);
    writeOnlyRedactor = createWriteOnlyRedactor(ability.input_schema, args);
    callLogger = withSecretRedaction(reqLogger, writeOnlyRedactor.text);

    const ctx = { tool: toolName, ability: abilityName };

    // Default-deny: treat missing annotations as destructive (fail-closed)
    annotations = ability.meta?.annotations;
    const isDestructive = classifyDestructive(annotations);
    let effectiveArgs = args;

    // Always warn when annotations are missing — abilities without annotations
    // are treated as destructive and require confirmation as a safety default
    if (!annotations || typeof annotations.destructive !== 'boolean') {
      callLogger.warning('Ability missing destructive annotation, defaulting to destructive', {
        toolName,
        abilityName,
        hasAnnotations: !!annotations,
      });
    }

    // Audit: fires for every destructive request, including ones safe mode
    // blocks below. The matching "executed" event lives in executeAbility;
    // grep "AUDIT:" for the full trail.
    if (isDestructive) {
      callLogger.info('AUDIT: destructive operation requested', {
        toolName,
        abilityName,
        safeMode: config.safeMode,
      });
    }

    // Policy gate, execution stage: with destructiveness resolved, the gate
    // decides safe-mode blocking and confirmation routing. The executor only
    // acts on the decision; precedence lives in decidePolicy.
    const decision = decidePolicy(config, toolName, isDestructive);

    if (config.safeMode) {
      // Always strip confirm parameter in safe mode (defensive approach)
      if ('confirm' in args) {
        // The supplied value is not logged: it is caller input, and a number
        // passes the writeOnly log redaction, which matches strings.
        const { confirm: _confirm, ...safeArgs } = args;
        effectiveArgs = safeArgs;
        callLogger.info('Stripped confirm parameter in safe mode', { toolName });
      }
      // Every pinned confirm_*, not only the resolved one: a schema that
      // declares confirm next to a pinned confirm_* resolves to no channel.
      for (const confirmationParam of pinnedConfirmationParams(ability.input_schema)) {
        if (confirmationParam in effectiveArgs) {
          const { [confirmationParam]: _confirmation, ...safeArgs } = effectiveArgs;
          effectiveArgs = safeArgs;
          callLogger.info('Stripped confirmation parameter in safe mode', {
            toolName,
            confirmationParam,
          });
        }
      }
    }

    // Block destructive operations with a clear user-visible message.
    // Note: Safe-mode early-return responses are intentionally excluded from
    // sessionDataBytes tracking. The session data limit is designed to prevent
    // runaway API responses, not small fixed-size local error messages.
    if (decision === 'safe-mode-blocked') {
      callLogger.warning('Destructive operation blocked by safe mode', { toolName, abilityName });
      return {
        content: [
          {
            type: 'text',
            text: formatJson(config, buildSafeModeBlockedResponse(ctx)),
          },
        ],
        isError: true,
      };
    }

    // user_confirmed and confirmation_token are this server's inputs, added to
    // the schema of every destructive tool with a confirm channel. The ability
    // never declared them, and one that rejects unknown keys fails the whole
    // call, so they are dropped from every upstream input, including calls
    // made with confirmation disabled. The confirmation flow reads them from
    // the original args.
    if (isDestructive && resolveConfirmationParam(ability.input_schema) !== undefined) {
      const {
        user_confirmed: _userConfirmed,
        confirmation_token: _confirmationToken,
        ...upstreamArgs
      } = effectiveArgs;
      effectiveArgs = upstreamArgs;
    }

    // Two-phase confirmation flow for destructive operations
    // Only applies when requireUserConfirmation is enabled and tool is destructive
    if (decision === 'needs-confirmation') {
      const confirmResult = await handleConfirmationFlow({
        config,
        ability,
        toolName,
        abilityName,
        args,
        effectiveArgs,
        logger: callLogger,
        signal: options?.signal,
      });

      if (confirmResult.action === 'respond') {
        return confirmResult.isError
          ? { content: confirmResult.response, isError: true }
          : { content: confirmResult.response };
      }
      effectiveArgs = confirmResult.effectiveArgs;
    }

    const result = await executeAbility(
      config,
      abilityName,
      effectiveArgs,
      callLogger,
      ability,
      options?.signal
    );

    // Check for cancellation after execution
    if (options?.signal?.aborted) {
      throw McpErrorFactory.cancelled();
    }

    // Format the result as JSON for the AI to parse
    const formattedResult = formatJson(config, result);

    const responseBytes = trackSessionData(
      formattedResult,
      config,
      callLogger,
      'for tool response'
    );

    const durationMs = Math.round(performance.now() - startTime);
    callLogger.info('Tool execution succeeded', {
      toolName,
      success: true,
      durationMs,
      responseBytes,
      sessionDataBytes: getSessionDataUsage(config).used,
    });

    return {
      content: [
        {
          type: 'text',
          text: formattedResult,
        },
      ],
    };
  } catch (error) {
    // Idempotent no-op: tool already achieved the desired state (e.g. already_active)
    if (annotations?.idempotent && isNoOpError(error)) {
      const code = (error as { code: string }).code;
      const reason = NOOP_DESCRIPTIONS[code] ?? code;
      const noopCtx = { tool: toolName, ability: abilityName ?? toolName };
      const noChangeText = formatJson(config, buildNoChangeResponse(noopCtx, code, reason));
      const responseBytes = trackSessionData(
        noChangeText,
        config,
        callLogger,
        'during no-op response'
      );
      const durationMs = Math.round(performance.now() - startTime);
      callLogger.info('Tool execution no-op (idempotent already-state)', {
        toolName,
        durationMs,
        responseBytes,
        sessionDataBytes: getSessionDataUsage(config).used,
      });
      return { content: [{ type: 'text', text: noChangeText }] };
    }

    const durationMs = Math.round(performance.now() - startTime);
    const redactError = (message: string): string =>
      sanitizeError(writeOnlyRedactor?.text(message) ?? message);
    const errorMessage = redactError(getErrorMessage(error));
    callLogger.error('Tool execution failed', {
      toolName,
      success: false,
      durationMs,
      error: errorMessage,
    });

    // Use standardized error format with code; isError marks the call as
    // failed per the MCP spec while keeping the JSON error body in content
    return {
      content: [
        {
          type: 'text',
          text: formatErrorResponse(error, redactError),
        },
      ],
      isError: true,
    };
  }
}
