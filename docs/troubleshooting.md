# Troubleshooting

## Connection Issues

### "Unable to connect to MainWP Dashboard"

Server fails to start or tools return connection errors.

**Verify the URL is correct:**

```bash
curl -I https://your-dashboard.com/wp-json/
```

You should see a 200 response. If not, the URL may be wrong or WordPress REST API is disabled.

**Test authentication:**

```bash
curl -u "username:app-password" https://your-dashboard.com/wp-json/wp/v2/users/me
```

This should return your user profile. If it fails, verify the username is correct, regenerate the Application Password, and check that Application Passwords are enabled (some security plugins disable them).

**Check the Abilities API:**

```bash
curl -u "username:app-password" https://your-dashboard.com/wp-json/wp-abilities/v1/abilities?per_page=1
```

If this returns an error, the MainWP Abilities API plugin may not be installed or activated.

### "SSL certificate problem"

`UNABLE_TO_VERIFY_LEAF_SIGNATURE` or similar SSL errors.

For development with self-signed certs:

```json
{
  "skipSslVerify": true
}
```

For production, fix the certificate: ensure the full certificate chain is installed, verify the certificate matches your domain, and check certificate expiration.

### "dashboardUrl uses HTTP which transmits credentials in plain text"

The server blocks HTTP URLs by default because credentials would be sent unencrypted over the network. If you're using HTTP intentionally (local development without SSL), explicitly allow it:

```json
{
  "allowHttp": true
}
```

Or via environment variable:

```bash
MAINWP_ALLOW_HTTP=true
```

For production environments, configure HTTPS on your MainWP Dashboard instead of enabling this option.

### "ECONNREFUSED" or "ETIMEDOUT"

Server can't reach the dashboard at all. The dashboard server may be down, a firewall may be blocking the connection, the port in the URL may be wrong, or there may be VPN or network issues. Verify you can reach the URL from your machine and try with the IP address instead of hostname temporarily for testing.

---

## Authentication Errors

### "401 Unauthorized"

All tool calls fail with 401.

The username must match exactly (case-sensitive). Regenerate the Application Password in WordPress admin—the password displays with spaces for readability but both `xxxx xxxx` and `xxxxxxxx` work. Check if Application Passwords are disabled by a security plugin (Wordfence, iThemes Security). If you use two-factor authentication, note that Application Passwords bypass 2FA, but some 2FA plugins interfere—try temporarily disabling 2FA to test.

### "403 Forbidden"

Some tools work but others return 403. The WordPress user lacks required capabilities. Ensure the user has administrator role, or at minimum has capabilities required for the operations you need.

### Bearer Token Not Working

Works with username/password but not with `MAINWP_TOKEN`. Check that the token was generated correctly in MainWP Dashboard, the token hasn't expired, and you're using the correct environment variable (`MAINWP_TOKEN`, not `MAINWP_APP_PASSWORD`). When in doubt, use Application Password authentication instead.

---

## Tool Errors

### "Tool not found"

`Unknown tool: some_tool_v1`

The tool name may be misspelled, the tool may be blocked by `blockedTools` configuration, the tool may not be in `allowedTools` whitelist, or the ability may not exist in MainWP Dashboard. Tool names use underscores (e.g., `list_sites_v1`), not hyphens.

### "Safe mode blocked operation"

```json
{
  "error": "SAFE_MODE_BLOCKED",
  "message": "Safe mode blocked destructive operation: delete_site_v1"
}
```

Safe mode is enabled and you tried a destructive operation. Disable safe mode if you need destructive operations:

```json
{
  "safeMode": false
}
```

### "Confirmation required"

Destructive operation returns an error about missing confirmation. Destructive tools require a two-step confirmation flow: AI calls with `confirm: true` to get a preview, AI shows you the preview, you confirm, then AI calls with `user_confirmed: true` to execute.

If the AI isn't following this flow, check if safe mode is enabled (it blocks all destructive operations), try being explicit ("Show me what will be deleted first"), and verify `requireUserConfirmation` is enabled (default: `true`).

For automation scripts, disable the confirmation flow:

```json
{
  "requireUserConfirmation": false
}
```

---

## Confirmation Flow Errors

### "PREVIEW_REQUIRED"

