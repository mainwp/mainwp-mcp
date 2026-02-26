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
 *   - MAINWP_TOKEN: Bearer token for authentication (required)
 *   - MAINWP_SKIP_SSL_VERIFY: Set to "true" to skip SSL verification (optional)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { getTools, executeTool, toolNameToAbilityName, getSessionDataUsage } from './tools.js';
import {
  fetchAbilities,
  fetchCategories,
  clearCache,
  onCacheRefresh,
  executeAbility,
  initRateLimiter,
  getAbility,
  generateHelpDocument,
  generateToolHelp,
  type Ability,
} from './abilities.js';
import { getPromptList, getPrompt, getPromptArgumentCompletions } from './prompts.js';
import { createLogger, createStderrLogger, type Logger } from './logging.js';
import { sanitizeError, isValidId, validateInput } from './security.js';
import { formatErrorResponse, McpErrorFactory, McpError } from './errors.js';

// Server metadata
const SERVER_NAME = 'mainwp-mcp';
const SERVER_VERSION = '1.0.0-beta.1';

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
      error: error instanceof Error ? error.message : String(error),
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
async function createServer(config: Config): Promise<{ server: Server; logger: Logger }> {
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
        error: error instanceof Error ? error.message : String(error),
      });
      return { tools: [] };
    }
  });

  // Handler: Execute a tool call
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    try {
      // Pass abort signal for cancellation support
      const content = await executeTool(
        config,
        name,
        (args as Record<string, unknown>) ?? {},
        logger,
        { signal: extra.signal }
      );
      return { content };
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

    try {
      // Static URI handlers (no validation needed - exact match)
      if (uri === 'mainwp://abilities') {
        const abilities = await fetchAbilities(config, false, logger);
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: formatJson(config, abilities),
            },
          ],
        };
      }

      if (uri === 'mainwp://categories') {
        const categories = await fetchCategories(config, false, logger);
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: formatJson(config, categories),
            },
          ],
        };
      }

      if (uri === 'mainwp://status') {
        // Test connection by fetching abilities
        try {
          const abilities = await fetchAbilities(config, true, logger); // Force refresh
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: formatJson(config, {
                  connected: true,
                  dashboardUrl: config.dashboardUrl,
                  abilitiesCount: abilities.length,
                  abilities: abilities.map(a => a.name),
                  sessionData: getSessionDataUsage(config),
                }),
              },
            ],
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: formatJson(config, {
                  connected: false,
                  dashboardUrl: config.dashboardUrl,
                  error: sanitizeError(errorMsg),
                }),
              },
            ],
          };
        }
      }

      // Handle help resource: comprehensive documentation
      if (uri === 'mainwp://help') {
        const abilities = await fetchAbilities(config, false, logger);
        const helpDoc = generateHelpDocument(abilities);
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: formatJson(config, helpDoc),
            },
          ],
        };
      }

      // Validate and parse the resource URI (throws on invalid URIs)
      const parsed = validateResourceUri(uri);

      // Handle site resource template: mainwp://site/{id}
      if (parsed.type === 'site' && parsed.params?.site_id) {
        const result = await executeAbility(
          config,
          'mainwp/get-site-v1',
          { site_id: parsed.params.site_id },
          logger
        );
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: formatJson(config, result),
            },
          ],
        };
      }

      // Handle tool help resource template: mainwp://help/tool/{tool_name}
      if (parsed.type === 'tool-help' && parsed.params?.tool_name) {
        const toolName = parsed.params.tool_name as string;
        // Hardcoded 'mainwp' namespace - this server only supports MainWP abilities
        const abilityName = toolNameToAbilityName(toolName, 'mainwp');

        const ability = await getAbility(config, abilityName, logger);
        if (!ability) {
          throw McpErrorFactory.resourceNotFound(uri);
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: formatJson(config, generateToolHelp(ability)),
            },
          ],
        };
      }

      // If we get here, the URI was valid but not handled by the code above
      throw new Error(`Unhandled resource type: ${parsed.type}`);
    } catch (error) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: formatErrorResponse(error, sanitizeError),
          },
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
      // Validate prompt arguments before processing
      if (args) {
        validateInput(args as Record<string, unknown>);
      }
      return getPrompt(name, args);
    } catch (error) {
      // Preserve structured MCP errors (e.g., from validateInput)
      if (error instanceof McpError) {
        throw error;
      }
      // Sanitize unexpected errors
      const errorMessage = error instanceof Error ? error.message : String(error);
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
        } catch {
          // Ignore errors, return empty completions
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
    const message = error instanceof Error ? error.message : String(error);
    const lowerMessage = message.toLowerCase();

    // Authentication failures (401/403) - provide auth-type specific guidance
    if (
      lowerMessage.includes('401') ||
      lowerMessage.includes('403') ||
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('forbidden')
    ) {
      const authHint =
        config.authType === 'basic'
          ? 'Verify MAINWP_USER and MAINWP_APP_PASSWORD (or username/appPassword in settings.json) are correct and the user has REST API access.'
          : 'Verify MAINWP_TOKEN (or apiToken in settings.json) is correct and has not expired.';
      throw new Error(`Authentication failed: Invalid credentials. ${authHint}`, {
        cause: error,
      });
    }

    // Endpoint not found (404) - likely missing Abilities API plugin
    if (lowerMessage.includes('404') || lowerMessage.includes('not found')) {
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
    startupLogger.info(`Session data limit: ${(config.maxSessionData / 1048576).toFixed(1)}MB`);
    if (config.skipSslVerify) {
      startupLogger.error('╔══════════════════════════════════════════════════════════════╗');
      startupLogger.error('║  WARNING: SSL verification disabled                          ║');
      startupLogger.error('║  Connection is vulnerable to man-in-the-middle attacks       ║');
      startupLogger.error('║  Only use for local development with self-signed certs       ║');
      startupLogger.error('╚══════════════════════════════════════════════════════════════╝');
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
    startupLogger.error(`Fatal error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

// Run the server
main();
