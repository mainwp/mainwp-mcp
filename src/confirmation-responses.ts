/**
 * Confirmation Flow Response Builders
 *
 * Centralized construction of domain-level JSON payloads for the two-phase
 * confirmation flow. These are workflow responses returned as successful
 * tool results to guide the AI's next action - distinct from protocol-level
 * MCP errors in errors.ts.
 */

import { buildUpdatePlanSummary, validateUpdatePlan } from './update-plan.js';

/**
 * Common context for confirmation-related responses
 */
export interface ConfirmationContext {
  tool: string;
  ability: string;
  confirmationParam?: string;
}

/**
 * Response when safe mode blocks a destructive operation
 */
export function buildSafeModeBlockedResponse(ctx: ConfirmationContext): object {
  return {
    error: 'SAFE_MODE_BLOCKED',
    message: `Safe mode blocked destructive operation: ${ctx.tool}`,
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      reason: 'Destructive operations are disabled in safe mode.',
      resolution:
        'To execute this operation, disable safe mode by setting MAINWP_SAFE_MODE=false or use a non-production environment.',
    },
  };
}

/**
 * Response when a destructive ability declares no confirm parameter. Such an
 * ability has no confirmation channel, so while requireUserConfirmation is on
 * the call fails closed regardless of arguments — executing it would silently
 * skip the two-phase flow the configuration demands.
 */
export function buildConfirmationUnsupportedResponse(ctx: ConfirmationContext): object {
  return {
    error: 'CONFIRMATION_UNSUPPORTED',
    message: `Destructive operation cannot be confirmed: ${ctx.tool}`,
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      reason:
        'This ability is classified destructive but does not declare a confirm parameter, so the required confirmation flow cannot run.',
      resolution:
        'Have the Dashboard declare confirm support for this ability (or annotate it destructive: false if misclassified). Tool filtering cannot make it executable; blockedTools can only remove it from the catalog.',
    },
  };
}

/**
 * Response when dry_run cannot be used with the resolved confirmation channel.
 * The ability either does not declare dry_run or requires a named confirm_*
 * field that cannot be removed from upstream input.
 */
export function buildDryRunNotSupportedResponse(ctx: ConfirmationContext): object {
  return {
    error: 'INVALID_PARAMETER',
    message: 'dry_run parameter not supported for this tool',
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      reason:
        ctx.confirmationParam && ctx.confirmationParam !== 'confirm'
          ? 'This confirmation parameter requires true, so a dry_run preview cannot be sent upstream'
          : 'This ability does not declare a dry_run parameter, so a preview cannot be guaranteed upstream',
      resolution: `Remove dry_run and call with ${ctx.confirmationParam ?? 'confirm'}: true to start the confirmation flow`,
    },
  };
}

/**
 * Response when user_confirmed and dry_run are both set (conflicting intent)
 */
export function buildConflictingParametersResponse(ctx: ConfirmationContext): object {
  return {
    error: 'CONFLICTING_PARAMETERS',
    message: 'Cannot use user_confirmed and dry_run together',
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      reason: 'dry_run is for read-only previews, user_confirmed is for confirmed execution',
      resolution:
        'Remove dry_run to execute with confirmation, or remove user_confirmed to preview only',
    },
  };
}

/**
 * Response when a confirm-capable tool cannot generate a dry-run preview.
 * Still a CONFIRMATION_REQUIRED workflow step — a token is issued so the
 * confirmed follow-up call can proceed — but carries no preview payload.
 */
