# Configuration Guide

This guide covers all configuration options for the MainWP MCP Server. For basic setup, see the [Installation Guide](installation.md).

## Configuration Methods

The server accepts configuration through two methods:

1. **Environment variables** (highest priority)
2. **Configuration file** (`settings.json`)

Environment variables always override file settings. This lets you use a base configuration file and override specific values at runtime.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MAINWP_URL` | Yes | | Base URL of your MainWP Dashboard |
| `MAINWP_USER` | Yes | | WordPress admin username |
| `MAINWP_APP_PASSWORD` | Yes | | WordPress Application Password |
| `MAINWP_SKIP_SSL_VERIFY` | No | `false` | Skip SSL certificate verification |
| `MAINWP_SAFE_MODE` | No | `false` | Block all destructive operations |
| `MAINWP_REQUIRE_USER_CONFIRMATION` | No | `true` | Require two-step confirmation for destructive operations |
| `MAINWP_ALLOWED_TOOLS` | No | | Comma-separated whitelist of tools |
| `MAINWP_BLOCKED_TOOLS` | No | | Comma-separated blacklist of tools |
| `MAINWP_SCHEMA_VERBOSITY` | No | `standard` | Schema detail level: `standard` or `compact` |
| `MAINWP_RATE_LIMIT` | No | `60` | Maximum API requests per minute |
| `MAINWP_REQUEST_TIMEOUT` | No | `30000` | Request timeout in milliseconds |
| `MAINWP_MAX_RESPONSE_SIZE` | No | `10485760` | Maximum response size in bytes (10MB) |
| `MAINWP_MAX_SESSION_DATA` | No | `52428800` | Maximum cumulative session data (50MB) |
| `MAINWP_ABILITY_NAMESPACE` | No | `mainwp` | Filter abilities by namespace |

## Configuration File

Create a `settings.json` file in one of these locations (checked in order):

1. `./settings.json` (current working directory)
2. `~/.config/mainwp-mcp/settings.json`

Example `settings.json`:

```json
{
  "dashboardUrl": "https://your-dashboard.com",
  "username": "admin",
  "appPassword": "xxxx xxxx xxxx xxxx xxxx xxxx",
  "skipSslVerify": false,
  "safeMode": false,
  "schemaVerbosity": "standard",
  "rateLimit": 60
}
```

### Field Mapping

| settings.json | Environment Variable | Type |
|---------------|---------------------|------|
| `dashboardUrl` | `MAINWP_URL` | string |
| `username` | `MAINWP_USER` | string |
| `appPassword` | `MAINWP_APP_PASSWORD` | string |
| `apiToken` | `MAINWP_TOKEN` | string |
| `skipSslVerify` | `MAINWP_SKIP_SSL_VERIFY` | boolean |
| `safeMode` | `MAINWP_SAFE_MODE` | boolean |
| `requireUserConfirmation` | `MAINWP_REQUIRE_USER_CONFIRMATION` | boolean |
| `allowedTools` | `MAINWP_ALLOWED_TOOLS` | string[] |
| `blockedTools` | `MAINWP_BLOCKED_TOOLS` | string[] |
| `schemaVerbosity` | `MAINWP_SCHEMA_VERBOSITY` | string |
| `rateLimit` | `MAINWP_RATE_LIMIT` | number |
| `requestTimeout` | `MAINWP_REQUEST_TIMEOUT` | number |
| `maxResponseSize` | `MAINWP_MAX_RESPONSE_SIZE` | number |
| `maxSessionData` | `MAINWP_MAX_SESSION_DATA` | number |
| `abilityNamespace` | `MAINWP_ABILITY_NAMESPACE` | string |

A JSON schema is available at `settings.schema.json` for IDE autocompletion.

---

## Tool Filtering

Control which tools are exposed to AI assistants. This is useful for:

- Limiting access to read-only operations
- Hiding destructive tools in production
- Reducing context size for the AI

### Whitelist Mode

Only expose specific tools. All others are hidden.

In `settings.json`:
```json
{
  "allowedTools": ["list_sites_v1", "get_site_v1", "list_updates_v1"]
}
```

As an environment variable:
```bash
MAINWP_ALLOWED_TOOLS="list_sites_v1,get_site_v1,list_updates_v1"
```

### Blacklist Mode

Hide specific tools. All others remain available.

In `settings.json`:
```json
{
  "blockedTools": ["delete_site_v1", "delete_client_v1", "delete_tag_v1"]
}
```

As an environment variable:
```bash
MAINWP_BLOCKED_TOOLS="delete_site_v1,delete_client_v1,delete_tag_v1"
```

### Combined Filtering

When both are set, the allowlist is applied first, then the blocklist filters the result. This lets you allow a category of tools while blocking specific ones.

Tool names use underscore format (e.g., `list_sites_v1`, not `mainwp/list-sites-v1`).

---

## Schema Verbosity

Control the detail level of tool descriptions sent to the AI. This affects token usage in your AI context window.

| Mode | Description | Token Impact |
|------|-------------|--------------|
| `standard` | Full descriptions, safety tags, usage hints | Default, ~41,500 tokens |
| `compact` | Truncated descriptions (60 chars), no examples | ~30% reduction |

In `settings.json`:
```json
{
  "schemaVerbosity": "compact"
}
```

As an environment variable:
```bash
MAINWP_SCHEMA_VERBOSITY=compact
```

### When to Use Compact Mode

- When you're hitting context limits
- When the AI already knows the tools well
- In automated pipelines where full descriptions aren't needed

### Tradeoffs

Compact mode removes inline safety warnings and detailed parameter descriptions. The AI relies on MCP semantic annotations (readOnlyHint, destructiveHint) instead. Verify your MCP client displays these annotations before using compact mode for destructive operations.

---

## Safe Mode

Block all destructive operations. The server strips `confirm: true` from tool arguments, causing destructive tools to fail safely.

In `settings.json`:
```json
{
  "safeMode": true
}
```

As an environment variable:
```bash
MAINWP_SAFE_MODE=true
```

Use safe mode for:

- Testing and development
- Read-only access scenarios
- Training users on the system

See the [Security Guide](security.md) for more on protecting destructive operations.

---

## User Confirmation

Control whether destructive operations require two-step confirmation (preview then user approval).

In `settings.json`:
```json
{
  "requireUserConfirmation": true
}
```

As an environment variable:
```bash
MAINWP_REQUIRE_USER_CONFIRMATION=true
```

When enabled (default), destructive tools like `delete_site_v1` require the AI to:
1. First call with `confirm: true` to get a preview
2. Show the preview to you
3. Call again with `user_confirmed: true` after you approve

This prevents accidental deletions while still allowing destructive operations when needed.

### When to Disable

Set to `false` for:
- Automated scripts that need to delete without interaction
- CI/CD pipelines
- Batch operations where you've already verified the targets

**Example for automation:**
```json
{
  "requireUserConfirmation": false,
  "allowedTools": [
    "delete_site_v1",
    "list_sites_v1",
    "get_site_v1"
  ]
}
```

See the [Security Guide](security.md#confirmation-guardrails) for detailed explanation and examples.

---

## Resource Limits

Prevent runaway operations and protect against unexpected API behavior.

### Rate Limiting

Maximum API requests per minute. Set to 0 to disable.

```json
{
  "rateLimit": 30
}
```

### Request Timeout

Maximum time to wait for an API response, in milliseconds.

```json
{
  "requestTimeout": 15000
}
```

### Response Size Limit

Maximum size of a single API response. Larger responses are rejected.

```json
{
  "maxResponseSize": 5242880
}
```

### Session Data Limit

Maximum cumulative data returned across all tool calls in a session. When exceeded, subsequent calls fail with `RESOURCE_EXHAUSTED`. Restart the server to reset.

```json
{
  "maxSessionData": 20971520
}
```

### Example: Conservative Limits

```json
{
  "rateLimit": 30,
  "requestTimeout": 15000,
  "maxResponseSize": 5242880,
  "maxSessionData": 20971520
}
```

---

## SSL Configuration

For local development with self-signed certificates:

```json
{
  "skipSslVerify": true
}
```

**Warning**: This disables certificate verification and makes connections vulnerable to interception. Only use in development environments. See the [Security Guide](security.md) for details.

---

## Next Steps

- [Security Guide](security.md) for credential management and trust model
- [Troubleshooting Guide](troubleshooting.md) for common issues
