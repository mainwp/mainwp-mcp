# Configuration Reference

## Configuration Methods

The server accepts configuration through environment variables and a configuration file. Environment variables take precedence, so you can use a base configuration file and override specific values at runtime.

## Environment Variables

| Variable                           | Required | Default    | Description                                              |
| ---------------------------------- | -------- | ---------- | -------------------------------------------------------- |
| `MAINWP_URL`                       | Yes      |            | Base URL of your MainWP Dashboard                        |
| `MAINWP_USER`                      | Yes      |            | WordPress admin username                                 |
| `MAINWP_APP_PASSWORD`              | Yes      |            | WordPress Application Password                           |
| `MAINWP_SKIP_SSL_VERIFY`           | No       | `false`    | Skip SSL certificate verification                        |
| `MAINWP_ALLOW_HTTP`                | No       | `false`    | Allow HTTP URLs (credentials sent in plain text)         |
| `MAINWP_SAFE_MODE`                 | No       | `false`    | Block all destructive operations                         |
| `MAINWP_REQUIRE_USER_CONFIRMATION` | No       | `true`     | Require two-step confirmation for destructive operations |
| `MAINWP_ALLOWED_TOOLS`             | No       |            | Comma-separated whitelist of tools                       |
| `MAINWP_BLOCKED_TOOLS`             | No       |            | Comma-separated blacklist of tools                       |
| `MAINWP_SCHEMA_VERBOSITY`          | No       | `standard` | Schema detail level: `standard` or `compact`             |
| `MAINWP_RATE_LIMIT`                | No       | `60`       | Maximum API requests per minute                          |
| `MAINWP_REQUEST_TIMEOUT`           | No       | `30000`    | Request timeout in milliseconds                          |
| `MAINWP_MAX_RESPONSE_SIZE`         | No       | `10485760` | Maximum response size in bytes (10MB)                    |
| `MAINWP_MAX_SESSION_DATA`          | No       | `52428800` | Maximum cumulative session data (50MB)                   |
| `MAINWP_RETRY_ENABLED`             | No       | `true`     | Enable automatic retry for transient errors              |
| `MAINWP_MAX_RETRIES`               | No       | `2`        | Total retry attempts including initial request           |
| `MAINWP_RETRY_BASE_DELAY`          | No       | `1000`     | Base delay between retries in milliseconds               |
| `MAINWP_RETRY_MAX_DELAY`           | No       | `2000`     | Maximum delay between retries in milliseconds            |

## Configuration File

Create a `settings.json` file in one of these locations (checked in order):

1. `./settings.json` (current working directory)
2. `~/.config/mainwp-mcp/settings.json`

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

| settings.json             | Environment Variable               | Type     |
| ------------------------- | ---------------------------------- | -------- |
| `dashboardUrl`            | `MAINWP_URL`                       | string   |
| `username`                | `MAINWP_USER`                      | string   |
| `appPassword`             | `MAINWP_APP_PASSWORD`              | string   |
| `apiToken`                | `MAINWP_TOKEN`                     | string   |
| `skipSslVerify`           | `MAINWP_SKIP_SSL_VERIFY`           | boolean  |
| `allowHttp`               | `MAINWP_ALLOW_HTTP`                | boolean  |
| `safeMode`                | `MAINWP_SAFE_MODE`                 | boolean  |
| `requireUserConfirmation` | `MAINWP_REQUIRE_USER_CONFIRMATION` | boolean  |
| `allowedTools`            | `MAINWP_ALLOWED_TOOLS`             | string[] |
| `blockedTools`            | `MAINWP_BLOCKED_TOOLS`             | string[] |
| `schemaVerbosity`         | `MAINWP_SCHEMA_VERBOSITY`          | string   |
| `rateLimit`               | `MAINWP_RATE_LIMIT`                | number   |
| `requestTimeout`          | `MAINWP_REQUEST_TIMEOUT`           | number   |
| `maxResponseSize`         | `MAINWP_MAX_RESPONSE_SIZE`         | number   |
| `maxSessionData`          | `MAINWP_MAX_SESSION_DATA`          | number   |
| `retryEnabled`            | `MAINWP_RETRY_ENABLED`             | boolean  |
| `maxRetries`              | `MAINWP_MAX_RETRIES`               | number   |
| `retryBaseDelay`          | `MAINWP_RETRY_BASE_DELAY`          | number   |
| `retryMaxDelay`           | `MAINWP_RETRY_MAX_DELAY`           | number   |

