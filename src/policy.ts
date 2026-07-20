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
  'allow' | 'blocked-by-policy' | 'safe-mode-blocked' | 'needs-confirmation';

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
 * Fail-closed destructive classification: only a literal boolean `false` is
 * non-destructive. Missing annotations, null, and malformed non-boolean
 * values (a hostile or sloppy Dashboard emitting `0`, `''`, `'yes'`) all
 * classify as destructive. This is strictly tighter than the pre-refactor
 * `?? true` truthiness (2026-07-17 adversarial-review decision): falsy
 * non-boolean values used to slip through as non-destructive. The
 * malformed-annotation warning stays with the executor — this function only
 * classifies.
 *
 * The parameter is typed structurally so this module stays free of
 * abilities.ts (and transitively SDK) imports.
 */
export function classifyDestructive(annotations: { destructive?: boolean } | undefined): boolean {
  return annotations?.destructive !== false;
}

/** Return whether a tool is permitted by the configured allow/block lists. */
export function isToolAllowed(config: Config, toolName: string): boolean {
  return decidePolicy(config, toolName) === 'allow';
}

/**
 * Whether an ability's input-schema properties declare a parameter that can
 * actually accept the literal `true` this server sends for it (confirm,
 * dry_run). Presence alone is not capability: a `false` boolean subschema or
 * `{type: "string"}` provably rejects `true`, so the declared channel is
 * unusable and callers must treat it exactly like an absent key (fail closed
 * for confirm, reject fabricated dry_run). Deliberately permissive otherwise —
 * `{}`, a description-only subschema, or a missing `type` all accept `true`,
 * and rejecting those would break legitimately sloppy abilities.
 *
 * Takes the RAW fetched properties, not a presentation-coerced copy: tool
 * conversion rewrites non-object property values to `{}`, which would make an
 * unusable channel look usable and split discovery from execution.
 */
export function declaresUsableBooleanParam(properties: unknown, name: string): boolean {
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return false;
  }
  if (!Object.hasOwn(properties, name)) return false;
  const sub: unknown = (properties as Record<string, unknown>)[name];
  if (sub === true) return true; // boolean schema: accepts any instance
  if (sub === false) return false; // boolean schema: accepts nothing
  if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) return false;
  const schema = sub as Record<string, unknown>;
  const type: unknown = schema.type;
  if (typeof type === 'string' && type !== 'boolean') return false;
  if (Array.isArray(type) && !type.includes('boolean')) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(true)) return false;
  if (Object.hasOwn(schema, 'const') && schema.const !== true) return false;
  return true;
}
