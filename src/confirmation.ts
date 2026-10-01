/**
 * Two-Phase Confirmation Flow
 *
 * Manages the preview → confirm → execute lifecycle for destructive operations.
 * Owns the pending preview state (pendingPreviews, tokenIndex) and all
 * confirmation validation logic.
 */

import crypto from 'crypto';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { configIdentityHash, executeAbility, type Ability } from './abilities.js';
import { Config, formatJson } from './config.js';
import type { Logger } from './logging.js';
import {
  declaresUsableBooleanParam,
  declaresNullablePreviewToken,
  requiresUsableFalseParam,
  resolveConfirmationParam,
} from './policy.js';
import { trackSessionData } from './session.js';
import {
  buildConfirmationUnsupportedResponse,
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
 * Maps preview keys to the time the preview was made, for validation and
 * expiry. `upstreamToken` holds the `preview_token` an ability's own dry run
 * issued, so the confirmed call can supply it when the caller sends none. It
 * shares the entry's key, identity scope and expiry, and goes when the entry
 * is consumed.
 */
const pendingPreviews = new Map<string, { ts: number; upstreamToken?: string }>();

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
 * Sizes of the two preview maps (for testing only).
 * @internal
 */
export function getPendingPreviewCounts(): { previews: number; tokens: number } {
  return { previews: pendingPreviews.size, tokens: tokenIndex.size };
}

/**
 * Result of the confirmation flow evaluation.
 *
 * - `respond`: return the response directly to the client (preview, error, etc.)
 *   `isError: true` marks rejections (invalid/conflicting parameters, missing
 *   or expired preview) so the tool result carries the MCP `isError` flag;
 *   preview responses (CONFIRMATION_REQUIRED) are successful workflow steps.
 * - `execute`: proceed with execution using the (possibly modified) effectiveArgs
 *
 * There is deliberately no pass-through variant: every destructive call either
 * gets an explicit response or an explicit execute decision, so a new branch
 * that forgets to decide cannot silently fall through to execution.
 */
export type ConfirmationResult =
  | { action: 'respond'; response: TextContent[]; isError?: boolean }
  | { action: 'execute'; effectiveArgs: Record<string, unknown> };

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
    // Null prototype so hostile keys like __proto__ become own enumerable
    // properties instead of hitting Object.prototype accessors and vanishing
    // from the serialized key.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Generate a unique preview key for a tool call.
 * Excludes confirmation-related parameters (confirm, the resolved confirm_*,
 * user_confirmed, dry_run) from the key to ensure preview and execution calls match.
 * With `usesPreviewToken`, `preview_token` is left out as well: the ability
 * issues it in its own dry run, so it is null on the preview and a string on
 * the confirmed call, and the Dashboard decides whether that string is valid.
 * Prefixed with the config identity hash: the preview maps are module-level,
 * so without the scope a token issued against one dashboard/principal could
 * confirm the same tool and arguments against another createServer(config)
 * instance in the same process.
 * The arguments enter the key as a digest: MAX_PENDING_PREVIEWS counts
 * entries, not bytes, and a tool may declare room for megabytes per string.
 * @internal exported for tests
 */
export function getPreviewKey(
  scope: string,
  toolName: string,
  args: Record<string, unknown>,
  confirmationParam: string,
  usesPreviewToken = false
): string {
  const relevantArgs = { ...args };
  delete relevantArgs.confirm;
  delete relevantArgs.user_confirmed;
  delete relevantArgs.dry_run;
  delete relevantArgs.confirmation_token;
  delete relevantArgs[confirmationParam];
  if (usesPreviewToken) delete relevantArgs.preview_token;
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(relevantArgs)))
    .digest('hex');
  return `${scope}:${toolName}:${digest}`;
}

/**
 * Read the `preview_token` an ability's dry run issued, or undefined when the
 * response carries none worth sending back. The response is remote input that
 * has already been through secret redaction, so only an own top-level string
 * in a narrow opaque-token shape is accepted. A redaction marker falls outside
 * the character set and is dropped like any other malformed value. A dropped
 * value is not an error: the caller can still relay the token itself.
 * @internal exported for tests
 */
export function capturePreviewToken(
  result: unknown,
  tokenSchema: Record<string, unknown>
): string | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  if (!Object.hasOwn(result, 'preview_token')) return undefined;
  const token = (result as Record<string, unknown>).preview_token;
  if (
    typeof token !== 'string' ||
    token.length < 16 ||
    token.length > 256 ||
    !/^[A-Za-z0-9._~-]+$/.test(token)
  ) {
    return undefined;
  }
  for (const bound of ['minLength', 'maxLength'] as const) {
    if (!Object.hasOwn(tokenSchema, bound)) continue;
    const limit = tokenSchema[bound];
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) continue;
    if (bound === 'minLength' ? token.length < limit : token.length > limit) return undefined;
  }
  return token;
}

