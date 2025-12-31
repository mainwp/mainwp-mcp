# Security Guide

## Trust Model

Understanding the trust boundaries helps you configure the server appropriately for your environment.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   AI Assistant  │────▶│  MCP Server     │────▶│ MainWP Dashboard│
│  (Claude, etc.) │     │  (this server)  │     │   (WordPress)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
   You control            Passthrough             Your sites
   the prompts            (no storage)            (full access)
```

The AI assistant has the same access as your WordPress user. When you configure this server with credentials, any tool call the AI makes executes with those permissions. The server itself is a passthrough—it stores nothing, caches responses only briefly, and logs no sensitive data. Credentials exist only in memory during execution.

WordPress Application Passwords scope access. The password you create determines which WordPress capabilities the AI can use, so you can create a dedicated user with limited roles if you want restricted access.

With default configuration, the AI can read all site data (plugins, themes, updates, clients, tags), execute updates across your network, activate and deactivate plugins and themes, delete plugins, themes, sites, clients, and tags (with confirmation), and sync and reconnect sites. The AI cannot access WordPress admin directly (no browser session), bypass WordPress permissions, execute arbitrary PHP code, or access the filesystem beyond what MainWP exposes.

---

## Credential Management

### Application Passwords

WordPress Application Passwords are the recommended authentication method. They can be revoked without changing your main password, each application gets a unique password for auditing, and WordPress logs which application made each request.

Create a dedicated password for the MCP server and label it clearly (e.g., "MainWP MCP Server - Claude"). Use a dedicated WordPress user for API access rather than your main admin account. Create unique Application Passwords for each tool rather than sharing one across applications. Keep production and development credentials separate.

### Credential Storage

Environment variables work well for local development, CI/CD pipelines with secrets management, and containerized deployments. A configuration file (`settings.json`) works well for personal workstations where you want credentials separate from shell history. If using a config file, restrict permissions:

```bash
chmod 600 ~/.config/mainwp-mcp/settings.json
```

Avoid committing credentials to version control.

---

## Safe Mode

Safe mode prevents all destructive operations by stripping the `confirm: true` parameter that destructive tools require.

```json
{
  "safeMode": true
}
```

```bash
MAINWP_SAFE_MODE=true
```

Safe mode blocks `delete_site_v1`, `delete_client_v1`, `delete_tag_v1`, `delete_site_plugins_v1`, and `delete_site_themes_v1`. These tools require `confirm: true` to execute, and safe mode strips this parameter, causing the API to reject the request.

All read operations and non-destructive writes remain available: listing and viewing sites, clients, tags; running updates (reversible via backups); activating and deactivating plugins and themes; syncing sites; creating new clients and tags.

Safe mode is useful for training (let users explore without risk), development (test integrations without affecting real data), read-only access (when you only need reporting capabilities), demos (show capabilities without live changes), and first-time setup (familiarize yourself with the system safely).

We recommend enabling Safe Mode when first installing mainwp-mcp. This lets you verify your credentials and connection work correctly, explore available tools without risk of data loss, and understand how the AI interacts with your MainWP Dashboard. Once comfortable, disable Safe Mode to enable full functionality.

The server classifies abilities as destructive or non-destructive based on the `destructive` annotation from the MainWP Dashboard. If an ability lacks annotations, the server defaults to treating it as non-destructive. This is intentional: the MainWP Dashboard controls ability registration, missing annotations indicate a Dashboard-side issue, and new or misconfigured abilities shouldn't be silently blocked. A warning is logged when abilities cannot be reliably classified. For stricter control, use `blockedTools` to explicitly block specific tools or `allowedTools` to whitelist only known-safe tools.

---

## Dry-Run Previews

Before executing any destructive operation, you can preview exactly what will be affected using the `dry_run` parameter:

```
You: Delete the staging plugins, but show me what will happen first

AI: [Calls delete_site_plugins_v1(site_id: 3, plugin_slugs: ["debug-bar"], dry_run: true)]
    Server returns preview:
    {
      "dry_run": true,
      "would_delete": ["debug-bar/debug-bar.php"],
      "sites_affected": 1
    }

AI: If I proceed, this will delete the "debug-bar" plugin from site 3.
    Should I continue?
```

The following destructive tools support `dry_run: true`: `delete_site_v1`, `delete_client_v1`, `delete_tag_v1`, `delete_site_plugins_v1`, and `delete_site_themes_v1`.

Use dry-run before bulk operations affecting multiple items, when you're unsure about the scope of a deletion, when training or learning the system, and before any operation you can't easily reverse.

---

## Server Log Considerations

When the MCP server executes destructive operations (DELETE requests), the input parameters are sent as URL query string parameters rather than in the request body. This is required for compatibility with the WordPress Abilities API.

Parameters like `site_id=123`, `confirm=true`, `dry_run=true` appear in the URL, which means your MainWP Dashboard web server logs these URLs in access logs. No credentials are exposed (authentication uses HTTP headers), but operational parameters are logged. Restrict access to web server logs, configure log rotation and retention policies appropriate for your compliance requirements, and consider log redaction if you have strict data handling policies.

---

## Confirmation Guardrails

The two-step confirmation flow prevents accidental destructive operations by requiring the AI to show you a preview before executing deletions.

When you ask the AI to delete something, the server intercepts the request and returns a preview instead of executing immediately. The AI shows you what will be deleted and asks for explicit confirmation. Only after you confirm does the server execute the operation.

**Phase 1 - Preview:** AI calls the destructive tool with `confirm: true`. Server runs a dry-run preview and returns details. AI shows you what will be affected and waits for your response.

**Phase 2 - Execute:** You confirm the action. AI calls the tool again with `user_confirmed: true`. Server validates the preview was shown (within last 5 minutes) and executes the deletion.

Example flow:

```
You: Delete the "staging" tag

