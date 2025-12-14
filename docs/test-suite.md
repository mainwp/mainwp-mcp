# MainWP MCP Server Test Suite

This document provides comprehensive test suites for validating the MainWP MCP Server functionality. It is designed for both human testers and AI assistants to verify configuration options and natural language query handling.

## Table of Contents

- [Part 1: Configuration Testing Suite](#part-1-configuration-testing-suite)
  - [1.1 Authentication Tests](#11-authentication-tests)
  - [1.2 URL and SSL Tests](#12-url-and-ssl-tests)
  - [1.3 Tool Filtering Tests](#13-tool-filtering-tests)
  - [1.4 Safe Mode Tests](#14-safe-mode-tests)
  - [1.5 Resource Limits Tests](#15-resource-limits-tests)
  - [1.6 Schema Verbosity Tests](#16-schema-verbosity-tests)
  - [1.7 Namespace Tests](#17-namespace-tests)
  - [1.8 Configuration Precedence Tests](#18-configuration-precedence-tests)
- [Part 2: Natural Language Query Test Suite](#part-2-natural-language-query-test-suite)
  - [2.1 Common/Expected Queries](#21-commonexpected-queries)
  - [2.2 Edge Cases/Uncommon Queries](#22-edge-casesuncommon-queries)
- [Test Environment Setup](#test-environment-setup)

---

## Part 1: Configuration Testing Suite

### 1.1 Authentication Tests

#### Basic Auth (Recommended)

| Test ID | Setting                    | Test Scenario                          | Expected Behavior                               | Verification Method                                   |
| ------- | -------------------------- | -------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| AUTH-01 | `username` + `appPassword` | Configure valid Basic Auth credentials | Server starts successfully, tools are listed    | Run `npm run dev` and check for successful connection |
| AUTH-02 | `username` + `appPassword` | Configure invalid username             | Server fails to start with authentication error | Check error message mentions authentication failure   |
| AUTH-03 | `username` + `appPassword` | Configure invalid appPassword          | Server fails to start with authentication error | Check error message mentions authentication failure   |
| AUTH-04 | `username` only            | Missing appPassword                    | Server fails with missing credential error      | Check for "Missing required configuration" error      |
| AUTH-05 | `appPassword` only         | Missing username                       | Server fails with missing credential error      | Check for "Missing required configuration" error      |

#### Bearer Token Auth

| Test ID | Setting    | Test Scenario                  | Expected Behavior                            | Verification Method                                   |
| ------- | ---------- | ------------------------------ | -------------------------------------------- | ----------------------------------------------------- |
| AUTH-06 | `apiToken` | Configure valid Bearer token   | Server starts successfully, tools are listed | Run `npm run dev` and check for successful connection |
| AUTH-07 | `apiToken` | Configure invalid Bearer token | Server fails with authentication error       | Check error message mentions authentication failure   |
| AUTH-08 | `apiToken` | Empty token string             | Server fails with validation error           | Check for validation error message                    |

#### Auth Precedence

| Test ID | Setting                        | Test Scenario                         | Expected Behavior                        | Verification Method                              |
| ------- | ------------------------------ | ------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| AUTH-09 | Both Basic Auth + Bearer Token | Configure both authentication methods | Basic Auth is used, Bearer token ignored | Check server logs for auth method used           |
| AUTH-10 | No auth credentials            | No authentication configured          | Server fails with missing auth error     | Check for "Missing required configuration" error |

### 1.2 URL and SSL Tests

#### Dashboard URL

| Test ID | Setting        | Test Scenario                | Expected Behavior                      | Verification Method                              |
| ------- | -------------- | ---------------------------- | -------------------------------------- | ------------------------------------------------ |
| URL-01  | `dashboardUrl` | Valid HTTPS URL              | Server connects successfully           | Tools are listed                                 |
| URL-02  | `dashboardUrl` | HTTP URL without `allowHttp` | Server rejects URL with security error | Check for "HTTPS required" or similar error      |
| URL-03  | `dashboardUrl` | Invalid URL format           | Server fails with validation error     | Check for URL validation error                   |
| URL-04  | `dashboardUrl` | URL with trailing slash      | Server handles gracefully (normalized) | Tools are listed correctly                       |
| URL-05  | `dashboardUrl` | Missing URL                  | Server fails with required field error | Check for "Missing required configuration" error |
| URL-06  | `dashboardUrl` | Unreachable URL              | Server fails with connection error     | Check for timeout or connection refused error    |

#### SSL Configuration

| Test ID | Setting                | Test Scenario                         | Expected Behavior               | Verification Method                    |
| ------- | ---------------------- | ------------------------------------- | ------------------------------- | -------------------------------------- |
| SSL-01  | `skipSslVerify: false` | Connect to site with valid SSL        | Connection succeeds             | Tools are listed                       |
| SSL-02  | `skipSslVerify: false` | Connect to site with self-signed cert | Connection fails with SSL error | Check for certificate validation error |
| SSL-03  | `skipSslVerify: true`  | Connect to site with self-signed cert | Connection succeeds (insecure)  | Tools are listed                       |
| SSL-04  | `skipSslVerify: true`  | Connect to site with valid SSL        | Connection succeeds             | Tools are listed                       |

#### Allow HTTP

| Test ID | Setting                      | Test Scenario | Expected Behavior                  | Verification Method            |
| ------- | ---------------------------- | ------------- | ---------------------------------- | ------------------------------ |
| HTTP-01 | `allowHttp: false` (default) | Use HTTP URL  | Server rejects with security error | Check for HTTP rejection error |
| HTTP-02 | `allowHttp: true`            | Use HTTP URL  | Server connects (insecure)         | Tools are listed               |
| HTTP-03 | `allowHttp: true`            | Use HTTPS URL | Server connects normally           | Tools are listed               |

### 1.3 Tool Filtering Tests

#### Whitelist Mode (allowedTools)

| Test ID   | Setting                                            | Test Scenario            | Expected Behavior                 | Verification Method                           |
| --------- | -------------------------------------------------- | ------------------------ | --------------------------------- | --------------------------------------------- |
| FILTER-01 | `allowedTools: ["list_sites_v1"]`                  | Single tool whitelist    | Only `list_sites_v1` is exposed   | Call ListTools, verify only one tool returned |
| FILTER-02 | `allowedTools: ["list_sites_v1", "get_site_v1"]`   | Multiple tools whitelist | Only specified tools exposed      | Call ListTools, verify exact tools returned   |
| FILTER-03 | `allowedTools: []`                                 | Empty whitelist          | No tools exposed                  | Call ListTools, verify empty list             |
| FILTER-04 | `allowedTools: ["nonexistent_tool"]`               | Invalid tool name        | Tool not found, graceful handling | Server starts, no matching tools exposed      |
| FILTER-05 | `MAINWP_ALLOWED_TOOLS="list_sites_v1,get_site_v1"` | Env var comma-separated  | Both tools exposed                | Call ListTools, verify both tools             |

**Environment Variable Format:**

```bash
MAINWP_ALLOWED_TOOLS="list_sites_v1,get_site_v1,list_updates_v1"
```

**settings.json Format:**

```json
{
  "allowedTools": ["list_sites_v1", "get_site_v1", "list_updates_v1"]
}
```

#### Blacklist Mode (blockedTools)

| Test ID   | Setting                                                                 | Test Scenario            | Expected Behavior                       | Verification Method                          |
| --------- | ----------------------------------------------------------------------- | ------------------------ | --------------------------------------- | -------------------------------------------- |
| FILTER-06 | `blockedTools: ["delete_site_v1"]`                                      | Single tool blacklist    | `delete_site_v1` hidden, others exposed | Call ListTools, verify delete_site_v1 absent |
| FILTER-07 | `blockedTools: ["delete_site_v1", "delete_client_v1", "delete_tag_v1"]` | Multiple tools blacklist | All delete tools hidden                 | Call ListTools, verify no delete tools       |
| FILTER-08 | `blockedTools: []`                                                      | Empty blacklist          | All tools exposed                       | Call ListTools, verify all tools present     |
| FILTER-09 | `blockedTools: ["nonexistent_tool"]`                                    | Invalid tool name        | No effect, all tools exposed            | All valid tools available                    |
| FILTER-10 | `MAINWP_BLOCKED_TOOLS="delete_site_v1,delete_client_v1"`                | Env var comma-separated  | Both tools hidden                       | Verify both tools absent from ListTools      |

**Environment Variable Format:**

```bash
MAINWP_BLOCKED_TOOLS="delete_site_v1,delete_client_v1,delete_tag_v1"
```

**settings.json Format:**

```json
{
  "blockedTools": ["delete_site_v1", "delete_client_v1", "delete_tag_v1"]
}
```

#### Combined Filtering

| Test ID   | Setting                            | Test Scenario                                                                                  | Expected Behavior                                                  | Verification Method                        |
| --------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| FILTER-11 | Both allowedTools and blockedTools | Whitelist = ["list_sites_v1", "get_site_v1", "delete_site_v1"], Blacklist = ["delete_site_v1"] | Whitelist applied first, then blacklist filters out delete_site_v1 | Only list_sites_v1 and get_site_v1 exposed |
| FILTER-12 | Overlapping lists                  | Same tool in both lists                                                                        | Server should reject configuration or handle gracefully            | Check for configuration validation error   |

#### Edge Cases

| Test ID   | Setting                    | Test Scenario                          | Expected Behavior                               | Verification Method                |
| --------- | -------------------------- | -------------------------------------- | ----------------------------------------------- | ---------------------------------- |
| FILTER-13 | allowedTools with spaces   | `"list_sites_v1 , get_site_v1"`        | Server handles whitespace gracefully            | Tools exposed correctly            |
| FILTER-14 | Tool name case sensitivity | `"LIST_SITES_V1"` vs `"list_sites_v1"` | Verify case handling (should be case-sensitive) | Test both cases, document behavior |
| FILTER-15 | Duplicate tool names       | `["list_sites_v1", "list_sites_v1"]`   | Duplicates handled (uniqueItems in schema)      | Server handles gracefully          |

### 1.4 Safe Mode Tests

| Test ID | Setting                     | Test Scenario                               | Expected Behavior                     | Verification Method               |
| ------- | --------------------------- | ------------------------------------------- | ------------------------------------- | --------------------------------- |
| SAFE-01 | `safeMode: false` (default) | Call destructive tool with `confirm: true`  | Operation executes                    | Verify operation completes        |
| SAFE-02 | `safeMode: true`            | Call destructive tool with `confirm: true`  | Operation blocked, `confirm` stripped | Returns `SAFE_MODE_BLOCKED` error |
| SAFE-03 | `safeMode: true`            | Call destructive tool without `confirm`     | Operation blocked (would fail anyway) | Returns error (missing confirm)   |
| SAFE-04 | `safeMode: true`            | Call read-only tool (e.g., `list_sites_v1`) | Operation succeeds                    | Data returned normally            |
| SAFE-05 | `safeMode: true`            | Call tool with `dry_run: true`              | Operation succeeds (dry run allowed)  | Dry run result returned           |
| SAFE-06 | `MAINWP_SAFE_MODE=true`     | Env var enabling safe mode                  | Same as SAFE-02                       | Verify destructive ops blocked    |

**Destructive Tools to Test:**

- `delete_site_v1`
- `delete_client_v1`
- `delete_tag_v1`
- `delete_site_plugins_v1`
- `delete_site_themes_v1`

**Safe Mode Configuration:**

```bash
# Environment variable
MAINWP_SAFE_MODE=true
```

```json
// settings.json
{
  "safeMode": true
}
```

### 1.5 Resource Limits Tests

#### Rate Limiting

| Test ID  | Setting                   | Test Scenario                  | Expected Behavior                     | Verification Method                  |
| -------- | ------------------------- | ------------------------------ | ------------------------------------- | ------------------------------------ |
| LIMIT-01 | `rateLimit: 60` (default) | Make 60 requests in one minute | All requests succeed                  | All responses received               |
| LIMIT-02 | `rateLimit: 60`           | Make 70 requests in one minute | First 60 succeed, remaining throttled | Check for rate limit errors after 60 |
| LIMIT-03 | `rateLimit: 10`           | Make 15 requests quickly       | First 10 succeed, rest throttled      | Verify throttling kicks in           |
| LIMIT-04 | `rateLimit: 0`            | Disable rate limiting          | All requests processed without limit  | No throttling occurs                 |
| LIMIT-05 | `rateLimit: -1`           | Invalid negative value         | Server rejects configuration          | Validation error at startup          |

#### Request Timeout

| Test ID  | Setting                           | Test Scenario           | Expected Behavior                  | Verification Method         |
| -------- | --------------------------------- | ----------------------- | ---------------------------------- | --------------------------- |
| LIMIT-06 | `requestTimeout: 30000` (default) | Fast API response       | Request completes normally         | Response received           |
| LIMIT-07 | `requestTimeout: 1000`            | Slow API response (>1s) | Request aborted with timeout error | Timeout error returned      |
| LIMIT-08 | `requestTimeout: 0`               | Invalid zero timeout    | Server rejects configuration       | Validation error at startup |

#### Response Size Limit

| Test ID  | Setting                                    | Test Scenario            | Expected Behavior            | Verification Method         |
| -------- | ------------------------------------------ | ------------------------ | ---------------------------- | --------------------------- |
| LIMIT-09 | `maxResponseSize: 10485760` (default 10MB) | Response under limit     | Response accepted            | Data returned normally      |
| LIMIT-10 | `maxResponseSize: 1000`                    | Response over 1000 bytes | Response rejected            | Size limit error returned   |
| LIMIT-11 | `maxResponseSize: 0`                       | Invalid zero size        | Server rejects configuration | Validation error at startup |

#### Session Data Limit

| Test ID  | Setting                                   | Test Scenario               | Expected Behavior                  | Verification Method                    |
| -------- | ----------------------------------------- | --------------------------- | ---------------------------------- | -------------------------------------- |
| LIMIT-12 | `maxSessionData: 52428800` (default 50MB) | Cumulative data under limit | All requests succeed               | Responses received                     |
| LIMIT-13 | `maxSessionData: 10000`                   | Exceed 10KB cumulative      | Early requests succeed, later fail | `RESOURCE_EXHAUSTED` error after limit |
| LIMIT-14 | Server restart                            | After hitting session limit | Session data counter resets        | New requests succeed                   |

### 1.6 Schema Verbosity Tests

| Test ID   | Setting                                 | Test Scenario               | Expected Behavior                               | Verification Method                 |
| --------- | --------------------------------------- | --------------------------- | ----------------------------------------------- | ----------------------------------- |
| SCHEMA-01 | `schemaVerbosity: "standard"` (default) | List tools                  | Full descriptions, safety tags, examples        | Check tool descriptions are verbose |
| SCHEMA-02 | `schemaVerbosity: "compact"`            | List tools                  | Truncated descriptions (~60 chars), no examples | Check tool descriptions are short   |
| SCHEMA-03 | `schemaVerbosity: "compact"`            | Check destructive tool      | MCP annotations present (destructiveHint)       | Verify annotations in tool schema   |
| SCHEMA-04 | `schemaVerbosity: "invalid"`            | Invalid verbosity value     | Server rejects configuration                    | Validation error at startup         |
| SCHEMA-05 | Token comparison                        | Compare standard vs compact | Compact mode ~30% fewer tokens                  | Measure ListTools response size     |

**Comparison Test:**

```bash
# Test with standard (default)
MAINWP_SCHEMA_VERBOSITY=standard npm run dev
# Measure ListTools response size

# Test with compact
MAINWP_SCHEMA_VERBOSITY=compact npm run dev
# Measure ListTools response size
# Expect ~30% reduction
```

### 1.7 Namespace Tests

| Test ID | Setting                                | Test Scenario       | Expected Behavior                        | Verification Method             |
| ------- | -------------------------------------- | ------------------- | ---------------------------------------- | ------------------------------- |
| NS-01   | `abilityNamespace: "mainwp"` (default) | List tools          | Only mainwp/\* abilities exposed         | All tools have mainwp namespace |
| NS-02   | `abilityNamespace: "custom"`           | Different namespace | Only custom/\* abilities exposed         | No mainwp tools if none match   |
| NS-03   | `abilityNamespace: ""`                 | Empty namespace     | All abilities exposed (security warning) | All namespaces visible          |
| NS-04   | `abilityNamespace: "mainwp/"`          | Trailing slash      | Server normalizes (strips slash)         | Tools exposed correctly         |

### 1.8 Configuration Precedence Tests

| Test ID | Scenario                                                  | Expected Behavior              | Verification Method          |
| ------- | --------------------------------------------------------- | ------------------------------ | ---------------------------- |
| PREC-01 | Env var + settings.json both set                          | Env var value takes precedence | Verify env var value is used |
| PREC-02 | Only settings.json                                        | File value used                | Verify file value is used    |
| PREC-03 | Only env var                                              | Env var value used             | Verify env var value is used |
| PREC-04 | Neither set (default)                                     | Default value used             | Verify default behavior      |
| PREC-05 | `./settings.json` vs `~/.config/mainwp-mcp/settings.json` | CWD file takes precedence      | Create both, verify CWD used |

**Precedence Order (highest to lowest):**

1. Environment variables (`MAINWP_*`)
2. `./settings.json` (current working directory)
3. `~/.config/mainwp-mcp/settings.json` (user config directory)
4. Default values

---

## Part 2: Natural Language Query Test Suite

### 2.1 Common/Expected Queries

#### Site Management Queries

| Query ID | Natural Language Query              | Expected Tool(s)                              | Expected Outcome                                 | Prerequisites                   |
| -------- | ----------------------------------- | --------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| NLQ-01   | "List all my sites"                 | `list_sites_v1`                               | Array of site objects with id, url, name, status | Connected dashboard with sites  |
| NLQ-02   | "Show me site #5"                   | `get_site_v1`                                 | Single site object with detailed info            | Site with ID 5 exists           |
| NLQ-03   | "Get information about example.com" | `get_site_v1`                                 | Site details for domain                          | Site exists with that domain    |
| NLQ-04   | "How many sites do I have?"         | `count_sites_v1`                              | Integer count                                    | None                            |
| NLQ-05   | "Which sites are disconnected?"     | `list_sites_v1` with `status: "disconnected"` | Filtered site list                               | Some disconnected sites         |
| NLQ-06   | "Show connected sites only"         | `list_sites_v1` with `status: "connected"`    | Filtered site list                               | Some connected sites            |
| NLQ-07   | "Sync all my sites"                 | `sync_sites_v1`                               | Sync job status                                  | Sites exist                     |
| NLQ-08   | "Reconnect site 12"                 | `reconnect_site_v1`                           | Connection result                                | Site 12 exists and disconnected |
| NLQ-09   | "Check if site 3 is online"         | `check_site_v1`                               | Connectivity status                              | Site 3 exists                   |

#### Update Management Queries

| Query ID | Natural Language Query                | Expected Tool(s)                            | Expected Outcome                | Prerequisites             |
| -------- | ------------------------------------- | ------------------------------------------- | ------------------------------- | ------------------------- |
| NLQ-10   | "What updates are available?"         | `list_updates_v1`                           | List of pending updates by type | Sites synced              |
| NLQ-11   | "Check for plugin updates"            | `list_updates_v1` with `types: ["plugins"]` | Plugin updates only             | Sites synced              |
| NLQ-12   | "Show WordPress core updates"         | `list_updates_v1` with `types: ["core"]`    | Core updates only               | Sites synced              |
| NLQ-13   | "Update plugins on site 5"            | `update_site_plugins_v1`                    | Update result                   | Site 5 has plugin updates |
| NLQ-14   | "Update everything on all sites"      | `update_all_v1`                             | Batch update result             | Updates available         |
| NLQ-15   | "What updates does example.com need?" | `get_site_updates_v1`                       | Site-specific updates           | Site exists               |
| NLQ-16   | "Ignore updates for akismet"          | `set_ignored_updates_v1`                    | Confirmation                    | Site and plugin exist     |
| NLQ-17   | "Show ignored updates"                | `list_ignored_updates_v1`                   | List of ignored items           | Some updates ignored      |

#### Plugin & Theme Queries

| Query ID | Natural Language Query                          | Expected Tool(s)                              | Expected Outcome               | Prerequisites           |
| -------- | ----------------------------------------------- | --------------------------------------------- | ------------------------------ | ----------------------- |
| NLQ-18   | "What plugins are on site 3?"                   | `get_site_plugins_v1`                         | List of installed plugins      | Site 3 exists           |
| NLQ-19   | "Show active plugins on example.com"            | `get_site_plugins_v1` with `status: "active"` | Active plugins only            | Site exists             |
| NLQ-20   | "List themes on site 7"                         | `get_site_themes_v1`                          | List of installed themes       | Site 7 exists           |
| NLQ-21   | "Activate plugin akismet/akismet.php on site 5" | `activate_site_plugins_v1`                    | Activation result              | Plugin exists, inactive |
| NLQ-22   | "Deactivate jetpack on site 3"                  | `deactivate_site_plugins_v1`                  | Deactivation result            | Jetpack active on site  |
| NLQ-23   | "Find abandoned plugins on site 2"              | `get_abandoned_plugins_v1`                    | List of abandoned plugins      | Site synced             |
| NLQ-24   | "Which plugins have no updates in a year?"      | `get_abandoned_plugins_v1` (multiple sites)   | Abandoned plugins across sites | Sites synced            |
| NLQ-25   | "Switch to theme twentytwentyfour on site 6"    | `activate_site_theme_v1`                      | Theme activation result        | Theme installed         |

#### Client Management Queries

| Query ID | Natural Language Query                       | Expected Tool(s)      | Expected Outcome        | Prerequisites   |
| -------- | -------------------------------------------- | --------------------- | ----------------------- | --------------- |
| NLQ-26   | "List all clients"                           | `list_clients_v1`     | Array of client objects | Clients exist   |
| NLQ-27   | "Show client info for client@example.com"    | `get_client_v1`       | Client details          | Client exists   |
| NLQ-28   | "How many clients do I have?"                | `count_clients_v1`    | Integer count           | None            |
| NLQ-29   | "Create a new client named Acme Corp"        | `add_client_v1`       | New client object       | None            |
| NLQ-30   | "What sites belong to client 5?"             | `get_client_sites_v1` | List of sites           | Client 5 exists |
| NLQ-31   | "Update client 3's email to new@example.com" | `update_client_v1`    | Updated client object   | Client 3 exists |
| NLQ-32   | "Suspend client 7"                           | `suspend_client_v1`   | Suspension confirmation | Client 7 exists |

#### Tag/Group Management Queries

| Query ID | Natural Language Query             | Expected Tool(s)   | Expected Outcome     | Prerequisites              |
| -------- | ---------------------------------- | ------------------ | -------------------- | -------------------------- |
| NLQ-33   | "List all tags"                    | `list_tags_v1`     | Array of tag objects | Tags exist                 |
| NLQ-34   | "Create a tag called 'Production'" | `add_tag_v1`       | New tag object       | None                       |
| NLQ-35   | "Show sites with tag 'staging'"    | `get_tag_sites_v1` | Sites with that tag  | Tag and tagged sites exist |
| NLQ-36   | "Change tag 5 color to blue"       | `update_tag_v1`    | Updated tag          | Tag 5 exists               |

#### Security Queries

| Query ID | Natural Language Query            | Expected Tool(s)                        | Expected Outcome      | Prerequisites       |
| -------- | --------------------------------- | --------------------------------------- | --------------------- | ------------------- |
| NLQ-37   | "Check security status of site 4" | `get_site_security_v1`                  | Security report       | Site 4 exists       |
| NLQ-38   | "Are there any vulnerabilities?"  | `get_site_security_v1` (multiple sites) | Vulnerability summary | Sites synced        |
| NLQ-39   | "Show recent changes on site 2"   | `get_site_changes_v1`                   | Change log            | Logs module enabled |

### 2.2 Edge Cases/Uncommon Queries

#### Ambiguous Requests (Require Clarification)

| Query ID | Natural Language Query | Expected Behavior              | Clarification Needed                |
| -------- | ---------------------- | ------------------------------ | ----------------------------------- |
| EDGE-01  | "Update the site"      | AI should ask which site       | Site ID or domain needed            |
| EDGE-02  | "Delete it"            | AI should ask what to delete   | Object type and ID needed           |
| EDGE-03  | "Show me more"         | AI should ask for context      | Context from previous query needed  |
| EDGE-04  | "Fix the problem"      | AI should ask what problem     | Specific issue needed               |
| EDGE-05  | "Update plugins"       | AI should ask which site(s)    | Site scope needed (all or specific) |
| EDGE-06  | "Check the site"       | AI should ask which check type | Connectivity, security, or updates  |

#### Complex Multi-Step Operations

| Query ID | Natural Language Query                                 | Expected Tool Sequence                                                                  | Notes                   |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------- |
| EDGE-07  | "Find all sites with outdated plugins and update them" | 1. `list_updates_v1` 2. `run_updates_v1`                                                | Multi-tool workflow     |
| EDGE-08  | "Create a backup report for all client sites"          | 1. `list_clients_v1` 2. `get_client_sites_v1` (loop) 3. compile report                  | Requires iteration      |
| EDGE-09  | "Disable all inactive plugins across the network"      | 1. `list_sites_v1` 2. `get_site_plugins_v1` (loop) 3. `delete_site_plugins_v1` (loop)   | Destructive, multi-site |
| EDGE-10  | "Which clients have sites with security issues?"       | 1. `list_clients_v1` 2. `get_client_sites_v1` 3. `get_site_security_v1`                 | Data correlation        |
| EDGE-11  | "Update WordPress core on all production sites"        | 1. `get_tag_sites_v1` (production tag) 2. `run_updates_v1` with `types: ["core"]`       | Requires tag filtering  |
| EDGE-12  | "Compare plugins between site 3 and site 5"            | 1. `get_site_plugins_v1` (site 3) 2. `get_site_plugins_v1` (site 5) 3. comparison logic | Analysis required       |

#### Destructive Operation Edge Cases

| Query ID | Natural Language Query                    | Expected Behavior                                  | Safety Considerations        |
| -------- | ----------------------------------------- | -------------------------------------------------- | ---------------------------- |
| EDGE-13  | "Delete site 10"                          | Requires `confirm: true`, AI should warn           | Destructive operation        |
| EDGE-14  | "Remove all inactive plugins from site 5" | AI should confirm before executing                 | Bulk destructive             |
| EDGE-15  | "Delete client 3 and all their sites"     | AI should refuse (manual cascade) or warn strongly | Very destructive             |
| EDGE-16  | "Delete site 10" (in safe mode)           | Operation blocked, error returned                  | Safe mode prevents execution |

#### Invalid/Error Scenarios

| Query ID | Natural Language Query                    | Expected Behavior              | Error Type                |
| -------- | ----------------------------------------- | ------------------------------ | ------------------------- |
| EDGE-17  | "Show site 999999"                        | API returns not found          | `mainwp_site_not_found`   |
| EDGE-18  | "Update plugins on disconnected site"     | Operation fails, helpful error | Connection error          |
| EDGE-19  | "List sites for nonexistent client"       | API returns not found          | `mainwp_client_not_found` |
| EDGE-20  | "Activate plugin that doesn't exist"      | Plugin not found error         | Invalid plugin slug       |
| EDGE-21  | "Set update to ignored with invalid type" | Validation error               | Invalid parameter         |

#### Queries Combining Multiple Abilities

| Query ID | Natural Language Query                                               | Expected Tools                                                                    | Combination Pattern     |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------- |
| EDGE-22  | "Show me a summary of site 5 including plugins, themes, and updates" | `get_site_v1`, `get_site_plugins_v1`, `get_site_themes_v1`, `get_site_updates_v1` | Parallel data gathering |
| EDGE-23  | "Find the client who owns example.com"                               | `get_site_v1` (to get client_id), `get_client_v1`                                 | Sequential lookup       |
| EDGE-24  | "Which sites have the most pending updates?"                         | `list_sites_v1`, `get_site_updates_v1` (loop), ranking                            | Analysis and sorting    |
| EDGE-25  | "Generate a full network health report"                              | Multiple tools for updates, security, plugins                                     | Comprehensive report    |

#### Pagination and Large Data Sets

| Query ID | Natural Language Query                 | Expected Behavior               | Notes                      |
| -------- | -------------------------------------- | ------------------------------- | -------------------------- |
| EDGE-26  | "List all 500 sites"                   | `list_sites_v1` with pagination | May require multiple calls |
| EDGE-27  | "Show all plugins across all sites"    | Iteration with pagination       | Large data set             |
| EDGE-28  | "Get update history for the past year" | Pagination with date filters    | Time-bounded query         |

#### Rate Limiting Scenarios

| Query ID | Natural Language Query        | Expected Behavior            | Notes                     |
| -------- | ----------------------------- | ---------------------------- | ------------------------- |
| EDGE-29  | "Check all 100 sites at once" | May trigger rate limiting    | Operations queued         |
| EDGE-30  | "Sync all sites immediately"  | Background job for >50 sites | Returns job_id for status |

#### Prompt Workflow Tests

| Query ID | Natural Language Query               | Expected Prompt                 | Notes                |
| -------- | ------------------------------------ | ------------------------------- | -------------------- |
| EDGE-31  | "Run the maintenance check workflow" | Uses `maintenance-check` prompt | Pre-defined workflow |
| EDGE-32  | "Troubleshoot site 5"                | Uses `troubleshoot-site` prompt | Requires site_id     |
| EDGE-33  | "Generate a site report for site 3"  | Uses `site-report` prompt       | Structured output    |
| EDGE-34  | "Run security audit"                 | Uses `security-audit` prompt    | Optional site_ids    |

---

## Test Environment Setup

### Prerequisites

1. **MainWP Dashboard** with Abilities REST API enabled
2. **WordPress Application Password** or REST API token
3. **Test Sites** (at least 2-3 child sites for meaningful tests)
4. **Node.js** 18+ installed

### Environment Configuration

Create a test configuration file:

```bash
# Copy example settings
cp settings.example.json settings.test.json

# Edit with test credentials
# IMPORTANT: Never commit credentials
```

### Running Tests

#### Manual Testing with MCP Inspector

```bash
# Start with test configuration
npm run build
npm run inspect
```

#### Testing Configuration Options

```bash
# Test specific configuration
MAINWP_SAFE_MODE=true npm run dev

# Test tool filtering
MAINWP_ALLOWED_TOOLS="list_sites_v1,get_site_v1" npm run dev

# Test compact schema
MAINWP_SCHEMA_VERBOSITY=compact npm run dev
```

### Test Data Requirements

| Test Category  | Required Data                         |
| -------------- | ------------------------------------- |
| Site tests     | At least 1 connected site             |
| Client tests   | At least 1 client with assigned sites |
| Tag tests      | At least 1 tag with tagged sites      |
| Update tests   | Sites with pending updates            |
| Security tests | Security module data available        |
| Plugin tests   | Sites with multiple plugins           |

### Verification Checklist

#### Configuration Tests

- [ ] AUTH-01 through AUTH-10 completed
- [ ] URL-01 through URL-06 completed
- [ ] SSL-01 through SSL-04 completed
- [ ] HTTP-01 through HTTP-03 completed
- [ ] FILTER-01 through FILTER-15 completed
- [ ] SAFE-01 through SAFE-06 completed
- [ ] LIMIT-01 through LIMIT-14 completed
- [ ] SCHEMA-01 through SCHEMA-05 completed
- [ ] NS-01 through NS-04 completed
- [ ] PREC-01 through PREC-05 completed

#### Natural Language Query Tests

- [ ] NLQ-01 through NLQ-39 completed
- [ ] EDGE-01 through EDGE-34 completed

---

## Appendix: Tool Reference

### Read-Only Tools

These tools can be tested without risk:

- `list_sites_v1`
- `get_site_v1`
- `count_sites_v1`
- `get_sites_basic_v1`
- `list_updates_v1`
- `get_site_updates_v1`
- `list_ignored_updates_v1`
- `get_site_plugins_v1`
- `get_site_themes_v1`
- `get_abandoned_plugins_v1`
- `get_abandoned_themes_v1`
- `list_clients_v1`
- `get_client_v1`
- `count_clients_v1`
- `get_client_sites_v1`
- `count_client_sites_v1`
- `list_tags_v1`
- `get_tag_v1`
- `get_tag_sites_v1`
- `get_tag_clients_v1`
- `get_site_security_v1`
- `get_site_changes_v1`
- `get_site_costs_v1`
- `get_client_costs_v1`
- `get_batch_job_status_v1`

### Destructive Tools (Require Caution)

These tools modify or delete data:

- `delete_site_v1` - Removes site from MainWP
- `delete_client_v1` - Removes client record
- `delete_tag_v1` - Removes tag
- `delete_site_plugins_v1` - Uninstalls plugins
- `delete_site_themes_v1` - Uninstalls themes

### Tools with dry_run Support

Test safely with `dry_run: true`:

- `delete_site_v1`
- `delete_client_v1`
- `delete_tag_v1`
- `delete_site_plugins_v1`
- `delete_site_themes_v1`
