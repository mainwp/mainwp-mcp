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
  buildConflictingParametersResponse,
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
 * - `execute`: proceed with execution using the (possibly modified) effectiveArgs
 * - `skip`: confirmation flow does not apply — proceed with original args
 */
export type ConfirmationResult =
  | { action: 'respond'; response: TextContent[] }
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
  const sortedKeys = Object.keys(relevantArgs).sort();
  return `${toolName}:${JSON.stringify(relevantArgs, sortedKeys)}`;
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

  // Validation: user_confirmed on tools without confirm parameter
  if (!hasConfirmParam && args.user_confirmed === true) {
    logger.warning('Invalid parameter: user_confirmed on tool without confirm support', {
      toolName,
      abilityName,
    });
    return {
      action: 'respond',
      response: [{ type: 'text', text: formatJson(config, buildInvalidParameterResponse(ctx)) }],
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
    };
  }

  // Case 1: Explicit dry_run bypass - skip confirmation flow entirely
  if (args.dry_run === true) {
    logger.debug('Explicit dry_run bypasses confirmation flow', { toolName });
    return { action: 'skip' };
  }

  // Case 2: Preview request (confirm: true without user_confirmed)
  if (args.confirm === true && args.user_confirmed !== true) {
    cleanupExpiredPreviews();

    // Execute preview with dry_run: true
    const previewArgs = { ...effectiveArgs, dry_run: true, confirm: undefined };
    const previewResult = await executeAbility(
      config,
      abilityName,
      previewArgs,
      logger,
      ability,
      signal
    );

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

    logger.info('Preview generated for confirmation', { toolName });

    const confirmationResponse = buildConfirmationRequiredResponse(ctx, previewResult, token);
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

    // Resolve preview key: prefer token-based lookup, fall back to key-based
    let previewKey: string;
    const confirmationToken =
      typeof args.confirmation_token === 'string' ? args.confirmation_token : undefined;

    if (confirmationToken) {
      const tokenPreviewKey = tokenIndex.get(confirmationToken);
      if (!tokenPreviewKey) {
        logger.warning('Confirmation failed - invalid confirmation token', { toolName });
        return {
          action: 'respond',
          response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
        };
      }
      // Verify token belongs to this tool (prevent cross-tool reuse)
      if (!tokenPreviewKey.startsWith(`${toolName}:`)) {
        tokenIndex.delete(confirmationToken);
        logger.warning('Confirmation failed - token belongs to different tool', { toolName });
        return {
          action: 'respond',
          response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
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
        };
      }
      previewKey = tokenPreviewKey;
    } else {
      previewKey = getPreviewKey(toolName, args);
    }

    // Check preview expiry BEFORE running cleanup for more helpful error messages
    const previewTimestamp = pendingPreviews.get(previewKey);

    if (previewTimestamp === undefined) {
      logger.warning('Confirmation failed - no preview found', { toolName });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
      };
    }

    if (Date.now() - previewTimestamp > PREVIEW_EXPIRY_MS) {
      pendingPreviews.delete(previewKey);
      if (confirmationToken) tokenIndex.delete(confirmationToken);
      logger.warning('Confirmation failed - preview expired', { toolName });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewExpiredResponse(ctx)) }],
      };
    }

    // Preview is valid - proceed with execution
    pendingPreviews.delete(previewKey);
    if (confirmationToken) tokenIndex.delete(confirmationToken);
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
  // Log warning but proceed to maintain backward compatibility
  logger.warning('Destructive tool called without confirmation parameters', {
    toolName,
    abilityName,
  });
  return { action: 'skip' };
}
