# Troubleshooting Guide

Common issues and solutions for the MainWP MCP Server.

## Connection Issues

### "Unable to connect to MainWP Dashboard"

**Symptoms**: Server fails to start or tools return connection errors.

**Check these in order**:

1. **Verify the URL is correct**
   ```bash
   curl -I https://your-dashboard.com/wp-json/
   ```
   You should see a 200 response. If not, the URL may be wrong or WordPress REST API is disabled.

2. **Test authentication**
   ```bash
   curl -u "username:app-password" https://your-dashboard.com/wp-json/wp/v2/users/me
   ```
   This should return your user profile. If it fails:
   - Verify the username is correct
   - Regenerate the Application Password
   - Check that Application Passwords are enabled (some security plugins disable them)

3. **Check the Abilities API**
   ```bash
   curl -u "username:app-password" https://your-dashboard.com/wp-json/wp-abilities/v1/abilities?per_page=1
   ```
   If this returns an error, the MainWP Abilities API plugin may not be installed or activated.

### "SSL certificate problem"

**Symptoms**: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or similar SSL errors.

**For development** (self-signed certs):
```json
{
  "skipSslVerify": true
}
```

**For production**, fix the certificate:
1. Ensure the full certificate chain is installed
2. Verify the certificate matches your domain
3. Check certificate expiration

### "ECONNREFUSED" or "ETIMEDOUT"

**Symptoms**: Server can't reach the dashboard at all.

**Causes**:
- Dashboard server is down
- Firewall blocking the connection
- Wrong port in URL
- VPN or network issues

**Fixes**:
- Verify you can reach the URL from your machine
- Check if a VPN is required
- Try with the IP address instead of hostname (temporarily, for testing)

---

## Authentication Errors

### "401 Unauthorized"

**Symptoms**: All tool calls fail with 401.

**Common causes**:

1. **Wrong username**: The username must match exactly (case-sensitive)

2. **Wrong Application Password**:
   - Regenerate in WordPress admin
   - The password displays with spaces for readability; both `xxxx xxxx` and `xxxxxxxx` work

3. **Application Passwords disabled**:
   - Some security plugins (Wordfence, iThemes Security) disable Application Passwords
   - Check your security plugin settings

4. **Two-factor authentication**:
   - Application Passwords bypass 2FA, but some 2FA plugins interfere
   - Try temporarily disabling 2FA to test

### "403 Forbidden"

**Symptoms**: Some tools work but others return 403.

**Cause**: The WordPress user lacks required capabilities.

**Fix**: Ensure the user has administrator role, or at minimum has capabilities required for the operations you need.

### Bearer Token Not Working

**Symptoms**: Works with username/password but not with `MAINWP_TOKEN`.

**Check**:
1. Token was generated correctly in MainWP Dashboard
2. Token hasn't expired
3. You're using the correct environment variable (`MAINWP_TOKEN`, not `MAINWP_APP_PASSWORD`)

When in doubt, use Application Password authentication instead.

---

## Tool Errors

### "Tool not found"

**Symptoms**: `Unknown tool: some_tool_v1`

**Causes**:
1. Tool name is misspelled
2. Tool is blocked by `blockedTools` configuration
3. Tool is not in `allowedTools` whitelist
4. The ability doesn't exist in MainWP Dashboard

**Check your configuration**:
```json
{
  "allowedTools": ["list_sites_v1"],
  "blockedTools": ["delete_site_v1"]
}
```

Tool names use underscores (e.g., `list_sites_v1`), not hyphens.

### "Safe mode blocked operation"

**Symptoms**:
```json
{
  "error": "SAFE_MODE_BLOCKED",
  "message": "Safe mode blocked destructive operation: delete_site_v1"
}
```

**Cause**: Safe mode is enabled and you tried a destructive operation.

**Fix**: Disable safe mode if you need destructive operations:
```json
{
  "safeMode": false
}
```

Or use environment variable:
```bash
MAINWP_SAFE_MODE=false
```

### "Confirmation required"

**Symptoms**: Destructive operation returns an error about missing confirmation.