AI: [Calls delete_tag_v1(tag_id: 5, confirm: true)]
    Server returns preview:
    {
      "tag_id": 5,
      "name": "staging",
      "sites_affected": 12,
      "clients_affected": 3
    }

AI: I found the "staging" tag (ID: 5).
    This will affect 12 sites and 3 clients.
    Do you want me to delete it?

You: Yes

AI: [Calls delete_tag_v1(tag_id: 5, user_confirmed: true)]
    Tag deleted successfully.
```

### Comparison with Safe Mode

| Feature         | Safe Mode                           | Confirmation Flow                               |
| --------------- | ----------------------------------- | ----------------------------------------------- |
| Purpose         | Block all destructive operations    | Allow destructive operations with user approval |
| Use Case        | Testing, read-only access, training | Production with trusted AI                      |
| Destructive Ops | Completely blocked                  | Allowed after confirmation                      |
| User Experience | AI says "I can't do that"           | AI shows preview and asks for approval          |
| Automation      | Unsuitable                          | Can be disabled for scripts                     |
| Default         | Disabled                            | Enabled                                         |

When both are configured, Safe Mode takes precedence. Previews expire after 5 minutes—if you wait too long to confirm, you'll need to request a new preview.

For automated scripts that need to delete without interaction:

```json
{
  "requireUserConfirmation": false
}
```

Only disable this for trusted automation scripts. With confirmation disabled, the AI can delete resources with just `confirm: true` and no user interaction.

Previews are stored in memory (cleared on server restart), tied to specific operation parameters, and limited to 100 pending previews to prevent memory exhaustion.

---

## AI Client Limitations

The mainwp-mcp server provides multiple safety mechanisms for destructive operations, but ultimately the AI client decides whether to follow these instructions.

The MCP protocol allows servers to provide semantic annotations (`destructiveHint: true`) marking dangerous tools, description warnings with confirmation instructions, and confirmation flow requirements. These are advisory. The AI client receives this information and decides what to do with it.

Some AI clients may skip the preview step entirely, misinterpret user responses as confirmation, assume operations are "safe" based on their own reasoning, or hallucinate that the user confirmed when they did not. These behaviors are AI client limitations, not mainwp-mcp server issues.

If you experience these issues, enable Safe Mode (`safeMode: true`) to block all destructive operations, report the behavior to your AI client vendor with specific examples, consider using a different AI client, and keep backups of your MainWP Dashboard database.

For untrusted AI clients:

```json
{
  "safeMode": true,
  "blockedTools": [
    "delete_site_v1",
    "delete_client_v1",
    "delete_tag_v1",
    "delete_site_plugins_v1",
    "delete_site_themes_v1"
  ]
}
```

This provides defense-in-depth: Safe Mode blocks destructive operations at runtime, and `blockedTools` prevents the tools from even appearing in the AI's tool list.

---

## Tool Filtering

Limit which tools the AI can access to reduce attack surface and prevent accidental misuse.

**Read-Only Configuration:**

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

**Block Destructive Operations:**

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

**Updates Only:**

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

Rate limiting (`rateLimit: 30`) caps API requests per minute to prevent rapid-fire tool calls from overwhelming your server. Session data limits (`maxSessionData: 20971520`) cap total data returned across all tool calls—when exceeded, subsequent calls fail with `RESOURCE_EXHAUSTED` and require a server restart. Response size limits (`maxResponseSize: 5242880`) reject individual responses larger than a threshold to prevent a single malformed response from consuming all available memory.

---

## SSL/TLS

Always use valid SSL certificates in production. The server verifies certificates by default.

For local development with self-signed certificates:

```json
{
  "skipSslVerify": true
}
```

This disables certificate verification entirely. Connections can be intercepted without detection. Only use in isolated development environments.

If you see SSL errors with a valid certificate, verify the certificate chain is complete, check that the system CA store is up to date, and ensure the certificate matches the domain in `MAINWP_URL`.

---

## Logging and Auditing

The server logs to stderr: destructive operation audit messages, tool execution start/end (tool name, duration, success/failure), safe mode blocks, resource limit violations, and configuration warnings.

The server does not log credential values, tool arguments (which may contain sensitive data), response content (which may contain PII), or preview keys for destructive operations (which contain argument data).

WordPress logs Application Password usage. Check your WordPress admin for which application made requests, when requests were made, and which endpoints were accessed.

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
