#!/usr/bin/env node
/**
 * MainWP MCP Server
 *
 * Model Context Protocol server that exposes MainWP Dashboard abilities
 * as MCP tools for AI assistants like Claude.
 *
 * Usage:
 *   MAINWP_URL=https://dashboard.local MAINWP_TOKEN=xxx node dist/index.js
 *
 * Environment Variables:
 *   - MAINWP_URL: Base URL of MainWP Dashboard (required)
 *   - MAINWP_USER + MAINWP_APP_PASSWORD: WordPress Application Password authentication
 *   - MAINWP_TOKEN: Compatibility-only bearer token (expected to fail against Abilities API)
 *   - MAINWP_SKIP_SSL_VERIFY: Set to "true" to skip SSL verification (optional)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, Config, formatJson } from './config.js';
import { getTools, executeTool, isToolAllowed } from './tools.js';
import { getSessionDataUsage, formatBytes } from './session.js';
import {
  fetchAbilities,
  fetchCategories,
  clearCache,
  onCacheRefresh,
  executeAbility,
  initRateLimiter,
  getAbilityByToolName,
  type Ability,
} from './abilities.js';
import { generateHelpDocument, generateToolHelp } from './help.js';
import { getPromptList, getPrompt, getPromptArgumentCompletions } from './prompts.js';
import { createLogger, createStderrLogger, type Logger } from './logging.js';
import { sanitizeError, isValidId } from './security.js';
import {
  formatErrorResponse,
  getErrorMessage,
  getHttpStatus,
  McpErrorFactory,
  McpError,
} from './errors.js';

// Server metadata
const SERVER_NAME = 'mainwp-mcp';
const SERVER_VERSION = '1.0.0-beta.3';

// Completion limits
const MAX_COMPLETION_SUGGESTIONS = 20;

/**
 * Validate and parse a resource URI.
 * Only allows known URI patterns to prevent injection attacks.
 * Decodes URL-encoded characters before validation.
 */
