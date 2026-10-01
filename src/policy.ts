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
 * The config fields the gate reads. Typed as a subset so setup mode, which
 * has validated policy but no connection identity, passes through the same
 * gate instead of carrying a second copy of the allow/block rules.
 */
export type PolicyGateConfig = Pick<
  Config,
  'allowedTools' | 'blockedTools' | 'safeMode' | 'requireUserConfirmation'
>;

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
  config: PolicyGateConfig,
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
export function isToolAllowed(config: PolicyGateConfig, toolName: string): boolean {
  return decidePolicy(config, toolName) === 'allow';
}

/**
 * Whether an ability's input-schema properties declare a parameter that can
 * accept the requested boolean literal (true by default). Presence alone is
 * not capability: a `false` boolean subschema or `{type: "string"}` rejects
 * both literals, so the declared channel is unusable and callers must treat it
 * exactly like an absent key (fail closed for confirm, reject fabricated
 * dry_run). Deliberately permissive otherwise: `{}`, a description-only
 * subschema, or a missing `type` accept either literal, and rejecting those
 * would break abilities with loosely written schemas.
 *
 * Takes the RAW fetched properties, not a presentation-coerced copy: tool
 * conversion rewrites non-object property values to `{}`, which would make an
 * unusable channel look usable and split discovery from execution.
 */
export function declaresUsableBooleanParam(
  properties: unknown,
  name: string,
  value: boolean = true
): boolean {
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
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Object.hasOwn(schema, 'const') && schema.const !== value) return false;
  return true;
}

/**
 * Whether the confirmation flow should send an explicit `false` for this key.
 * Only required keys qualify: an ability that requires the key already rejects
 * a call without it, so sending `false` cannot break a call that worked before.
 * Optional keys stay absent because GET and DELETE abilities take query-string
 * input, where `false` travels as the string "false" and WordPress versions
 * before 7.1 pass it to the ability without converting it back to a boolean.
 */
export function requiresUsableFalseParam(schema: unknown, name: string): boolean {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (!Object.hasOwn(schema, 'required')) return false;
  const record = schema as Record<string, unknown>;
  return (
    Array.isArray(record.required) &&
    record.required.includes(name) &&
    declaresUsableBooleanParam(record.properties, name, false)
  );
}

/**
 * Whether an ability declares `preview_token` as a string that may also be
 * null. That shape marks an ability whose own dry run issues the token: null
 * on the dry run, the issued string on the confirmed call. Only an explicit
 * type list with both members qualifies. A plain `string` declaration takes
 * its token from a separate preview ability, and a missing or looser type
 * says nothing about the contract, so both keep the caller's value untouched.
 */
export function declaresNullablePreviewToken(properties: unknown): boolean {
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return false;
  }
  if (!Object.hasOwn(properties, 'preview_token')) return false;
  const sub = (properties as Record<string, unknown>).preview_token;
  if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) return false;
  if (!Object.hasOwn(sub, 'type')) return false;
  const type = (sub as Record<string, unknown>).type;
  return Array.isArray(type) && type.includes('string') && type.includes('null');
}

/**
 * List the required `confirm_*` properties whose schema pins them to literal
 * true with `const: true` or `enum: [true]`. Requiring both the naming
 * convention and membership in `required` avoids treating an optional domain
 * boolean as an execution-control channel; pinning it excludes domain flags
 * that also accept false.
 */
export function pinnedConfirmationParams(schema: unknown): string[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return [];
  }
  const required = Array.isArray(record.required) ? record.required : [];
  return required.filter((name): name is string => {
    if (
      typeof name !== 'string' ||
      !/^confirm_[a-z0-9_]+$/.test(name) ||
      !declaresUsableBooleanParam(properties, name)
    ) {
      return false;
    }
    const property = (properties as Record<string, Record<string, unknown>>)[name];
    return (
      property.const === true ||
      (Array.isArray(property.enum) && property.enum.length === 1 && property.enum[0] === true)
    );
  });
}

/**
 * Resolve the one input property that carries trusted confirmation: the
 * conventional `confirm`, or else exactly one pinned `confirm_*` (see
 * pinnedConfirmationParams). Ambiguity fails closed, including `confirm`
 * next to a pinned `confirm_*`: removing only `confirm` from a preview
 * would still send the pinned field as true.
 */
export function resolveConfirmationParam(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const pinned = pinnedConfirmationParams(schema);
  if (declaresUsableBooleanParam((schema as Record<string, unknown>).properties, 'confirm')) {
    return pinned.length === 0 ? 'confirm' : undefined;
  }
  return pinned.length === 1 ? pinned[0] : undefined;
}
