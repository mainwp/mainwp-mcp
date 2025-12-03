# MainWP MCP Server

An MCP (Model Context Protocol) server that exposes MainWP Dashboard abilities as tools for AI assistants like Claude.

## What This Does

This server allows AI assistants to interact with your MainWP Dashboard by:

1. **Discovering available abilities** - The server fetches ability definitions from your MainWP Dashboard
2. **Exposing them as MCP tools** - Each ability becomes a tool the AI can call
3. **Executing operations** - When the AI calls a tool, the server forwards it to the MainWP Abilities API

## Prerequisites

- Node.js 18 or later
- A MainWP Dashboard with the WordPress Abilities API plugin installed
- A REST API bearer token for authentication

## Installation

```bash
cd mainwp-mcp
npm install
npm run build
```

## Configuration

The server requires these environment variables:

| Variable | Description |
|----------|-------------|
| `MAINWP_URL` | Base URL of your MainWP Dashboard (e.g., `https://dashboard.example.com`) |
| `MAINWP_USER` | WordPress admin username |
| `MAINWP_APP_PASSWORD` | WordPress Application Password (see below) |
| `MAINWP_SKIP_SSL_VERIFY` | Set to `true` to skip SSL verification (for local dev with self-signed certs) |

### Creating a WordPress Application Password

The Abilities API uses WordPress's standard REST API authentication. You need to create an Application Password:

1. Log into your WordPress Dashboard as an admin
2. Go to **Users → Profile** (or click your username in the top-right)
3. Scroll down to **Application Passwords**
4. Enter a name like "MainWP MCP Server"
5. Click **Add New Application Password**
6. Copy the generated password (it will only be shown once!)
7. Use this as `MAINWP_APP_PASSWORD`

**Note:** The password is shown with spaces for readability, but you can use it with or without spaces.

## Usage

### Direct Execution

```bash
MAINWP_URL=https://dashboard.example.com \
MAINWP_USER=admin \
MAINWP_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx" \
MAINWP_SKIP_SSL_VERIFY=true \
node dist/index.js
```

### With Claude Code

Add to your Claude Code MCP configuration (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mainwp": {
      "command": "node",
      "args": ["/path/to/mainwp-mcp/dist/index.js"],
      "env": {
        "MAINWP_URL": "https://dashboard.example.com",
        "MAINWP_USER": "admin",
        "MAINWP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx",
        "MAINWP_SKIP_SSL_VERIFY": "true"
      }
    }
  }
}
```

### Testing with MCP Inspector

```bash
npm run inspect
```

## Available Tools

Once connected, the following tools become available (depending on your MainWP abilities):

### Sites Category

| Tool | Description |
|------|-------------|
| `mainwp_list_sites_v1` | List MainWP child sites with pagination and filtering |
| `mainwp_get_site_v1` | Get detailed information about a single site |
| `mainwp_sync_sites_v1` | Trigger synchronization for one or more sites |
| `mainwp_get_site_plugins_v1` | Get plugins installed on a child site |
| `mainwp_get_site_themes_v1` | Get themes installed on a child site |

### Updates Category

| Tool | Description |
|------|-------------|
| `mainwp_list_updates_v1` | List available updates across sites |
| `mainwp_run_updates_v1` | Execute updates on child sites |
| `mainwp_list_ignored_updates_v1` | List ignored updates |
| `mainwp_set_ignored_updates_v1` | Manage ignored updates |

## Resources

The server also exposes these resources for inspection:

| URI | Description |
|-----|-------------|
| `mainwp://abilities` | Full list of available abilities with schemas |
| `mainwp://categories` | List of ability categories |
| `mainwp://status` | Current connection status |

## Example Interactions

Once configured, you can interact naturally:

```
You: What MainWP sites do I have?
Claude: [Calls mainwp_list_sites_v1]
        You have 5 connected sites...

You: Which ones need updates?
Claude: [Calls mainwp_list_updates_v1]
        3 sites have pending plugin updates...

You: Sync all my sites
Claude: [Calls mainwp_sync_sites_v1]
        Sync initiated for 5 sites...
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## Troubleshooting

### "MAINWP_URL environment variable is required"

Make sure to set the environment variables before running the server.

### "Failed to fetch abilities: 401 Unauthorized"

Your credentials are invalid. Make sure you're using a valid WordPress Application Password (not the regular WordPress password). Go to Users → Profile → Application Passwords to generate one.

### SSL Certificate Errors

For local development with self-signed certificates, set `MAINWP_SKIP_SSL_VERIFY=true`.

> **Security Warning:** Setting `MAINWP_SKIP_SSL_VERIFY=true` disables SSL certificate verification, making your connection vulnerable to man-in-the-middle (MITM) attacks. Attackers on your network could intercept credentials and API responses.
>
> **Only use this setting for:**
> - Local development with self-signed certificates
> - Isolated test environments
>
> **Never use in production** or on untrusted networks.

### "Ability not found"

The ability may not be registered or may have `show_in_rest` set to false. Check your MainWP Dashboard has the Abilities API plugin installed and abilities are enabled.

## License

GPL-3.0
