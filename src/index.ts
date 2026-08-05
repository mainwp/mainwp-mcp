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
import { resolveConfig, Config, MissingConfigError } from './config.js';
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
import { sanitizeError, registerKnownSecrets, isValidId } from './security.js';
import { abilityNameToToolName } from './naming.js';
import { formatErrorResponse, getErrorMessage, McpErrorFactory, McpError } from './errors.js';
import {
  ConfigState,
  executeSetupTool,
  getSetupTools,
  isSetupToolName,
  notReadyResult,
  type SetupNotifier,
} from './setup.js';

// Server metadata
const SERVER_NAME = 'mainwp-mcp';
const SERVER_VERSION = '1.2.0';

// Completion limits
const MAX_COMPLETION_SUGGESTIONS = 20;

const SETUP_GUIDE_URL = 'https://github.com/mainwp/mainwp-mcp#readme';

export function getHelpText(): string {
  return `MainWP MCP Server v${SERVER_VERSION}

Connects AI assistants to a MainWP Dashboard over the Model Context
Protocol. Normally launched by an MCP client (Claude Code, Claude Desktop,
Cursor), not run by hand.

Usage:
  npx -y @mainwp/mcp              Start the server (stdio transport)
  npx -y @mainwp/mcp --help       Show this help
  npx -y @mainwp/mcp --version    Print the version

Required environment variables:
  MAINWP_URL            Your MainWP Dashboard URL (https://your-dashboard.com)
  MAINWP_USER           WordPress admin username
  MAINWP_APP_PASSWORD   WordPress Application Password for that user
                        (create one under Users > Profile on the Dashboard site)

Add to Claude Code:
  claude mcp add --transport stdio mainwp \\
    --env MAINWP_URL=https://your-dashboard.com \\
    --env MAINWP_USER=admin \\
    --env MAINWP_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx" \\
    -- npx -y @mainwp/mcp

Claude Code plugin (this server plus a usage skill and workflow commands):
  /plugin marketplace add mainwp/mainwp-mcp
  /plugin install mainwp@mainwp-mcp

Other MCP clients and optional settings (safe mode, tool filtering, timeouts):
  ${SETUP_GUIDE_URL}`;
}

export function getMissingConfigGuidance(missing: MissingConfigError['missing']): string {
  const missingLine =
    missing === 'MAINWP_URL'
      ? 'Missing: MAINWP_URL (the address of your MainWP Dashboard)'
      : 'Missing: login credentials (MAINWP_USER and MAINWP_APP_PASSWORD)';
  return `MainWP MCP server is not configured yet.

${missingLine}

Set these environment variables, either in your shell or in the "env"
block of this server's entry in your MCP client config:

  MAINWP_URL            https://your-dashboard.com
  MAINWP_USER           WordPress admin username
  MAINWP_APP_PASSWORD   WordPress Application Password for that user

Setup guide: ${SETUP_GUIDE_URL}
Run "npx -y @mainwp/mcp --help" for more options.`;
}

/**
 * Create and configure the MCP server
 */