/**
 * Clean up expired preview keys and enforce maximum preview limit.
 */
function cleanupExpiredPreviews(): void {
  const now = Date.now();

  // First pass: Remove expired entries
  for (const [key, entry] of pendingPreviews.entries()) {
    if (now - entry.ts > PREVIEW_EXPIRY_MS) {
      pendingPreviews.delete(key);
    }
  }

  // Second pass: Enforce the cap, oldest publication first. Map order is
  // publication order because a repeat preview re-inserts its key, and unlike
  // `ts` it still separates previews made in the same millisecond.
  for (const key of pendingPreviews.keys()) {
    if (pendingPreviews.size <= MAX_PENDING_PREVIEWS) break;
    pendingPreviews.delete(key);
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
 * - `respond`: early-return response (preview, validation error, expired,
 *   or fail-closed rejection of an ability with no confirm channel)
 * - `execute`: proceed with modified args (user confirmed, or declared dry_run)
 */
export async function handleConfirmationFlow(
  params: ConfirmationFlowParams
): Promise<ConfirmationResult> {
  const { config, ability, toolName, abilityName, args, effectiveArgs, logger, signal } = params;
  // Check if tool supports confirmation parameter. Usable means the declared
  // subschema can accept the literal `true` we send — a `confirm: false` or
  // `confirm: {type: "string"}` declaration has no working channel and takes
  // the same fail-closed path as an absent key.
  const schemaProps = ability.input_schema?.properties;
  const confirmationParam = resolveConfirmationParam(ability.input_schema);
  const ctx: ConfirmationContext = {
    tool: toolName,
    ability: abilityName,
    confirmationParam,
  };
  const hasConfirmParam = confirmationParam !== undefined;
  const canPreview =
    confirmationParam === 'confirm' && declaresUsableBooleanParam(schemaProps, 'dry_run');
  const usesPreviewToken = canPreview && declaresNullablePreviewToken(schemaProps);

  // Fail closed: a destructive ability that declares no confirm parameter has
  // no confirmation channel, so while confirmation is required it can never
  // execute — regardless of user_confirmed, dry_run, or any other arguments.
  // Anything permissive here would let an unannotated or third-party ability
  // bypass the two-phase flow entirely.
  if (!hasConfirmParam) {
    logger.warning('Destructive ability declares no confirm parameter - failing closed', {
      toolName,
      abilityName,
    });
    return {
      action: 'respond',
      response: [
        { type: 'text', text: formatJson(config, buildConfirmationUnsupportedResponse(ctx)) },
      ],
      isError: true,
    };
  }

  // Validation: Conflicting parameters (user_confirmed + dry_run)
  if (confirmationParam === 'confirm' && args.user_confirmed === true && args.dry_run === true) {
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

  // Case 1: Explicit dry_run bypass for conventional confirm abilities.
  // A named confirm_* must stay true in upstream input, so it cannot be
  // removed for dry_run. Undeclared dry_run is also rejected before any
  // upstream call.
  if (args.dry_run === true) {
    if (!canPreview) {
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
    // An ability that requires confirm gets an explicit false. Optional keys
    // stay absent, see requiresUsableFalseParam.
    const dryRunArgs = { ...effectiveArgs };
    delete dryRunArgs.confirm;
    delete dryRunArgs[confirmationParam!];
    if (requiresUsableFalseParam(ability.input_schema, 'confirm')) {
      dryRunArgs.confirm = false;
    }
    return { action: 'execute', effectiveArgs: dryRunArgs };
  }

  // Case 2: Preview request (confirm: true without user_confirmed)
  if (args[confirmationParam!] === true && args.user_confirmed !== true) {
    // Only conventional confirm abilities with declared dry_run get an
    // upstream preview. Named confirm_* fields must stay true in input, so
    // they use the token-only path even if dry_run is declared.
    let previewResult: unknown = null;
    let upstreamToken: string | undefined;
    if (canPreview) {
      // An ability that requires confirm gets an explicit false. Optional keys
      // stay absent, see requiresUsableFalseParam.
      const previewArgs: Record<string, unknown> = { ...effectiveArgs, dry_run: true };
      delete previewArgs[confirmationParam!];
      if (requiresUsableFalseParam(ability.input_schema, 'confirm')) {
        previewArgs.confirm = false;
      }
      // The dry run issues the token and rejects a call that already carries
      // one, so the caller's value never goes out on the preview. Required
      // keys get an explicit null and optional keys stay absent, as above.
      if (usesPreviewToken) {
        const schema = ability.input_schema!;
        if (
          Object.hasOwn(schema, 'required') &&
          Array.isArray(schema.required) &&
          schema.required.includes('preview_token')
        ) {
          previewArgs.preview_token = null;
        } else {
          delete previewArgs.preview_token;
        }
      }
      previewResult = await executeAbility(
        config,
        abilityName,
        previewArgs,
        logger,
        ability,
        signal
      );
      if (usesPreviewToken) {
        upstreamToken = capturePreviewToken(
          previewResult,
          (schemaProps as Record<string, Record<string, unknown>>).preview_token
        );
      }
    } else {
      logger.warning(
        confirmationParam === 'confirm'
          ? 'Preview unavailable - ability does not support dry_run'
          : 'Preview unavailable for named confirmation parameter',
        {
          toolName,
          abilityName,
        }
      );
    }

    const previewKey = getPreviewKey(
      configIdentityHash(config),
      toolName,
      args,
      confirmationParam!,
      usesPreviewToken
    );
    const token = crypto.randomUUID();
    const confirmationResponse = canPreview
      ? buildConfirmationRequiredResponse(ctx, previewResult, token)
      : buildNoPreviewAvailableResponse(ctx, token);
    const previewResponse = formatJson(config, confirmationResponse);

    // Accounting runs before anything is recorded. When it throws, the caller
    // never receives this response, so both maps stay as they were and an
    // earlier preview of the same key keeps its token.
    trackSessionData(previewResponse, config, logger, 'during preview');

    // Delete first: Map.set on an existing key keeps its old position, and
    // the cap evicts in Map order.
    pendingPreviews.delete(previewKey);
    pendingPreviews.set(previewKey, {
      ts: Date.now(),
      ...(upstreamToken === undefined ? {} : { upstreamToken }),
    });

    // The new token replaces any earlier one for this preview key
    for (const [existingToken, existingKey] of tokenIndex.entries()) {
      if (existingKey === previewKey) {
        tokenIndex.delete(existingToken);
        break;
      }
    }
    tokenIndex.set(token, previewKey);

    // Runs after the insert so the cap holds on return. The entry just
    // recorded is last in Map order and survives.
    cleanupExpiredPreviews();

    logger.info(
      canPreview ? 'Preview generated for confirmation' : 'Confirmation required without preview',
      { toolName }
    );

    return {
      action: 'respond',
      response: [{ type: 'text', text: previewResponse }],
    };
  }

  // Case 3: Confirmed execution (user_confirmed: true)
  if (args.user_confirmed === true) {
    // Warning: Ambiguous parameters (confirm + user_confirmed both set)
    if (args[confirmationParam!] === true) {
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
    // Verify token belongs to this tool AND this config identity (prevent
    // cross-tool reuse and cross-dashboard/principal reuse alike)
    if (!tokenPreviewKey.startsWith(`${configIdentityHash(config)}:${toolName}:`)) {
      tokenIndex.delete(confirmationToken);
      logger.warning('Confirmation failed - token belongs to a different tool or identity', {
        toolName,
      });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
        isError: true,
      };
    }
    // Verify token matches current arguments (prevent arg-swap)
    const currentPreviewKey = getPreviewKey(
      configIdentityHash(config),
      toolName,
      args,
      confirmationParam!,
      usesPreviewToken
    );
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
    const previewEntry = pendingPreviews.get(previewKey);

    if (previewEntry === undefined) {
      logger.warning('Confirmation failed - no preview found', { toolName });
      return {
        action: 'respond',
        response: [{ type: 'text', text: formatJson(config, buildPreviewRequiredResponse(ctx)) }],
        isError: true,
      };
    }

    if (Date.now() - previewEntry.ts > PREVIEW_EXPIRY_MS) {
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
    const upstreamToken = previewEntry.upstreamToken;
    pendingPreviews.delete(previewKey);
    tokenIndex.delete(confirmationToken);
    const previewAge = Date.now() - previewEntry.ts;
    logger.info('User confirmation validated', { toolName, previewAge });

    // Confirmation credentials belong to this server, not the upstream ability.
    const {
      user_confirmed: _user_confirmed,
      confirmation_token: _confirmation_token,
      ...confirmedArgs
    } = effectiveArgs;
    delete confirmedArgs.confirm;
    delete confirmedArgs[confirmationParam!];
    // A token string from the caller always wins: it may come from a later
    // dry run that replaced the one stored here. The stored token only fills
    // in for a caller that repeated the preview arguments.
    if (
      usesPreviewToken &&
      (confirmedArgs.preview_token === null || confirmedArgs.preview_token === undefined) &&
      upstreamToken !== undefined
    ) {
      confirmedArgs.preview_token = upstreamToken;
    }
    if (
      confirmationParam === 'confirm' &&
      requiresUsableFalseParam(ability.input_schema, 'dry_run')
    ) {
      // An ability that requires dry_run gets an explicit false. Optional keys
      // stay absent, see requiresUsableFalseParam.
      confirmedArgs.dry_run = false;
    }

    return {
      action: 'execute',
      effectiveArgs: { ...confirmedArgs, [confirmationParam!]: true },
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
            `Destructive tools require confirmation parameters; neither ${confirmationParam} nor user_confirmed was provided`
          )
        ),
      },
    ],
    isError: true,
  };
}
