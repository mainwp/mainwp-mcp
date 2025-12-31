/**
 * Name Conversion Utilities
 *
 * Shared functions for converting between MainWP ability names and MCP tool names.
 * Extracted to avoid circular imports between abilities.ts and tools.ts.
 */

/**
 * Convert ability name to MCP tool name
 * Strips namespace prefix since MCP server name provides context.
 * e.g., "mainwp/list-sites-v1" -> "list_sites_v1"
 */
export function abilityNameToToolName(abilityName: string): string {
  // Strip namespace prefix: "mainwp/list-sites-v1" → "list-sites-v1"
  const slashIndex = abilityName.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(`Invalid ability name format (missing namespace): ${abilityName}`);
  }
  const withoutNamespace = abilityName.slice(slashIndex + 1);
  // Convert hyphens to underscores: "list-sites-v1" → "list_sites_v1"
  return withoutNamespace.replace(/-/g, '_');
}

/**
 * Map MCP tool name back to ability name.
 * Prepends the namespace since tool names don't include it.
 *
 * Note: This server only uses the 'mainwp' namespace. The namespace parameter
 * is kept for test flexibility but is always called with 'mainwp' in production.
 *
 * @example toolNameToAbilityName("list_sites_v1", "mainwp") -> "mainwp/list-sites-v1"
 */
export function toolNameToAbilityName(toolName: string, namespace: string): string {
  // Convert underscores back to hyphens: "list_sites_v1" → "list-sites-v1"
  const withHyphens = toolName.replace(/_/g, '-');
  // Prepend namespace: "mainwp/list-sites-v1"
  return `${namespace}/${withHyphens}`;
}
