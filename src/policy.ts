/**
 * Pure policy-decision gate — the single policy authority.
 *
 * Every surface that resolves or executes an ability (CallTool, ListTools,
 * resources, completions, tool-help) routes its allow/deny decision through
 * this module. No I/O, no logging, no SDK imports: input is config + tool
 * name (+ destructiveness where the caller has resolved the ability), output
 * is a decision value. Error translation, response formatting, audit logging,
 * and the stateful confirmation token machinery stay with the callers.
 */

import type { Config } from './config.js';

/**
 * Outcome of the policy gate, in precedence order:
 * 1. `blocked-by-policy` — allow/block lists exclude the tool. Evaluated
 *    before ability resolution so a blocked tool is indistinguishable from a
 *    nonexistent one; wins over safe mode and confirmation.
 * 2. `safe-mode-blocked` — destructive tool while `safeMode` is on. Wins
 *    over confirmation: a valid confirmation token never bypasses safe mode.
 * 3. `needs-confirmation` — destructive tool while `requireUserConfirmation`
 *    is on; the caller runs the stateful confirmation flow.
 * 4. `allow`
 */
export type PolicyDecision =
  | 'allow'
  | 'blocked-by-policy'
  | 'safe-mode-blocked'
  | 'needs-confirmation';

/**
 * Decide what the policy permits for a tool.
 *
 * Listing/resolution surfaces (ListTools, resources, completions, tool-help)
 * call without `isDestructive` and only ever observe
 * 'allow' | 'blocked-by-policy' — destructive tools stay listed in safe mode
 * and are blocked at execution instead. The executor passes the resolved
 * destructiveness and can observe all four decisions.
 */
export function decidePolicy(
  config: Config,
  toolName: string,
  isDestructive = false
): PolicyDecision {
  if (config.blockedTools?.includes(toolName)) return 'blocked-by-policy';
  if (config.allowedTools?.length && !config.allowedTools.includes(toolName)) {
    return 'blocked-by-policy';
  }
  if (isDestructive) {
    if (config.safeMode) return 'safe-mode-blocked';
    if (config.requireUserConfirmation) return 'needs-confirmation';
  }
  return 'allow';
}

/**
 * Fail-closed destructive classification: missing or nullish annotations mean
 * destructive. Nullish coalescing (never `||`) so an explicit
 * `destructive: false` is honored, while hostile non-boolean values keep the
 * exact pre-refactor truthiness behavior. The malformed-annotation warning
 * stays with the executor — this function only classifies.
 *
 * The parameter is typed structurally so this module stays free of
 * abilities.ts (and transitively SDK) imports.
 */
export function classifyDestructive(annotations: { destructive?: boolean } | undefined): boolean {
  return Boolean(annotations?.destructive ?? true);
}

/** Return whether a tool is permitted by the configured allow/block lists. */
export function isToolAllowed(config: Config, toolName: string): boolean {
  return decidePolicy(config, toolName) === 'allow';
}
