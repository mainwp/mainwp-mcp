/**
 * MCP resource handling: URI validation and ReadResource dispatch.
 *
 * URI Handling Convention:
 * - Static URIs (mainwp://abilities, mainwp://categories, mainwp://status, mainwp://help)
 *   use direct equality checks for performance.
 * - Dynamic/parameterized URIs (mainwp://site/{id}, mainwp://help/tool/{name})
 *   MUST be routed through validateResourceUri() for security validation.
 * - Do not introduce new dynamic URI patterns without using validateResourceUri().
 */

import { Config, formatJson } from './config.js';
import {
  fetchAbilities,
  fetchCategories,
  executeAbility,
  getAbilityByToolName,
  type Ability,
} from './abilities.js';
import { generateHelpDocument, generateToolHelp } from './help.js';
import { getSessionDataUsage } from './session.js';
import { sanitizeError } from './security.js';
import { abilityNameToToolName } from './naming.js';
import { decidePolicy } from './policy.js';
import { formatErrorResponse, getErrorMessage, McpErrorFactory } from './errors.js';
import type { Logger } from './logging.js';

/**
 * Response shape of a ReadResource handler.
 * A type alias (not interface) so it gets an implicit index signature and
 * stays assignable to the SDK's handler return type (same reasoning as
 * ToolCallResult in tools.ts).
 */
export type ResourceResponse = {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
};

/**
 * Filter abilities down to those the tool policy allows.
 *
 * Policy decision (2026-07-17, reverses `resources-describe-full-catalog`):
 * the informational `mainwp://abilities` and `mainwp://help` resources honor
 * `allowedTools`/`blockedTools` like ListTools does, so a blocked tool is
 * redacted from discovery, documentation, and execution alike. Ability names
 * are validated by fetchAbilities (ABILITY_NAME_RE) before they reach this
 * mapping, so abilityNameToToolName cannot throw here.
 */
function filterAbilitiesByPolicy(config: Config, abilities: Ability[]): Ability[] {
  const primaryNamespace = config.abilityNamespaces[0];
  return abilities.filter(
    ability =>
      decidePolicy(config, abilityNameToToolName(ability.name, primaryNamespace)) === 'allow'
  );
}

/**
 * Validate and parse a resource URI.
 * Only allows known URI patterns to prevent injection attacks.
 * Decodes URL-encoded characters before validation.
 */
export function validateResourceUri(uri: string): {
  type: string;
  params?: Record<string, string | number>;
} {
  // Decode URI to handle URL-encoded characters (e.g., %20, %2F)
  let decodedUri: string;
  try {
    decodedUri = decodeURIComponent(uri);
  } catch (error) {
    // Handle malformed URIs (invalid percent-encoding)
    throw McpErrorFactory.invalidParams('Malformed URI: invalid percent-encoding', {
      uri,
      error: getErrorMessage(error),
    });
  }

  const staticUris = [
    'mainwp://abilities',
    'mainwp://categories',
    'mainwp://status',
    'mainwp://help',
  ];
  if (staticUris.includes(decodedUri)) {
    return { type: decodedUri.replace('mainwp://', '') };
  }

  // Match mainwp://site/{id} pattern with strict numeric ID
  const siteMatch = decodedUri.match(/^mainwp:\/\/site\/(\d+)$/);
  if (siteMatch) {
    const siteId = parseInt(siteMatch[1], 10);
    if (siteId < 1 || siteId > Number.MAX_SAFE_INTEGER) {
      throw McpErrorFactory.invalidParams(
        'Invalid site ID: must be between 1 and ' + Number.MAX_SAFE_INTEGER,
        { uri, siteId }
      );
    }
    return { type: 'site', params: { site_id: siteId } };
  }

  // Match mainwp://help/tool/{tool_name} pattern (lowercase only, matches tool name format)
  const toolHelpMatch = decodedUri.match(/^mainwp:\/\/help\/tool\/([a-z0-9_]+)$/);
  if (toolHelpMatch) {
    return { type: 'tool-help', params: { tool_name: toolHelpMatch[1] } };
  }

  throw McpErrorFactory.resourceNotFound(uri);
}

/**
 * Handle a ReadResource request for any mainwp:// URI.
 * Errors are returned as an error payload in `contents` (not thrown), matching
 * the MCP resource contract.
 */
export async function handleReadResource(
  config: Config,
  uri: string,
  logger: Logger
): Promise<ResourceResponse> {
  const jsonResource = (data: unknown): ResourceResponse => ({
    contents: [{ uri, mimeType: 'application/json', text: formatJson(config, data) }],
  });

  try {
    // Static URI handlers (no validation needed - exact match)
    if (uri === 'mainwp://abilities') {
      const abilities = await fetchAbilities(config, false, logger);
      return jsonResource(filterAbilitiesByPolicy(config, abilities));
    }

    if (uri === 'mainwp://categories') {
      return jsonResource(await fetchCategories(config, false, logger));
    }

    if (uri === 'mainwp://status') {
      // Redact dashboardUrl to host-only to avoid leaking full URL path to untrusted MCP clients
      let redactedHost: string;
      try {
        redactedHost = new URL(config.dashboardUrl).host;
      } catch {
        redactedHost = '[invalid-url]';
      }

      try {
        const abilities = await fetchAbilities(config, true, logger); // Force refresh
        return jsonResource({
          connected: true,
          dashboardHost: redactedHost,
          abilitiesCount: abilities.length,
          sessionData: getSessionDataUsage(config),
        });
      } catch (error) {
        return jsonResource({
          connected: false,
          dashboardHost: redactedHost,
          error: sanitizeError(getErrorMessage(error)),
        });
      }
    }

    if (uri === 'mainwp://help') {
      const abilities = await fetchAbilities(config, false, logger);
      return jsonResource(
        generateHelpDocument(
          filterAbilitiesByPolicy(config, abilities),
          config.abilityNamespaces[0]
        )
      );
    }

    // Validate and parse the resource URI (throws on invalid URIs)
    const parsed = validateResourceUri(uri);

    if (parsed.type === 'site' && parsed.params?.site_id) {
      // Derive the exposed tool name so allow/block lists keyed on
      // namespaced names (non-mainwp primary namespace) still apply
      const getSiteToolName = abilityNameToToolName(
        'mainwp/get-site-v1',
        config.abilityNamespaces[0]
      );
      if (decidePolicy(config, getSiteToolName) !== 'allow') {
        throw McpErrorFactory.permissionDenied(`Tool is not allowed: ${getSiteToolName}`);
      }
      const result = await executeAbility(
        config,
        'mainwp/get-site-v1',
        { site_id: parsed.params.site_id },
        logger
      );
      return jsonResource(result);
    }

    if (parsed.type === 'tool-help' && parsed.params?.tool_name) {
      const toolName = parsed.params.tool_name as string;

      // Policy gate before ability resolution so a blocked-but-existing tool
      // is indistinguishable from a nonexistent one (no catalog probing).
      if (decidePolicy(config, toolName) !== 'allow') {
        throw McpErrorFactory.permissionDenied(`Tool is not allowed: ${toolName}`);
      }

      const ability = await getAbilityByToolName(config, toolName, logger);
      if (!ability) {
        throw McpErrorFactory.resourceNotFound(uri);
      }

      return jsonResource(generateToolHelp(ability, config.abilityNamespaces[0]));
    }

    throw new Error(`Unhandled resource type: ${parsed.type}`);
  } catch (error) {
    return {
      contents: [
        { uri, mimeType: 'application/json', text: formatErrorResponse(error, sanitizeError) },
      ],
    };
  }
}
