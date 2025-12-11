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
npm ci          # Use 'npm ci' for production (reproducible builds from package-lock.json)
npm run build
```

**Development**: Use `npm install` to update dependencies; use `npm ci` for production deployments to ensure exact versions from `package-lock.json`.

## Configuration

The server requires these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAINWP_URL` | (required) | Base URL of your MainWP Dashboard (e.g., `https://dashboard.example.com`) |
| `MAINWP_USER` | (required) | WordPress admin username |
| `MAINWP_APP_PASSWORD` | (required) | WordPress Application Password (see below) |
| `MAINWP_SKIP_SSL_VERIFY` | `false` | Set to `true` to skip SSL verification (for local dev with self-signed certs) |
| `MAINWP_ALLOW_HTTP` | `false` | Set to `true` to allow HTTP URLs (insecure, not recommended) |
| `MAINWP_RATE_LIMIT` | `60` | Max API requests per minute (0 = disabled) |
| `MAINWP_ALLOWED_TOOLS` | (none) | Comma-separated whitelist of tool names to expose (e.g., `list_sites_v1,get_site_v1`). If set, only these tools are available. |
| `MAINWP_BLOCKED_TOOLS` | (none) | Comma-separated blacklist of tool names to hide. Cannot overlap with `MAINWP_ALLOWED_TOOLS`. |
| `MAINWP_REQUEST_TIMEOUT` | `30000` | API request timeout in milliseconds (30 seconds default). |
| `MAINWP_MAX_RESPONSE_SIZE` | `10485760` | Maximum response size in bytes (10MB default). Rejects larger responses. |
| `MAINWP_SAFE_MODE` | `false` | Set to `true` to block destructive operations (strips `confirm` parameter from tool calls). |
| `MAINWP_MAX_SESSION_DATA` | `52428800` | Maximum cumulative response data per server session in bytes (50MB default). Tool calls that would exceed this limit fail with RESOURCE_EXHAUSTED error. |

### Configuration File

As an alternative to environment variables, you can use a `settings.json` file for configuration. This is particularly useful for local development.

**Precedence:** Environment variables take precedence over file settings, which take precedence over defaults.

**Search paths** (checked in order):
1. `./settings.json` (current working directory)
2. `~/.config/mainwp-mcp/settings.json` (user config directory)

**Example `settings.json`:**

```json
{
  "dashboardUrl": "https://dashboard.example.com",
  "username": "admin",
  "appPassword": "xxxx xxxx xxxx xxxx xxxx xxxx",
  "skipSslVerify": false,
  "rateLimit": 60,
  "allowedTools": ["list_sites_v1", "get_site_v1"]
}
```

**Field mapping:**

| settings.json field | Environment variable | Type |
|---------------------|---------------------|------|
| `dashboardUrl` | `MAINWP_URL` | string |
| `username` | `MAINWP_USER` | string |
| `appPassword` | `MAINWP_APP_PASSWORD` | string |
| `apiToken` | `MAINWP_TOKEN` | string |
| `skipSslVerify` | `MAINWP_SKIP_SSL_VERIFY` | boolean |
| `allowHttp` | `MAINWP_ALLOW_HTTP` | boolean |
| `safeMode` | `MAINWP_SAFE_MODE` | boolean |
| `rateLimit` | `MAINWP_RATE_LIMIT` | number |
| `requestTimeout` | `MAINWP_REQUEST_TIMEOUT` | number |
| `maxResponseSize` | `MAINWP_MAX_RESPONSE_SIZE` | number |
| `maxSessionData` | `MAINWP_MAX_SESSION_DATA` | number |
| `abilityNamespace` | `MAINWP_ABILITY_NAMESPACE` | string |
| `allowedTools` | `MAINWP_ALLOWED_TOOLS` | string[] |
| `blockedTools` | `MAINWP_BLOCKED_TOOLS` | string[] |

**Notes:**
- All fields are optional
- Copy `settings.example.json` to `settings.json` and customize
- IDE autocompletion is available via `settings.schema.json`
- See "Security Best Practices" below for file permission recommendations

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

### With Configuration File

```bash
# Create settings.json in the project directory
cat > settings.json << 'EOF'
{
  "dashboardUrl": "https://dashboard.example.com",
  "username": "admin",
  "appPassword": "xxxx xxxx xxxx xxxx xxxx xxxx",
  "skipSslVerify": true
}
EOF

# Secure the file
chmod 600 settings.json

# Run the server (reads settings.json automatically)
node dist/index.js
```

**Mixing approaches:** You can use `settings.json` for base configuration and override specific values with environment variables:

