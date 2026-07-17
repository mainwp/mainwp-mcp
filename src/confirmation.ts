/**
 * Two-Phase Confirmation Flow
 *
 * Manages the preview → confirm → execute lifecycle for destructive operations.
 * Owns the pending preview state (pendingPreviews, tokenIndex) and all
 * confirmation validation logic.
 */

import crypto from 'crypto';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { executeAbility, type Ability } from './abilities.js';
import { Config, formatJson } from './config.js';
import type { Logger } from './logging.js';
import { trackSessionData } from './session.js';
import {
  buildInvalidParameterResponse,
  buildDryRunNotSupportedResponse,
  buildConflictingParametersResponse,
  buildNoPreviewAvailableResponse,
  buildConfirmationRequiredResponse,
  buildPreviewRequiredResponse,
  buildPreviewExpiredResponse,
  type ConfirmationContext,
} from './confirmation-responses.js';

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
 * Clear pending previews (for testing only).
 * @internal
 */
export function clearPendingPreviews(): void {
  pendingPreviews.clear();
  tokenIndex.clear();
}

/**
 * Result of the confirmation flow evaluation.
 *
 * - `respond`: return the response directly to the client (preview, error, etc.)
 *   `isError: true` marks rejections (invalid/conflicting parameters, missing
 *   or expired preview) so the tool result carries the MCP `isError` flag;
 *   preview responses (CONFIRMATION_REQUIRED) are successful workflow steps.
 * - `execute`: proceed with execution using the (possibly modified) effectiveArgs
 * - `skip`: confirmation flow does not apply — proceed with original args
 */
export type ConfirmationResult =
  | { action: 'respond'; response: TextContent[]; isError?: boolean }
  | { action: 'execute'; effectiveArgs: Record<string, unknown> }
  | { action: 'skip' };

/**
 * Parameters for the confirmation flow handler
 */
export interface ConfirmationFlowParams {
  config: Config;
  ability: Ability;
  toolName: string;
  abilityName: string;
  args: Record<string, unknown>;
  effectiveArgs: Record<string, unknown>;
  logger: Logger;
  signal?: AbortSignal;
}

/**
 * Recursively sort object keys so serialization is deterministic at every
 * depth. JSON.stringify's array-replacer form cannot be used here: it filters
 * property names at all nesting levels, which drops nested values from the
 * key and lets differing nested arguments collide.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Generate a unique preview key for a tool call.
 * Excludes confirmation-related parameters (confirm, user_confirmed, dry_run)
 * from the key to ensure preview and execution calls match.
 */
function getPreviewKey(toolName: string, args: Record<string, unknown>): string {
  const {
    confirm: _confirm,
    user_confirmed: _user_confirmed,
    dry_run: _dry_run,
    confirmation_token: _confirmation_token,
    ...relevantArgs
  } = args;
  return `${toolName}:${JSON.stringify(canonicalize(relevantArgs))}`;
}

/**
 * Clean up expired preview keys and enforce maximum preview limit.
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
    const sortedEntries = Array.from(pendingPreviews.entries()).sort((a, b) => a[1] - b[1]);
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
 * Handle the two-phase confirmation flow for destructive operations.
 *
 * Evaluates the tool call arguments and returns one of:
 * - `respond`: early-return response (preview, validation error, expired)
 * - `execute`: proceed with modified args (user confirmed)
 * - `skip`: confirmation flow doesn't apply (dry_run, no confirm param, etc.)
 */