A JSON schema is available at `settings.schema.json` for IDE autocompletion.

---

## Tool Filtering

Control which tools are exposed to AI assistants. Useful for limiting access to read-only operations, hiding destructive tools in production, or reducing context size for the AI.

### Whitelist Mode

Only expose specific tools (all others are hidden):

```json
{
  "allowedTools": ["list_sites_v1", "get_site_v1", "list_updates_v1"]
}
```

```bash
MAINWP_ALLOWED_TOOLS="list_sites_v1,get_site_v1,list_updates_v1"
```

### Blacklist Mode

Hide specific tools (all others remain available):

```json
{
  "blockedTools": ["delete_site_v1", "delete_client_v1", "delete_tag_v1"]
}
```

```bash
MAINWP_BLOCKED_TOOLS="delete_site_v1,delete_client_v1,delete_tag_v1"
```

When both are set, the allowlist is applied first, then the blocklist filters the result. Tool names use underscore format (e.g., `list_sites_v1`).

---

## Schema Verbosity

Control the detail level of tool descriptions sent to the AI. This affects token usage in your AI context window.

| Mode       | Description                                    | Token Impact            |
| ---------- | ---------------------------------------------- | ----------------------- |
| `standard` | Full descriptions, safety tags, usage hints    | Default, ~41,500 tokens |
| `compact`  | Truncated descriptions (60 chars), no examples | ~30% reduction          |

```json
{
  "schemaVerbosity": "compact"
}
```

Compact mode works well when you're hitting context limits, the AI already knows the tools, or you're running automated pipelines. It removes inline safety warnings and detailed parameter descriptions, relying instead on MCP semantic annotations (readOnlyHint, destructiveHint). Verify your MCP client displays these annotations before using compact mode for destructive operations.

---

## Safe Mode

Block all destructive operations. The server strips `confirm: true` from tool arguments, causing destructive tools to fail safely.

```json
{
  "safeMode": true
}
```

```bash
MAINWP_SAFE_MODE=true
```

Safe mode is useful for testing, development, read-only access scenarios, and training users on the system. See the [Security Guide](security.md) for more details.

---

## User Confirmation

Control whether destructive operations require two-step confirmation (preview then user approval).

```json
{
  "requireUserConfirmation": true
}
```

When enabled (the default), destructive tools like `delete_site_v1` require the AI to first call with `confirm: true` to get a preview, show that preview to you, then call again with `user_confirmed: true` after you approve. This prevents accidental deletions while still allowing destructive operations when needed.

For automated scripts, CI/CD pipelines, or batch operations where you've already verified the targets, you can disable this:

```json
{
  "requireUserConfirmation": false,
  "allowedTools": ["delete_site_v1", "list_sites_v1", "get_site_v1"]
}
```

See the [Security Guide](security.md#confirmation-guardrails) for examples.

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

---

## Retry Logic

The server automatically retries transient errors to improve reliability against temporary network issues and server overload.

Only read-only operations are retried to preserve idempotency (operations marked with `readonly: true` annotation). Transient errors (HTTP 5xx, HTTP 429, network errors like ECONNRESET) are retried with exponential backoff and jitter. Permanent errors (HTTP 4xx except 429, authentication errors) fail immediately. The total time across all retries never exceeds `requestTimeout`.

| Variable                  | Default | Description                               |
| ------------------------- | ------- | ----------------------------------------- |
| `MAINWP_RETRY_ENABLED`    | `true`  | Enable/disable retry logic                |
| `MAINWP_MAX_RETRIES`      | `2`     | Total attempts including initial request  |
| `MAINWP_RETRY_BASE_DELAY` | `1000`  | Base delay in milliseconds (1 second)     |
| `MAINWP_RETRY_MAX_DELAY`  | `2000`  | Maximum delay in milliseconds (2 seconds) |

```json
{
  "retryEnabled": true,
  "maxRetries": 2,
  "retryBaseDelay": 1000,
  "retryMaxDelay": 2000
}
```

For automation scripts or testing, you can disable retries:

```json
{
  "retryEnabled": false
}
```

Retries bypass the rate limiter to avoid deadlocks. The rate limiter is only applied to the initial request.

---

## SSL Configuration

For local development with self-signed certificates:

```json
{
  "skipSslVerify": true
}
```

This disables certificate verification entirely, making connections vulnerable to interception. Only use in isolated development environments. See the [Security Guide](security.md) for details.