```bash
# settings.json contains dashboardUrl, username, appPassword
# Override just the rate limit via environment variable
MAINWP_RATE_LIMIT=120 node dist/index.js
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

**Alternative:** If using `settings.json` in `~/.config/mainwp-mcp/`, you can simplify the MCP configuration:

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

The server will automatically load credentials from `~/.config/mainwp-mcp/settings.json`. You can still override specific settings via the `env` field if needed.

### Testing with MCP Inspector

```bash
npm run inspect
```

## Available Tools

Once connected, the following tools become available (depending on your MainWP abilities):

> **Note:** Tool names omit the `mainwp` namespace prefix since the MCP server name already provides context. The ability `mainwp/list-sites-v1` becomes the tool `list_sites_v1`.

### Sites Category

| Tool | Description |
|------|-------------|
| `list_sites_v1` | List MainWP child sites with pagination and filtering |
| `get_site_v1` | Get detailed information about a single site |
| `sync_sites_v1` | Trigger synchronization for one or more sites |
| `get_site_plugins_v1` | Get plugins installed on a child site |
| `get_site_themes_v1` | Get themes installed on a child site |

### Updates Category

| Tool | Description |
|------|-------------|
| `list_updates_v1` | List available updates across sites |
| `run_updates_v1` | Execute updates on child sites |
| `list_ignored_updates_v1` | List ignored updates |
| `set_ignored_updates_v1` | Manage ignored updates |

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
Claude: [Calls list_sites_v1]
        You have 5 connected sites...

You: Which ones need updates?
Claude: [Calls list_updates_v1]
        3 sites have pending plugin updates...

You: Sync all my sites
Claude: [Calls sync_sites_v1]
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

## Security Considerations

**This server is designed for local installation only.** It should run on your local machine alongside your AI assistant (e.g., Claude Code).

### Why Local Only?

- **Credential Storage:** Your WordPress credentials are stored in local environment variables or MCP configuration files on your machine
- **Stdio Transport:** The server communicates via stdin/stdout with the local AI client—there is no HTTP server exposed
- **Direct API Access:** The server makes authenticated requests directly to your MainWP Dashboard

### Do Not:

- Deploy this server on a shared or public server
- Expose this server over a network
- Store credentials in version control or shared configuration

### Credential Security

- Use WordPress Application Passwords (not your main password)
- Application Passwords can be revoked individually without changing your main password
- Consider creating a dedicated WordPress user with limited permissions for API access

## Security Best Practices

### Credential File Permissions

If storing credentials in a `.env` file or `settings.json`:

```bash
# Restrict file to owner read/write only
chmod 600 .env
chmod 600 settings.json

# Verify permissions
ls -l .env settings.json
# Should show: -rw------- (600)
```

**Never commit credential files to version control.** Both `.env` and `settings.json` are already in `.gitignore`.

**Configuration file security:**
- `settings.json` is loaded from the current directory or `~/.config/mainwp-mcp/`
- Ensure the file is readable only by your user account
- For shared systems, prefer `~/.config/mainwp-mcp/settings.json` with `chmod 600`
- Environment variables still take precedence, allowing runtime overrides without modifying the file

### Using Secrets Managers

For production or team environments, use a secrets manager instead of plain `.env` files:

**1Password CLI**:
```bash
# Store credentials in 1Password, then inject at runtime
op run --env-file=".env.template" -- node dist/index.js
```

**HashiCorp Vault**:
```bash
# Fetch secrets from Vault and export as env vars
export MAINWP_URL=$(vault kv get -field=url secret/mainwp)
export MAINWP_USER=$(vault kv get -field=user secret/mainwp)
export MAINWP_APP_PASSWORD=$(vault kv get -field=password secret/mainwp)
node dist/index.js
```

### Dedicated WordPress Users

**Create a dedicated WordPress user for API access** instead of using your admin account:

1. Go to **Users → Add New** in WordPress
2. Create user with username like `mainwp-mcp-bot`
3. Assign **Administrator** role (required for MainWP Dashboard access)
4. Generate an Application Password for this user (Users → Profile → Application Passwords)
5. Use this dedicated user's credentials in `MAINWP_USER` and `MAINWP_APP_PASSWORD`

**Benefits**:
- Audit trail: API actions appear under the bot user in logs
- Revocation: Disable the bot user without affecting your admin access
- Principle of least privilege: Future versions may support lower-privilege roles

### Trust Model and MAINWP_URL Security

**Critical**: `MAINWP_URL` is a **fully trusted endpoint**. The server:
- Sends your WordPress credentials to this URL
- Executes operations returned by this URL's API
- Trusts all ability definitions from this URL

**Ensure**:
- `MAINWP_URL` points to **your own MainWP Dashboard** (not a third-party service)
- The URL uses HTTPS with a valid certificate (or `MAINWP_SKIP_SSL_VERIFY=true` for local dev only)
- The Dashboard server is secured (firewall, updated software, strong passwords)

**Never** point `MAINWP_URL` to an untrusted server—it would receive your credentials and could return malicious ability definitions.

### Tool Access Control

Limit exposed tools using allow/block lists:

```bash
# Whitelist: Only expose read-only tools
export MAINWP_ALLOWED_TOOLS="list_sites_v1,get_site_v1,list_updates_v1"

# Blacklist: Hide destructive operations
export MAINWP_BLOCKED_TOOLS="run_updates_v1,delete_site_v1"
```

**Use safe mode** to prevent accidental destructive operations during testing:

```bash
export MAINWP_SAFE_MODE=true
```

When enabled, the server strips `confirm: true` from tool arguments, causing destructive operations to fail safely.

### Resource Limits

Configure limits to prevent resource exhaustion:

```bash
# Timeout slow requests after 15 seconds
export MAINWP_REQUEST_TIMEOUT=15000

# Reject responses larger than 5MB
export MAINWP_MAX_RESPONSE_SIZE=5242880

# Limit total session data to 20MB
export MAINWP_MAX_SESSION_DATA=20971520
```

**Session data limit**: The server tracks cumulative response data across all tool calls. When a tool call would exceed `MAINWP_MAX_SESSION_DATA`, the call fails with a `RESOURCE_EXHAUSTED` error and the session counter remains unchanged. The server continues running, allowing smaller subsequent calls to succeed. Restart the server to reset the session data counter.

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
