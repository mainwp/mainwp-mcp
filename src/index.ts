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
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, Config } from './config.js';
import { getTools, executeTool } from './tools.js';
import { fetchAbilities, fetchCategories, clearCache } from './abilities.js';

// Server metadata
const SERVER_NAME = 'mainwp-mcp';
const SERVER_VERSION = '1.0.0';

/**
 * Create and configure the MCP server
 */
async function createServer(config: Config): Promise<Server> {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const content = await executeTool(config, name, args as Record<string, unknown> ?? {});
      return { content };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, message: errorMessage }, null, 2),
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
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  connected: false,
                  dashboardUrl: config.dashboardUrl,
                  error: error instanceof Error ? error.message : String(error),
                }, null, 2),
              },
            ],
          };
        }
      }

      throw new Error(`Unknown resource: ${uri}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ error: true, message: errorMessage }, null, 2),
          },
        ],
      };
    }
  });

  return server;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Load configuration from environment
    const config = loadConfig();

    console.error(`MainWP MCP Server v${SERVER_VERSION}`);
    console.error(`Dashboard: ${config.dashboardUrl}`);
    console.error(`Auth: ${config.authType === 'basic' ? 'Basic Auth' : 'Bearer Token'}`);
    if (config.skipSslVerify) {
      console.error('WARNING: SSL verification disabled - connection vulnerable to MITM attacks');
    }

    // Pre-fetch abilities to validate connection
    try {
      const abilities = await fetchAbilities(config);
      console.error(`Connected! Found ${abilities.length} abilities:`);
      abilities.forEach(a => console.error(`  - ${a.name}: ${a.label}`));
    } catch (error) {
      console.error(`Warning: Could not pre-fetch abilities: ${error instanceof Error ? error.message : error}`);
      console.error('Server will start anyway and retry on first request.');
    }

    // Create server
    const server = await createServer(config);

    // Connect via stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('MCP server running on stdio');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.error('Shutting down...');
      clearCache();
      await server.close();
      process.exit(0);
    });

  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run the server
main();