function validateResourceUri(uri: string): {
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
 * Create and configure the MCP server
 */
export async function createServer(config: Config): Promise<{ server: Server; logger: Logger }> {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
        logging: {},
        completions: {},
      },
    }
  );

  // Create structured logger
  const logger = createLogger(server);

  // Handler: List available tools (derived from abilities)
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const tools = await getTools(config, logger);
      return { tools };
    } catch (error) {
      logger.error('Error listing tools', {
        error: getErrorMessage(error),
      });
      return { tools: [] };
    }
  });

  // Handler: Execute a tool call
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    try {
      // Pass abort signal for cancellation support; executeTool returns the
      // full CallToolResult shape including isError on failed calls
      return await executeTool(config, name, (args as Record<string, unknown>) ?? {}, logger, {
        signal: extra.signal,
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: formatErrorResponse(error, sanitizeError),
          },
        ],
        isError: true,
      };
    }
  });

  // Handler: List available resources (abilities info, categories, help)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'mainwp://abilities',
          name: 'MainWP Abilities',
          description: 'List of all available MainWP abilities with their schemas',
          mimeType: 'application/json',
        },
        {
          uri: 'mainwp://categories',
          name: 'MainWP Categories',
          description: 'List of ability categories',
          mimeType: 'application/json',
        },
        {
          uri: 'mainwp://status',
          name: 'Connection Status',
          description: 'Current connection status to MainWP Dashboard',
          mimeType: 'application/json',
        },
        {
          uri: 'mainwp://help',
          name: 'MainWP MCP Help',
          description:
            'Tool documentation, safety conventions (dry_run, confirm), and usage guides',
          mimeType: 'application/json',
        },
      ],
    };
  });

  // Handler: Read a resource
  // URI Handling Convention:
  // - Static URIs (mainwp://abilities, mainwp://categories, mainwp://status, mainwp://help)
  //   use direct equality checks for performance.
  // - Dynamic/parameterized URIs (mainwp://site/{id}, mainwp://help/tool/{name})
  //   MUST be routed through validateResourceUri() for security validation.
  // - Do not introduce new dynamic URI patterns without using validateResourceUri().
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const { uri } = request.params;

    const jsonResource = (data: unknown) => ({
      contents: [{ uri, mimeType: 'application/json', text: formatJson(config, data) }],
    });

    try {
      // Static URI handlers (no validation needed - exact match)
      if (uri === 'mainwp://abilities') {
        return jsonResource(await fetchAbilities(config, false, logger));
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
        return jsonResource(generateHelpDocument(abilities, config.abilityNamespaces[0]));
      }

      // Validate and parse the resource URI (throws on invalid URIs)
      const parsed = validateResourceUri(uri);

      if (parsed.type === 'site' && parsed.params?.site_id) {
        if (!isToolAllowed(config, 'get_site_v1')) {
          throw McpErrorFactory.permissionDenied('Tool is not allowed: get_site_v1');
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
  });

  // Handler: List available prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: getPromptList() };
  });

  // Handler: Get a specific prompt
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    try {
      // Prompt arguments are flat strings. Guard their transport-safe shape
      // here; prompt-specific semantics belong to validatePromptArgs.
      if (args) {
        for (const value of Object.values(args)) {
          // eslint-disable-next-line no-control-regex
          if (value.length > 200 || /[\x00-\x1f]/.test(value)) {
            throw McpErrorFactory.invalidParams(
              'Prompt arguments must be at most 200 characters and contain no control characters'
            );
          }
        }
      }
      return getPrompt(name, args);
    } catch (error) {
      // Preserve structured MCP errors from prompt validation
      if (error instanceof McpError) {
        throw error;
      }
      // Sanitize unexpected errors
      const errorMessage = getErrorMessage(error);
      throw new Error(sanitizeError(errorMessage), { cause: error });
    }
  });

  // Handler: Argument completions
  server.setRequestHandler(CompleteRequestSchema, async request => {
    const { ref, argument } = request.params;

    // Handle prompt argument completions
    if (ref.type === 'ref/prompt') {
      const promptName = ref.name;
      const argName = argument.name;

      // Get static completions for known argument types
      let values = getPromptArgumentCompletions(promptName, argName);

      // For site_id arguments, try to fetch site list dynamically
      if ((argName === 'site_id' || argName === 'site_ids') && values.length === 0) {
        if (!isToolAllowed(config, 'list_sites_v1')) {
          throw McpErrorFactory.permissionDenied('Tool is not allowed: list_sites_v1');
        }
        try {
          const abilities = await fetchAbilities(config, false, logger);
          const listSitesAbility = abilities.find(a => a.name === 'mainwp/list-sites-v1');
          if (listSitesAbility) {
            const result = await executeAbility(config, 'mainwp/list-sites-v1', {}, logger);
            if (Array.isArray(result)) {
              // Filter to only valid site IDs
              values = result
                .filter((site: { id: unknown }) => isValidId(site.id))
                .map((site: { id: number }) => String(site.id));
            }
          }
        } catch (error) {
          // Fail soft — completions are best-effort — but leave a trace so
          // config/auth problems here aren't invisible in production
          logger.debug('Site-id completion lookup failed', {
            error: sanitizeError(getErrorMessage(error)),
          });
        }
      }

      // Filter by current input value if provided
      const currentValue = argument.value || '';
      const filteredValues = values.filter(v =>
        v.toLowerCase().startsWith(currentValue.toLowerCase())
      );

      return {
        completion: {
          values: filteredValues.slice(0, MAX_COMPLETION_SUGGESTIONS),
          hasMore: filteredValues.length > MAX_COMPLETION_SUGGESTIONS,
          total: filteredValues.length,
        },
      };
    }

    // Default: no completions
    return {
      completion: {
        values: [],
        hasMore: false,
        total: 0,
      },
    };
  });

  // Handler: List resource templates
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        {
          uriTemplate: 'mainwp://site/{site_id}',
          name: 'Site Details',
          description: 'Get detailed information about a specific site by ID',
          mimeType: 'application/json',
        },
        {
          uriTemplate: 'mainwp://help/tool/{tool_name}',
          name: 'Tool Documentation',
          description:
            'Get detailed documentation for a specific tool including parameters and safety features',
          mimeType: 'application/json',
        },
      ],
    };
  });

  // Register cache refresh callback for list_changed notifications
  onCacheRefresh(() => {
    server.sendToolListChanged().catch(() => {
      // Ignore if not connected
    });
  });

  return { server, logger };
}

/**
 * Validate credentials by attempting to fetch abilities from the MainWP Dashboard.
 * Provides enhanced error messages for common failure scenarios.
 *
 * @param config - Server configuration
 * @param logger - Logger for status messages
 * @returns The fetched abilities array on success
 * @throws Error with actionable message on failure
 */
