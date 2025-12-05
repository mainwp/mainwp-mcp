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
import { loadConfig, Config } from './config.js';
import { getTools, executeTool } from './tools.js';
import { fetchAbilities, fetchCategories, clearCache, onCacheRefresh, executeAbility, initRateLimiter } from './abilities.js';
import { getPromptList, getPrompt, getPromptArgumentCompletions } from './prompts.js';
import { createLogger, createStderrLogger, type Logger } from './logging.js';
import { sanitizeError, isValidId } from './security.js';
import { formatErrorResponse, McpErrorFactory } from './errors.js';

// Server metadata
const SERVER_NAME = 'mainwp-mcp';
const SERVER_VERSION = '1.0.0';

/**
 * Validate and parse a resource URI.
 * Only allows known URI patterns to prevent injection attacks.
 */
function validateResourceUri(uri: string): { type: string; params?: Record<string, number> } {
  const staticUris = ['mainwp://abilities', 'mainwp://categories', 'mainwp://status'];
  if (staticUris.includes(uri)) {
    return { type: uri.replace('mainwp://', '') };
  }

  // Match mainwp://site/{id} pattern with strict numeric ID
  const siteMatch = uri.match(/^mainwp:\/\/site\/(\d+)$/);
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
      const tools = await getTools(config);
      return { tools };
    } catch (error) {
      console.error('Error listing tools:', error);
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
        args as Record<string, unknown> ?? {},
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

  // Handler: List available resources (abilities info, categories)
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
      ],
    };
  });

  // Handler: Read a resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    try {
      if (uri === 'mainwp://abilities') {
        const abilities = await fetchAbilities(config);
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(abilities, null, 2),
            },
          ],
        };
      }

      if (uri === 'mainwp://categories') {
        const categories = await fetchCategories(config);
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(categories, null, 2),
            },
          ],
        };
      }

      if (uri === 'mainwp://status') {
        // Test connection by fetching abilities
        try {
          const abilities = await fetchAbilities(config, true); // Force refresh
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  connected: true,
                  dashboardUrl: config.dashboardUrl,
                  abilitiesCount: abilities.length,
                  abilities: abilities.map(a => a.name),
                }, null, 2),
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
                text: JSON.stringify({
                  connected: false,
                  dashboardUrl: config.dashboardUrl,
                  error: sanitizeError(errorMsg),
                }, null, 2),
              },
            ],
          };
        }
      }

      // Validate and parse the resource URI (throws on invalid URIs)
      const parsed = validateResourceUri(uri);

      // Handle site resource template: mainwp://site/{id}
      if (parsed.type === 'site' && parsed.params?.site_id) {
        const result = await executeAbility(config, 'mainwp/get-site-v1', { site_id: parsed.params.site_id });
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          }],
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
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return getPrompt(name, args);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(sanitizeError(errorMessage));
    }
  });

  // Handler: Argument completions
  server.setRequestHandler(CompleteRequestSchema, async (request) => {
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
          const abilities = await fetchAbilities(config);
          const listSitesAbility = abilities.find(a => a.name === 'mainwp/list-sites-v1');
          if (listSitesAbility) {
            const result = await executeAbility(config, 'mainwp/list-sites-v1', {});
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
          values: filteredValues.slice(0, 20), // Limit to 20 suggestions
          hasMore: filteredValues.length > 20,
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
    startupLogger.info(`Namespace: ${config.abilityNamespace ? config.abilityNamespace + '/*' : '(all abilities)'}`);
    if (config.skipSslVerify) {
      startupLogger.error('╔══════════════════════════════════════════════════════════════╗');
      startupLogger.error('║  WARNING: SSL verification disabled                          ║');
      startupLogger.error('║  Connection is vulnerable to man-in-the-middle attacks       ║');
      startupLogger.error('║  Only use for local development with self-signed certs       ║');
      startupLogger.error('╚══════════════════════════════════════════════════════════════╝');
    }

    // Pre-fetch abilities to validate connection
    try {
      const abilities = await fetchAbilities(config);
      startupLogger.info(`Connected! Found ${abilities.length} abilities`);
      abilities.forEach(a => startupLogger.debug(`  - ${a.name}: ${a.label}`));
    } catch (error) {
      startupLogger.warning(`Could not pre-fetch abilities: ${error instanceof Error ? error.message : error}`);
      startupLogger.info('Server will start anyway and retry on first request.');
    }

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