**Cause**: Destructive tools require `confirm: true` parameter.

**Fix**: The AI should pass `confirm: true`. If it's not:
1. Check if safe mode is stripping the parameter
2. Verify the AI understands the confirmation requirement (the tool description includes this)

---

## Resource Limit Errors

### "RESOURCE_EXHAUSTED: Session data limit exceeded"

**Symptoms**: Tools start failing after working initially.

**Cause**: Cumulative response data exceeded `maxSessionData` limit.

**Fixes**:
1. Restart the MCP server (resets the counter)
2. Increase the limit:
   ```json
   {
     "maxSessionData": 104857600
   }
   ```
3. Use pagination to fetch smaller chunks of data

### "Response too large"

**Symptoms**: Specific tool calls fail with size errors.

**Cause**: Single response exceeded `maxResponseSize` limit.

**Fixes**:
1. Increase the limit:
   ```json
   {
     "maxResponseSize": 20971520
   }
   ```
2. Use filters to reduce response size (e.g., filter by status, limit per_page)

### "Rate limit exceeded"

**Symptoms**: Tools fail after many rapid calls.

**Cause**: Too many API requests in a short period.

**Fixes**:
1. Wait and retry
2. Increase rate limit:
   ```json
   {
     "rateLimit": 120
   }
   ```
3. Set to 0 to disable rate limiting (not recommended for production)

---

## Configuration Issues

### "Configuration file not found"

**Symptoms**: Server uses defaults instead of your settings.

**Check these locations** (in order of priority):
1. `./settings.json` (current working directory)
2. `~/.config/mainwp-mcp/settings.json`

**Verify the file is valid JSON**:
```bash
cat settings.json | jq .
```

If `jq` shows an error, fix the JSON syntax.

### Environment Variables Not Working

**Symptoms**: Config file values used instead of environment variables.

**Check**:
1. Variables are exported:
   ```bash
   export MAINWP_URL="https://..."
   ```
   Not just:
   ```bash
   MAINWP_URL="https://..."
   ```

2. Variable names are exact (case-sensitive):
   - `MAINWP_URL` (correct)
   - `mainwp_url` (wrong)
   - `MAINWP-URL` (wrong)

3. Values don't have extra quotes:
   ```bash
   # Correct
   export MAINWP_URL=https://example.com

   # Also correct
   export MAINWP_URL="https://example.com"

   # Wrong (nested quotes)
   export MAINWP_URL="\"https://example.com\""
   ```

### MCP Host Not Finding Server

**Symptoms**: Claude Code, VS Code, or other hosts don't show MainWP tools.

**For Claude Code** (`~/.claude.json`):
1. Verify JSON syntax is valid
2. Check the path to `dist/index.js` is absolute and correct
3. Restart Claude Code after config changes

**For VS Code** (`.vscode/mcp.json`):
1. Ensure you're in a workspace (not just a single file)
2. Check VS Code version is 1.101+
3. Verify Agent Mode is enabled

**For Claude Desktop**:
1. Check config file location:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Restart Claude Desktop after config changes

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

This opens a web interface where you can:
- List all available tools
- Execute tools with custom arguments
- See raw request/response data

### Check Server Health

Make sure the server starts correctly:

```bash
# With environment variables
MAINWP_URL="..." MAINWP_USER="..." MAINWP_APP_PASSWORD="..." node dist/index.js

# With settings.json
node dist/index.js
```

The server should output startup messages to stderr and then wait for MCP commands on stdin.

---

## Getting Help

If you've tried these steps and still have issues:

1. Check [GitHub Issues](https://github.com/mainwp/mainwp-mcp/issues) for similar problems
2. Open a new issue with:
   - Error message (full text)
   - Your configuration (redact credentials)
   - Steps to reproduce
   - Node.js version (`node --version`)
   - MCP host and version (Claude Code, VS Code, etc.)

---

## Next Steps

- [Installation Guide](installation.md) for setup instructions
- [Configuration Guide](configuration.md) for all settings
- [Security Guide](security.md) for credential management