async function validateCredentials(config: Config, logger: Logger): Promise<Ability[]> {
  try {
    const abilities = await fetchAbilities(config, false, logger);
    logger.info('Credential validation successful: Connected to MainWP Dashboard');
    return abilities;
  } catch (error) {
    const message = getErrorMessage(error);
    const lowerMessage = message.toLowerCase();

    // HTTP failures carry a structured status (createHttpError in http-client.ts);
    // classify on that. Message sniffing below is only for non-HTTP failures
    // (DNS, SSL, timeout) which have no status to inspect.
    const status = getHttpStatus(error);

    // Authentication failures (401/403) - provide auth-type specific guidance
    if (status === 401 || status === 403) {
      const authHint =
        config.authType === 'basic'
          ? 'Verify MAINWP_USER and MAINWP_APP_PASSWORD (or username/appPassword in settings.json) are correct and the user has REST API access.'
          : 'Bearer tokens (MAINWP_TOKEN) are not accepted by the Abilities API, which authenticates through native WordPress. Use MAINWP_USER + MAINWP_APP_PASSWORD (a WordPress Application Password / Basic auth) instead.';
      throw new Error(`Authentication failed: Invalid credentials. ${authHint}`, {
        cause: error,
      });
    }

    // Endpoint not found (404) - likely missing Abilities API plugin
    if (status === 404) {
      throw new Error(
        'Abilities API endpoint not found. Verify MAINWP_URL points to a MainWP Dashboard with the Abilities API plugin installed.',
        { cause: error }
      );
    }

    // Connection timeout
    if (lowerMessage.includes('timeout')) {
      throw new Error(
        'Connection timeout. Verify MAINWP_URL is reachable and the server is responding.',
        { cause: error }
      );
    }

    // SSL/TLS certificate errors
    if (
      lowerMessage.includes('certificate') ||
      lowerMessage.includes('ssl') ||
      lowerMessage.includes('tls') ||
      lowerMessage.includes('self-signed') ||
      lowerMessage.includes('unable to verify')
    ) {
      throw new Error(
        'SSL certificate verification failed. For self-signed certificates, set MAINWP_SKIP_SSL_VERIFY=true (development only).',
        { cause: error }
      );
    }

    // Network connectivity errors
    if (
      lowerMessage.includes('enotfound') ||
      lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('network') ||
      lowerMessage.includes('getaddrinfo') ||
      lowerMessage.includes('econnreset')
    ) {
      throw new Error(
        'Network error: Cannot reach MAINWP_URL. Verify the URL is correct and the server is accessible.',
        { cause: error }
      );
    }

    // Other errors - re-throw with prefix
    throw new Error(`Credential validation failed: ${message}`, { cause: error });
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Use stderr logger before server is initialized
  const startupLogger = createStderrLogger();

  try {
    // Load configuration from environment
    const config = loadConfig();

    // Initialize rate limiter
    initRateLimiter(config.rateLimit);

    startupLogger.info(`MainWP MCP Server v${SERVER_VERSION}`);
    startupLogger.info(`Dashboard: ${config.dashboardUrl}`);
    startupLogger.info(`Auth: ${config.authType === 'basic' ? 'Basic Auth' : 'Bearer Token'}`);
    startupLogger.info(`Config source: ${config.configSource}`);
    startupLogger.info(`Session data limit: ${formatBytes(config.maxSessionData)}`);
    if (config.skipSslVerify) {
      startupLogger.error('╔══════════════════════════════════════════════════════════════╗');
      startupLogger.error('║  WARNING: SSL verification disabled                          ║');
      startupLogger.error('║  Connection is vulnerable to man-in-the-middle attacks       ║');
      startupLogger.error('║  Only use for local development with self-signed certs       ║');
      startupLogger.error('╚══════════════════════════════════════════════════════════════╝');
    }

    // The built-in mainwp://site/{id} resource calls mainwp/get-site-v1 and
    // site ID prompt completions call mainwp/list-sites-v1. Without 'mainwp'
    // in the allowlist those abilities are filtered out, so warn up front
    // (see docs/configuration.md, "Keep mainwp in the list").
    if (!config.abilityNamespaces.includes('mainwp')) {
      startupLogger.warning(
        "Namespace allowlist does not include 'mainwp'. The mainwp://site/{id} resource calls " +
          'mainwp/get-site-v1 and site ID prompt completions call mainwp/list-sites-v1; with ' +
          "'mainwp' filtered out, the resource returns an error payload and completions come " +
          "back empty. Add 'mainwp' alongside other namespaces rather than replacing it.",
        { abilityNamespaces: config.abilityNamespaces }
      );
    }

    // Validate credentials with fail-fast behavior
    startupLogger.info('Validating credentials...');
    const abilities = await validateCredentials(config, startupLogger);
    startupLogger.info(`Connected! Found ${abilities.length} abilities`);
    abilities.forEach(a => startupLogger.debug(`  - ${a.name}: ${a.label}`));

    // Create server (returns server + structured logger)
    const { server, logger } = await createServer(config);

    // Connect via stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP server running on stdio');

    // Handle graceful shutdown for both SIGINT and SIGTERM
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      clearCache();
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    startupLogger.error(`Fatal error: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

// Run only when invoked as the program entry point; tests import createServer.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
