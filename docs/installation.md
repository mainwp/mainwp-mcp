# Installation Guide

This guide covers detailed installation instructions for different MCP hosts. For a quick overview, see the [README](../README.md#installation).

---

## ⚠️ Important: AI Safety Notice

**Backup your MainWP data before using AI assistants.**

Large Language Models (LLMs) and AI agents are non-deterministic systems that can make mistakes, misinterpret instructions, or perform unintended actions. When connected to your MainWP Dashboard, an AI assistant has the ability to modify or delete sites, plugins, themes, clients, and tags.

### Recommendations

1. **Create a full backup** of your MainWP Dashboard database before your first AI session
2. **Start with Safe Mode enabled** (`safeMode: true`) to explore read-only operations first
3. **Use dry_run previews** before executing destructive operations (see [Security Guide](security.md#using-dry-run-previews))
4. **Review all AI actions** before confirming deletions or bulk operations

### Known AI Client Limitations

Some AI clients may not properly follow the confirmation flow for destructive operations. The mainwp-mcp server provides safety mechanisms (preview requirements, confirmation steps), but ultimately **the AI client decides whether to follow these instructions**. Observed issues include:

- AI skipping the preview step and executing deletions directly
- AI misinterpreting user responses as confirmation
- AI assuming operations are "safe" based on its own reasoning

These are AI client limitations, not mainwp-mcp server issues. If you experience this behavior, report it to your AI client vendor and consider enabling `safeMode: true` for that client.

See the [Security Guide](security.md) for detailed information on Safe Mode, confirmation flows, and protecting your data.

---

## Prerequisites

- Node.js 18 or later
- A MainWP Dashboard with the Abilities API plugin installed
- A WordPress Application Password ([how to create one](#creating-a-wordpress-application-password))

## Claude Code

Add to your Claude Code settings file (`~/.claude.json`):

```json
{
  "mcpServers": {
    "mainwp": {
      "command": "node",
      "args": ["/path/to/mainwp-mcp/dist/index.js"],
      "env": {
        "MAINWP_URL": "https://your-dashboard.com",
        "MAINWP_USER": "admin",
        "MAINWP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

Replace `/path/to/mainwp-mcp` with the actual path where you cloned the repository.

### Using a Configuration File

If you prefer to keep credentials separate, create `~/.config/mainwp-mcp/settings.json`:

```json
{
  "dashboardUrl": "https://your-dashboard.com",
  "username": "admin",
  "appPassword": "xxxx xxxx xxxx xxxx xxxx xxxx"
}
```

Then simplify your Claude Code config:

```json
{
  "mcpServers": {
    "mainwp": {
      "command": "node",
      "args": ["/path/to/mainwp-mcp/dist/index.js"]
    }
  }
}
```

Secure the credentials file: `chmod 600 ~/.config/mainwp-mcp/settings.json`

## VS Code (Copilot Agent Mode)

VS Code 1.101+ supports MCP servers in Agent Mode. Add to `.vscode/mcp.json` in your workspace:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "mainwp_password",
      "description": "MainWP Application Password",
      "password": true
    }
  ],
  "servers": {
    "mainwp": {
      "command": "node",
      "args": ["/path/to/mainwp-mcp/dist/index.js"],
      "env": {
        "MAINWP_URL": "https://your-dashboard.com",
        "MAINWP_USER": "admin",
        "MAINWP_APP_PASSWORD": "${input:mainwp_password}"
      }
    }
  }
}
```

The `${input:mainwp_password}` syntax prompts you for the password when the server starts, keeping it out of your config files.

### User-Level Configuration

To make MainWP available across all workspaces, add to your VS Code user settings (`settings.json`):

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "mainwp_password",
        "description": "MainWP Application Password",
        "password": true
      }
    ],
    "servers": {
      "mainwp": {
        "command": "node",
        "args": ["/path/to/mainwp-mcp/dist/index.js"],
        "env": {
          "MAINWP_URL": "https://your-dashboard.com",
          "MAINWP_USER": "admin",
          "MAINWP_APP_PASSWORD": "${input:mainwp_password}"
        }
      }
    }
  }
}
```

## Claude Desktop

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mainwp": {
      "command": "node",
      "args": ["/path/to/mainwp-mcp/dist/index.js"],
      "env": {
        "MAINWP_URL": "https://your-dashboard.com",
        "MAINWP_USER": "admin",
        "MAINWP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

Restart Claude Desktop after saving the configuration.

## Cursor

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "mainwp": {
      "command": "node",
      "args": ["/path/to/mainwp-mcp/dist/index.js"],
      "env": {
        "MAINWP_URL": "https://your-dashboard.com",
        "MAINWP_USER": "admin",
        "MAINWP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

## Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "mainwp": {
      "command": "node",
      "args": ["/path/to/mainwp-mcp/dist/index.js"],
      "env": {
        "MAINWP_URL": "https://your-dashboard.com",
        "MAINWP_USER": "admin",
        "MAINWP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

Note: Windsurf may require hardcoded credentials rather than environment variable references.

## Build from Source

If you haven't already built the server:

```bash
git clone https://github.com/mainwp/mainwp-mcp.git
cd mainwp-mcp
npm ci
npm run build
```

The built server is at `dist/index.js`. Use this path in your MCP host configuration.

For development with hot reload:

```bash
npm run dev
```

## Creating a WordPress Application Password

Application Passwords provide secure API access without exposing your main WordPress password.

1. Log into your WordPress Dashboard as an administrator
2. Go to **Users > Profile** (or click your username in the top-right corner)
3. Scroll down to the **Application Passwords** section
4. Enter a name like "MainWP MCP Server"
5. Click **Add New Application Password**
6. Copy the generated password immediately (it's only shown once)

The password displays with spaces for readability. You can use it with or without the spaces.

### Best Practices

- Create a dedicated WordPress user for API access rather than using your admin account
- Use descriptive names so you can identify and revoke passwords later
- Revoke unused application passwords periodically

## Verifying Installation

After configuration, test the connection:

1. Start your MCP host (Claude Code, VS Code, etc.)
2. Ask: "List my MainWP sites"
3. You should see a list of your connected child sites

If you get errors, see the [Troubleshooting Guide](troubleshooting.md).

## Next Steps

- [Configuration Guide](configuration.md) for advanced settings
- [Security Guide](security.md) for credential management best practices