export function buildNoPreviewAvailableResponse(ctx: ConfirmationContext, token: string): object {
  return {
    status: 'CONFIRMATION_REQUIRED',
    next_action: 'confirm_without_preview',
    message:
      ctx.confirmationParam && ctx.confirmationParam !== 'confirm'
        ? `No upstream dry_run preview is available for ${ctx.confirmationParam}: true. Explicit user approval is required to proceed.`
        : 'This ability does not support dry_run, so no preview is available. ' +
          'Explicit user approval is required to proceed.',
    preview: null,
    confirmation_token: token,
    instructions:
      'Describe to the user exactly what this operation will do. A message that merely requests ' +
      'the operation is not approval: unless the user explicitly authorized proceeding through ' +
      'confirmation (for example "this is authorized, proceed without asking"), stop and wait ' +
      'for an approving reply sent after they see that description. Only with that ' +
      'authorization or reply, call this tool again with user_confirmed: true and ' +
      'confirmation_token: "<token above>".',
    metadata: {
      tool: ctx.tool,
      ability: ctx.ability,
      expiresIn: '5 minutes',
    },
  };
}

/**
 * Response when a preview is generated and confirmation is required
 */
export function buildConfirmationRequiredResponse(
  ctx: ConfirmationContext,
  preview: unknown,
  token: string
): object {
  const plan = validateUpdatePlan(preview);
  return {
    status: 'CONFIRMATION_REQUIRED',
    next_action: 'show_preview_and_confirm',
    message: 'Preview generated. Review the changes below and confirm to proceed.',
    preview,
    ...(plan ? { plan_summary: buildUpdatePlanSummary(plan) } : {}),
    confirmation_token: token,
    instructions:
      'Show the preview to the user. A message that merely requests the operation is not ' +
      'approval: unless the user explicitly authorized proceeding through confirmation, stop ' +
      'and wait for an approving reply sent after they see the preview. Only with that ' +
      'authorization or reply, call this tool again with user_confirmed: true and ' +
      'confirmation_token: "<token above>".',
    metadata: {
      tool: ctx.tool,
      ability: ctx.ability,
      expiresIn: '5 minutes',
    },
  };
}

/**
 * Response when confirmed execution is impossible because no valid preview
 * exists. Default reason covers the user_confirmed-without-preview case;
 * pass a specific reason for other paths (e.g. no confirmation parameters).
 */
export function buildPreviewRequiredResponse(
  ctx: ConfirmationContext,
  reason = ctx.confirmationParam && ctx.confirmationParam !== 'confirm'
    ? 'user_confirmed: true requires a prior confirmation token request'
    : 'user_confirmed: true requires a prior preview request'
): object {
  return {
    error: 'PREVIEW_REQUIRED',
    next_action: 'request_preview_first',
    message:
      ctx.confirmationParam && ctx.confirmationParam !== 'confirm'
        ? `No confirmation token found. You must first call with ${ctx.confirmationParam}: true to request a token.`
        : 'No preview found. You must first call with confirm: true to generate a preview.',
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      reason,
      resolution:
        ctx.confirmationParam && ctx.confirmationParam !== 'confirm'
          ? `Call the tool with ${ctx.confirmationParam}: true (without user_confirmed) to request a token first.`
          : 'Call the tool with confirm: true (without user_confirmed) to generate a preview first.',
    },
  };
}

/**
 * Response when the preview has expired (older than 5 minutes)
 */
export function buildPreviewExpiredResponse(ctx: ConfirmationContext): object {
  return {
    error: 'PREVIEW_EXPIRED',
    next_action: 'request_new_preview',
    message: 'Preview has expired. Please request a new preview.',
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      reason: 'Preview expired after 5 minutes',
      resolution:
        ctx.confirmationParam && ctx.confirmationParam !== 'confirm'
          ? `Call the tool again with ${ctx.confirmationParam}: true to request a fresh token.`
          : 'Call the tool again with confirm: true to generate a fresh preview.',
    },
  };
}

/**
 * Response when an idempotent operation had no effect (already in desired state)
 */
export function buildNoChangeResponse(
  ctx: ConfirmationContext,
  code: string,
  reason: string
): object {
  return {
    status: 'NO_CHANGE',
    message: `Operation had no effect: ${ctx.tool}`,
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      code,
      reason,
    },
  };
}