export async function handleConfirmationFlow(
  params: ConfirmationFlowParams
): Promise<ConfirmationResult> {
  const { config, ability, toolName, abilityName, args, effectiveArgs, logger, signal } = params;
  const ctx: ConfirmationContext = { tool: toolName, ability: abilityName };

  // Check if tool supports confirmation parameter
  const schemaProps = ability.input_schema?.properties;
  const hasConfirmParam =
    schemaProps !== null && typeof schemaProps === 'object' && 'confirm' in schemaProps;
  const hasDryRunParam =
    schemaProps !== null && typeof schemaProps === 'object' && 'dry_run' in schemaProps;

  // Validation: user_confirmed on tools without confirm parameter
  if (!hasConfirmParam && args.user_confirmed === true) {
    logger.warning('Invalid parameter: user_confirmed on tool without confirm support', {
      toolName,
      abilityName,
    });
    return {
      action: 'respond',
      response: [{ type: 'text', text: formatJson(config, buildInvalidParameterResponse(ctx)) }],
      isError: true,
    };
  }

  if (!hasConfirmParam) {
    return { action: 'skip' };
  }

  // Validation: Conflicting parameters (user_confirmed + dry_run)
  if (args.user_confirmed === true && args.dry_run === true) {
    logger.warning('Conflicting parameters: user_confirmed and dry_run both set', {
      toolName,
      abilityName,
      userConfirmed: args.user_confirmed,
      dryRun: args.dry_run,
    });
    return {
      action: 'respond',
      response: [
        { type: 'text', text: formatJson(config, buildConflictingParametersResponse(ctx)) },
      ],
      isError: true,
    };
  }

  // Case 1: Explicit dry_run bypass - skip confirmation flow entirely.
  // Only honored when the ability declares dry_run: forwarding a fabricated
  // dry_run (possibly alongside confirm: true) would execute for real if
  // upstream ignores unknown input, so undeclared dry_run is rejected
  // before any upstream call.
  if (args.dry_run === true) {
    if (!hasDryRunParam) {
      logger.warning('Invalid parameter: dry_run on tool without dry_run support', {
        toolName,
        abilityName,
      });
      return {
        action: 'respond',
        response: [
          { type: 'text', text: formatJson(config, buildDryRunNotSupportedResponse(ctx)) },
        ],
        isError: true,
      };
    }
    logger.debug('Explicit dry_run bypasses confirmation flow', { toolName });
    return { action: 'skip' };
  }

  // Case 2: Preview request (confirm: true without user_confirmed)
  if (args.confirm === true && args.user_confirmed !== true) {
    cleanupExpiredPreviews();

    // Abilities without a declared dry_run parameter get no upstream preview
    // call — fabricating dry_run against a schema that doesn't declare it
    // could execute for real if upstream ignores unknown input. The two-phase
    // gate still applies: a token is issued below so the confirmed follow-up
    // call can proceed.
    let previewResult: unknown = null;
    if (hasDryRunParam) {
      // Execute preview with dry_run: true and the confirm flag removed
      const previewArgs: Record<string, unknown> = { ...effectiveArgs, dry_run: true };
      delete previewArgs.confirm;
      previewResult = await executeAbility(
        config,
        abilityName,
        previewArgs,
        logger,
        ability,
        signal
      );
    } else {
      logger.warning('Preview unavailable - ability does not support dry_run', {
        toolName,
        abilityName,
      });
    }

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

    logger.info(
      hasDryRunParam
        ? 'Preview generated for confirmation'
        : 'Confirmation required without preview',
      { toolName }
    );

    const confirmationResponse = hasDryRunParam
      ? buildConfirmationRequiredResponse(ctx, previewResult, token)
      : buildNoPreviewAvailableResponse(ctx, token);
    const previewResponse = formatJson(config, confirmationResponse);

    trackSessionData(previewResponse, config, logger, 'during preview');

    return {
      action: 'respond',
      response: [{ type: 'text', text: previewResponse }],
    };
  }

  // Case 3: Confirmed execution (user_confirmed: true)
  if (args.user_confirmed === true) {
    // Warning: Ambiguous parameters (confirm + user_confirmed both set)
    if (args.confirm === true) {
      logger.warning(
        'Ambiguous parameters: both confirm and user_confirmed set, treating as confirmation',
        { toolName, abilityName }
      );
    }

    // Confirmed execution is token-bound: the token proves the caller saw the
    // preview response. A tool+args fallback would let a caller confirm a
    // preview it never read, so no token means no execution.
    const confirmationToken =
      typeof args.confirmation_token === 'string' ? args.confirmation_token : undefined;

    if (!confirmationToken) {
      logger.warning('Confirmation failed - confirmation_token missing', { toolName });
      return {
        action: 'respond',
        response: [
          {
            type: 'text',
            text: formatJson(
              config,
              buildPreviewRequiredResponse(
                ctx,
                'user_confirmed: true requires the confirmation_token issued by the preview response'
              )
            ),
          },
        ],
        isError: true,
      };
    }

    const tokenPreviewKey = tokenIndex.get(confirmationToken);
    if (!tokenPreviewKey) {
      logger.warning('Confirmation failed - invalid confirmation token', { toolName });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
        isError: true,
      };
    }
    // Verify token belongs to this tool (prevent cross-tool reuse)
    if (!tokenPreviewKey.startsWith(`${toolName}:`)) {
      tokenIndex.delete(confirmationToken);
      logger.warning('Confirmation failed - token belongs to different tool', { toolName });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
        isError: true,
      };
    }
    // Verify token matches current arguments (prevent arg-swap)
    const currentPreviewKey = getPreviewKey(toolName, args);
    if (currentPreviewKey !== tokenPreviewKey) {
      tokenIndex.delete(confirmationToken);
      logger.warning('Confirmation failed - arguments do not match preview', { toolName });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
        isError: true,
      };
    }
    const previewKey = tokenPreviewKey;

    // Check preview expiry BEFORE running cleanup for more helpful error messages
    const previewTimestamp = pendingPreviews.get(previewKey);

    if (previewTimestamp === undefined) {
      logger.warning('Confirmation failed - no preview found', { toolName });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
        isError: true,
      };
    }

    if (Date.now() - previewTimestamp > PREVIEW_EXPIRY_MS) {
      pendingPreviews.delete(previewKey);
      tokenIndex.delete(confirmationToken);
      logger.warning('Confirmation failed - preview expired', { toolName });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewExpiredResponse(ctx)) }],
        isError: true,
      };
    }

    // Preview is valid - proceed with execution
    pendingPreviews.delete(previewKey);
    tokenIndex.delete(confirmationToken);
    const previewAge = Date.now() - previewTimestamp;
    logger.info('User confirmation validated', { toolName, previewAge });

    // Remove user_confirmed and confirmation_token flags, keep confirm: true for the actual execution
    const {
      user_confirmed: _user_confirmed,
      confirmation_token: _confirmation_token,
      ...confirmedArgs
    } = effectiveArgs;

    return {
      action: 'execute',
      effectiveArgs: { ...confirmedArgs, confirm: true },
    };
  }

  // Default case: no confirm or user_confirmed provided
  logger.warning('Destructive tool called without confirmation parameters', {
    toolName,
    abilityName,
  });
  return {
    action: 'respond',
    response: [
      {
        type: 'text',
        text: formatJson(
          config,
          buildPreviewRequiredResponse(
            ctx,
            'Destructive tools require confirmation parameters; neither confirm nor user_confirmed was provided'
          )
        ),
      },
    ],
    isError: true,
  };
}