export async function createServer(
  input: Config | ConfigState
): Promise<{ server: Server; logger: Logger }> {
  // Readiness is mutable: handlers dereference this holder at call time so a
  // mid-session configure changes what every already-registered handler sees.
  const state = input instanceof ConfigState ? input : ConfigState.fromConfig(input);
  const startupConfig = state.retainedConfig;
  // Every sanitizeError call site benefits, whatever path an error takes to a
  // client-visible string: the server's own credentials are scrubbed by value,
  // in the encodings a serialized error body preserves.
  registerKnownSecrets([
    startupConfig?.appPassword,
    startupConfig?.apiToken,
    startupConfig?.username && startupConfig.appPassword
      ? Buffer.from(`${startupConfig.username}:${startupConfig.appPassword}`).toString('base64')
      : undefined,
  ]);
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

  // Fired after a readiness change so clients re-read the surfaces setup mode
  // suppressed. Order matters only in that tools carry the visible change.
  const notifyListChanged: SetupNotifier = async () => {
    await server.sendToolListChanged().catch(() => {});
    await server.sendResourceListChanged().catch(() => {});
    await server.sendPromptListChanged().catch(() => {});
  };

  // Handler: List available tools (derived from abilities)
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const config = state.readyConfig;
    if (!config) {
      return { tools: getSetupTools(state) };
    }
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
      // Readiness is an authorization boundary checked here, not a listing
      // filter: a client that remembers a tool name from a previous session
      // must not reach the Dashboard path while the server is not ready.
      if (isSetupToolName(name)) {
        return await executeSetupTool(
          state,
          name,
          (args as Record<string, unknown>) ?? {},
          logger,
          notifyListChanged
        );
      }
      const config = state.readyConfig;
      if (!config) {
        return notReadyResult(state);
      }
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
    if (!state.isReady) {
      return { resources: [] };
    }
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
    const config = state.readyConfig;
    if (!config) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'application/json',
            text: notReadyResult(state).content[0].text,
          },
        ],
      };
    }
    return handleReadResource(config, request.params.uri, logger);
  });

  // Handler: List available prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    if (!state.isReady) {
      return { prompts: [] };
    }
    return { prompts: getPromptList() };
  });

  // Handler: Get a specific prompt
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    if (!state.isReady) {
      throw McpErrorFactory.permissionDenied(
        'The MainWP MCP server is not connected to a Dashboard yet, so its prompts are unavailable.'
      );
    }
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
    const config = state.readyConfig;

    // Handle prompt argument completions
    if (config && ref.type === 'ref/prompt') {
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
    if (!state.isReady) {
      return { resourceTemplates: [] };
    }
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
  // --help/--version are explicit CLI invocations, not MCP sessions, so
  // stdout is the right stream and the process exits before any transport
  // is created.
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${getHelpText()}\n`);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  // Use stderr logger before server is initialized
  const startupLogger = createStderrLogger();

  try {
    // Load configuration from environment. Missing connection settings are a
    // first-run state, not a fatal error: the server starts in setup mode so
    // the user gets guidance inside their client instead of a failed launch.
    const resolution = resolveConfig();
    const state = ConfigState.fromResolution(resolution);
    const config = state.retainedConfig;

    // Register before any remote call: the startup credential check runs ahead
    // of createServer(), and its error path must already redact by value.
    registerKnownSecrets([
      config?.appPassword,
      config?.apiToken,
      config?.username && config.appPassword
        ? Buffer.from(`${config.username}:${config.appPassword}`).toString('base64')
        : undefined,
    ]);

    // Initialize rate limiter
    initRateLimiter(state.policy.rateLimit);

    startupLogger.info(`MainWP MCP Server v${SERVER_VERSION}`);
    if (resolution.status === 'unconfigured') {
      console.error(getMissingConfigGuidance(resolution.missing));
      startupLogger.info('Starting in setup mode; no Dashboard connection configured yet.');
    } else if (config) {
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

      // A failed check no longer kills the process: the session starts
      // degraded, keeps the credentials, and the setup-status tool retries.
      startupLogger.info('Validating credentials...');
      try {
        const abilities = await validateCredentials(config, startupLogger);
        startupLogger.info(`Connected! Found ${abilities.length} abilities`);
        abilities.forEach(a => startupLogger.debug(`  - ${a.name}: ${a.label}`));
      } catch (error) {
        const reason = sanitizeError(getErrorMessage(error));
        state.markDegraded(reason);
        startupLogger.warning(
          `Could not reach the MainWP Dashboard at startup: ${reason} Starting anyway; MainWP tools stay hidden until the connection works.`
        );
      }
    }

    // Create server (returns server + structured logger)
    const { server, logger } = await createServer(state);

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
