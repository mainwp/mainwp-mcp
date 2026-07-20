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
import { realpathSync } from 'node:fs';
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
import { loadConfig, Config } from './config.js';
import { getTools, executeTool } from './tools.js';
import { decidePolicy, classifyDestructive } from './policy.js';
import { formatBytes } from './session.js';
import {
  fetchAbilities,
  clearCache,
  onCacheRefresh,
  executeAbility,
  initRateLimiter,
} from './abilities.js';
import { validateCredentials } from './credential-check.js';
import { handleReadResource } from './resources.js';
import { getPromptList, getPrompt, getPromptArgumentCompletions } from './prompts.js';
import { createLogger, createStderrLogger, type Logger } from './logging.js';
import { sanitizeError, isValidId } from './security.js';
import { abilityNameToToolName } from './naming.js';
import { formatErrorResponse, getErrorMessage, McpErrorFactory, McpError } from './errors.js';

// Server metadata
const SERVER_NAME = 'mainwp-mcp';
const SERVER_VERSION = '1.0.0-beta.3';

// Completion limits
const MAX_COMPLETION_SUGGESTIONS = 20;

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

  // Handler: Read a resource (URI validation + branch bodies live in resources.ts)
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    return handleReadResource(config, request.params.uri, logger);
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
        const listSitesToolName = abilityNameToToolName(
          'mainwp/list-sites-v1',
          config.abilityNamespaces[0]
        );
        if (decidePolicy(config, listSitesToolName) !== 'allow') {
          throw McpErrorFactory.permissionDenied(`Tool is not allowed: ${listSitesToolName}`);
        }
        try {
          const abilities = await fetchAbilities(config, false, logger);
          const listSitesAbility = abilities.find(a => a.name === 'mainwp/list-sites-v1');
          // Execution-stage gate with fail-closed destructive classification.
          // Completions are best-effort, so a non-allow decision skips the
          // lookup (empty suggestions) instead of erroring the completion.
          if (
            listSitesAbility &&
            decidePolicy(
              config,
              listSitesToolName,
              classifyDestructive(listSitesAbility.meta?.annotations)
            ) === 'allow'
          ) {
            const result = await executeAbility(
              config,
              'mainwp/list-sites-v1',
              {},
              logger,
              listSitesAbility
            );
            if (Array.isArray(result)) {
              // Filter to only valid site IDs
              values = result
                .filter((site: { id: unknown }) => isValidId(site.id))
                .map((site: { id: number }) => String(site.id));
            }
          } else if (listSitesAbility) {
            logger.info('Site-id completion skipped: policy blocks destructive execution', {
              toolName: listSitesToolName,
            });
          }
        } catch (error) {
          // Fail soft — completions are best-effort — but leave a trace so
          // config/auth problems here aren't invisible in production
          logger.info('Site-id completion lookup failed', {
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
      startupLogger.error('WARNING: SSL verification disabled.');
      startupLogger.error('The connection is vulnerable to man-in-the-middle attacks.');
      startupLogger.error('Only use this for local development with self-signed certificates.');
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
// Node resolves the ESM main module to its real path while argv[1] keeps the
// path as invoked, so npm's bin symlinks need argv[1] realpathed to match.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
