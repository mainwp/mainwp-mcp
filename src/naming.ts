/**
 * Name Conversion Utilities
 *
 * Forward-only: ability name → MCP tool name. Reverse lookup
 * (tool name → ability) is handled via the cache index in abilities.ts
 * (see getAbilityByToolName) — tool names are not uniquely decodable.
 */

/**
 * Convert an ability name to its MCP tool name.
 *
 * The function has two output shapes selected by `primaryNamespace`:
 *
 * 1. **Ability is in the primary namespace** — namespace prefix is stripped
 *    (the MCP server name already provides that context):
 *      abilityNameToToolName('mainwp/list-sites-v1', 'mainwp')
 *      → 'list_sites_v1'
 *
 * 2. **Ability is in any other configured namespace** — namespace is kept
 *    with a double-underscore separator so it can't be confused with the
 *    single underscores inside tool names. Hyphens in the namespace itself
 *    are converted to underscores to keep MCP tool names within the
 *    `[a-z0-9_]+` charset that all MCP clients accept:
 *      abilityNameToToolName('acme/do-thing-v1', 'mainwp')
 *      → 'acme__do_thing_v1'
 *      abilityNameToToolName('acme-corp/do-thing-v1', 'mainwp')
 *      → 'acme_corp__do_thing_v1'
 *
 * The `__` separator stays unambiguous because ability slugs cannot contain
 * underscores (enforced by ABILITY_NAME_RE in abilities.ts).
 */
export function abilityNameToToolName(abilityName: string, primaryNamespace: string): string {
  const slashIndex = abilityName.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(`Invalid ability name format (missing namespace): ${abilityName}`);
  }
  const namespace = abilityName.slice(0, slashIndex);
  const rest = abilityName.slice(slashIndex + 1).replace(/-/g, '_');

  if (namespace === primaryNamespace) {
    return rest;
  }
  // Convert hyphens in the namespace too so the tool name stays within
  // [a-z0-9_]+ for MCP client compatibility.
  return `${namespace.replace(/-/g, '_')}__${rest}`;
}
