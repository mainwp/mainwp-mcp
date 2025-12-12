# Security Guide

This guide covers credential management, the trust model, and security best practices for the MainWP MCP Server.

## Trust Model

Understanding the trust boundaries helps you configure the server appropriately for your environment.

### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   AI Assistant  │────▶│  MCP Server     │────▶│ MainWP Dashboard│
│  (Claude, etc.) │     │  (this server)  │     │   (WordPress)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
   You control            Passthrough             Your sites
   the prompts            (no storage)            (full access)
```

### Trust Assumptions

**The AI assistant has the same access as your WordPress user.** When you configure this server with credentials, any tool call the AI makes executes with those permissions. The server does not add access controls beyond what WordPress enforces.

**The server is a passthrough.** It does not store credentials, cache responses long-term, or log sensitive data. Credentials exist only in memory during execution.

**WordPress Application Passwords scope access.** The password you create determines which WordPress capabilities the AI can use. Create a dedicated user with limited roles if you want restricted access.

### What the AI Can Do

With default configuration, the AI can:

- Read all site data (plugins, themes, updates, clients, tags)
- Execute updates across your network
- Activate/deactivate plugins and themes
- Delete plugins, themes, sites, clients, and tags (with confirmation)
- Sync and reconnect sites

### What the AI Cannot Do

- Access WordPress admin directly (no browser session)
- Bypass WordPress permissions (limited to the configured user's capabilities)
- Execute arbitrary PHP code
- Access the filesystem beyond what MainWP exposes

---

## Credential Management

### Application Passwords (Recommended)

WordPress Application Passwords are the recommended authentication method:

1. They can be revoked without changing your main password
2. Each application gets a unique password for auditing
3. WordPress logs which application made each request

Create a dedicated password for the MCP server and label it clearly (e.g., "MainWP MCP Server - Claude").

### Credential Storage Options

**Environment variables** are suitable for:
- Local development
- CI/CD pipelines with secrets management
- Containerized deployments

**Configuration file** (`settings.json`) is suitable for:
- Personal workstations
- When you want credentials separate from shell history

If using a config file, restrict permissions:

```bash
chmod 600 ~/.config/mainwp-mcp/settings.json
```

### What NOT to Do

- Don't commit credentials to version control
- Don't use your main WordPress admin password
- Don't share Application Passwords between applications
- Don't use the same credentials across production and development

---

## Safe Mode

Safe mode prevents all destructive operations by stripping the `confirm: true` parameter that destructive tools require.

### Enabling Safe Mode

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

### What Safe Mode Blocks

Any tool marked as destructive in the MainWP Abilities API:

- `delete_site_v1`
- `delete_client_v1`
- `delete_tag_v1`
- `delete_site_plugins_v1`
- `delete_site_themes_v1`

These tools require `confirm: true` to execute. Safe mode strips this parameter, causing the API to reject the request.

### What Safe Mode Allows

All read operations and non-destructive writes:

- Listing and viewing sites, clients, tags
- Running updates (updates are reversible via backups)
- Activating/deactivating plugins and themes
- Syncing sites
- Creating new clients and tags

### When to Use Safe Mode

- **Training**: Let users explore without risk
- **Development**: Test integrations without affecting real data
- **Read-only access**: When you only need reporting capabilities
- **Demos**: Show capabilities without live changes

---

## Tool Filtering

Limit which tools the AI can access. This reduces attack surface and prevents accidental misuse.

### Read-Only Configuration

Allow only listing and viewing operations:

```json
{
  "allowedTools": [
    "list_sites_v1",
    "get_site_v1",
    "list_updates_v1",
    "list_clients_v1",
    "get_client_v1",
    "list_tags_v1",
    "get_tag_v1"
  ]
}
```

### Block Destructive Operations

Keep most functionality but block deletions:

```json
{
  "blockedTools": [
    "delete_site_v1",
    "delete_client_v1",
    "delete_tag_v1",
    "delete_site_plugins_v1",
    "delete_site_themes_v1"
  ]
}
```

### Updates Only

For automated update workflows:

```json
{
  "allowedTools": [
    "list_sites_v1",
    "list_updates_v1",
    "get_site_updates_v1",
    "run_updates_v1",
    "update_site_core_v1",
    "update_site_plugins_v1",
    "update_site_themes_v1"
  ]
}
```

See the [Configuration Guide](configuration.md#tool-filtering) for complete filtering options.

---

## Resource Limits

Protect against runaway operations and unexpected API behavior.

### Rate Limiting

Limit API requests per minute:

```json
{
  "rateLimit": 30
}
```

This prevents rapid-fire tool calls from overwhelming your server.

### Session Data Limit

Cap the total data returned across all tool calls:

```json
{
  "maxSessionData": 20971520
}
```

When exceeded, subsequent calls fail with `RESOURCE_EXHAUSTED`. Restart the server to reset.

### Response Size Limit

Reject individual responses larger than a threshold:

```json
{
  "maxResponseSize": 5242880
}
```

This prevents a single malformed response from consuming all available memory.

---

## SSL/TLS

### Production

Always use valid SSL certificates in production. The server verifies certificates by default.

### Development

For local development with self-signed certificates:

```json
{
  "skipSslVerify": true
}
```

**Warning**: This disables certificate verification entirely. Connections can be intercepted without detection. Only use in isolated development environments.

### Certificate Issues

If you see SSL errors with a valid certificate:

1. Verify the certificate chain is complete
2. Check that the system CA store is up to date
3. Ensure the certificate matches the domain in `MAINWP_URL`

---

## Logging and Auditing

### What Gets Logged

The server logs to stderr:

- Tool execution start/end (tool name, duration, success/failure)
- Safe mode blocks (which tool was blocked)
- Resource limit violations
- Configuration warnings

### What Does NOT Get Logged

- Credential values
- Tool arguments (may contain sensitive data)
- Response content (may contain PII)

### WordPress Audit Trail

WordPress logs Application Password usage. Check your WordPress admin for:

- Which application made requests
- When requests were made
- Which endpoints were accessed

---

## Security Checklist

Before deploying to production:

- [ ] Created a dedicated WordPress user for API access
- [ ] Generated a unique Application Password for this integration
- [ ] Restricted the WordPress user's capabilities to minimum required
- [ ] Configured tool filtering to expose only needed operations
- [ ] Set appropriate resource limits
- [ ] Verified SSL certificates are valid (no `skipSslVerify`)
- [ ] Tested in safe mode first

---

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly:

1. Do not open a public GitHub issue
2. Email security concerns to the MainWP team
3. Include steps to reproduce and potential impact

---

## Next Steps

- [Configuration Guide](configuration.md) for all settings
- [Troubleshooting Guide](troubleshooting.md) for common issues