```json
{
  "error": "PREVIEW_REQUIRED",
  "message": "No preview found. You must first call with confirm: true to generate a preview."
}
```

The AI tried to execute a destructive operation with `user_confirmed: true` without first requesting a preview. The two-step confirmation flow requires the AI to show you a preview before executing. The AI skipped the preview step.

This is usually an AI behavior issue. Try rephrasing: "Show me what will be deleted first, then I'll confirm."

### "PREVIEW_EXPIRED"

```json
{
  "error": "PREVIEW_EXPIRED",
  "message": "Preview has expired. Please request a new preview."
}
```

You waited more than 5 minutes between seeing the preview and confirming the operation. Request a new preview—the AI will automatically do this if you just say "yes" or "proceed."

### "CONFLICTING_PARAMETERS"

```json
{
  "error": "CONFLICTING_PARAMETERS",
  "message": "Cannot use user_confirmed and dry_run together."
}
```

The AI tried to pass both `user_confirmed: true` and `dry_run: true` simultaneously. These parameters have contradictory meanings: `user_confirmed` means "execute this operation" while `dry_run` means "just show me what would happen." The AI should use one or the other.

### "INVALID_PARAMETER: user_confirmed not supported"

```json
{
  "error": "INVALID_PARAMETER",
  "message": "user_confirmed parameter is not supported for this tool."
}
```

The AI tried to use `user_confirmed: true` on a non-destructive tool. Only `delete_site_v1`, `delete_client_v1`, `delete_tag_v1`, `delete_site_plugins_v1`, and `delete_site_themes_v1` support `user_confirmed`. Other tools don't need confirmation.

---

## Resource Limit Errors

### "RESOURCE_EXHAUSTED: Session data limit exceeded"

Tools start failing after working initially. Cumulative response data exceeded `maxSessionData` limit.

Restart the MCP server (resets the counter), increase the limit, or use pagination to fetch smaller chunks of data:

```json
{
  "maxSessionData": 104857600
}
```

### "Response too large"

Specific tool calls fail with size errors. Single response exceeded `maxResponseSize` limit.

Increase the limit or use filters to reduce response size (filter by status, limit per_page):

```json
{
  "maxResponseSize": 20971520
}
```

### "Rate limit exceeded"

Tools fail after many rapid calls. Too many API requests in a short period.

Wait and retry, increase rate limit, or set to 0 to disable rate limiting (not recommended for production):

```json
{
  "rateLimit": 120
}
```

---

## Configuration Issues

### "Configuration file not found"

Server uses defaults instead of your settings. Check these locations (in order of priority):

1. `./settings.json` (current working directory)
2. `~/.config/mainwp-mcp/settings.json`

Verify the file is valid JSON:

```bash
cat settings.json | jq .
```

### Environment Variables Not Working

Config file values used instead of environment variables.

Variables must be exported:

```bash
export MAINWP_URL="https://..."
```

Not just:

```bash
MAINWP_URL="https://..."
```

Variable names are case-sensitive (`MAINWP_URL` is correct, `mainwp_url` is wrong). Values shouldn't have nested quotes.

### MCP Host Not Finding Server

Claude Code, VS Code, or other hosts don't show MainWP tools.

**For Claude Code** (`~/.claude.json`): Verify JSON syntax is valid, check the path to `dist/index.js` is absolute and correct, restart Claude Code after config changes.

**For VS Code** (`.vscode/mcp.json`): Ensure you're in a workspace (not just a single file), check VS Code version is 1.101+, verify Agent Mode is enabled.

**For Claude Desktop**: Check config file location (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), restart Claude Desktop after config changes.

---

## Debugging

### Enable Verbose Logging

The server logs to stderr. To see all output:

```bash
node dist/index.js 2>&1 | tee server.log
```

### Test with MCP Inspector

The MCP Inspector lets you test tools interactively:

```bash
npm run inspect
```

This opens a web interface where you can list all available tools, execute tools with custom arguments, and see raw request/response data.

### Check Server Health

Make sure the server starts correctly:

```bash
MAINWP_URL="..." MAINWP_USER="..." MAINWP_APP_PASSWORD="..." node dist/index.js
```

The server should output startup messages to stderr and then wait for MCP commands on stdin.
