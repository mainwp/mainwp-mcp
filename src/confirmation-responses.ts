/**
 * Confirmation Flow Response Builders
 *
 * Centralized construction of domain-level JSON payloads for the two-phase
 * confirmation flow. These are workflow responses returned as successful
 * tool results to guide the AI's next action - distinct from protocol-level
 * MCP errors in errors.ts.
 */

/**
 * Common context for confirmation-related responses
 */
export interface ConfirmationContext {
  tool: string;
  ability: string;
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
 * Response when user_confirmed is used on a tool without confirm parameter support
 */
export function buildInvalidParameterResponse(ctx: ConfirmationContext): object {
  return {
    error: 'INVALID_PARAMETER',
    message: 'user_confirmed parameter not supported for this tool',
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      reason: 'This tool does not support the confirmation flow (no confirm parameter)',
      resolution: 'Remove user_confirmed parameter and call the tool directly',
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
 * Response when a preview is generated and confirmation is required
 */
export function buildConfirmationRequiredResponse(
  ctx: ConfirmationContext,
  preview: unknown,
  token: string
): object {
  return {
    status: 'CONFIRMATION_REQUIRED',
    next_action: 'show_preview_and_confirm',
    message: 'Preview generated. Review the changes below and confirm to proceed.',
    preview,
    instructions: 'To execute this operation, call the tool again with user_confirmed: true',
    metadata: {
      tool: ctx.tool,
      ability: ctx.ability,
      expiresIn: '5 minutes',
      confirmation_token: token,
    },
  };
}

/**
 * Response when user_confirmed is set but no preview was requested first
 */
export function buildPreviewRequiredResponse(ctx: ConfirmationContext): object {
  return {
    error: 'PREVIEW_REQUIRED',
    next_action: 'request_preview_first',
    message: 'No preview found. You must first call with confirm: true to generate a preview.',
    details: {
      tool: ctx.tool,
      ability: ctx.ability,
      reason: 'user_confirmed: true requires a prior preview request',
      resolution:
        'Call the tool with confirm: true (without user_confirmed) to generate a preview first.',
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
      resolution: 'Call the tool again with confirm: true to generate a fresh preview.',
    },
  };
}
