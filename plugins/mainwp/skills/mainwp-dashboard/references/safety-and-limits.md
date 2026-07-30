# Safety and limits reference

Detail behind the safety and limit sections of SKILL.md. Environment variable
names match the README configuration table and the configuration reference on
docs.mainwp.com/mcp-server; keep the three in sync when any option changes.

## Policy precedence

`decidePolicy()` resolves one decision per call, in this
order:

1. `blocked-by-policy`: allow/block lists exclude the tool. Evaluated before the
   ability is resolved, so a blocked tool cannot be distinguished from a
   nonexistent one.
2. `safe-mode-blocked`: destructive tool while safe mode is on. Outranks
   confirmation, so a valid token cannot bypass it.
3. `needs-confirmation`: destructive tool while confirmation is required.
4. `allow`.

Listing surfaces (tools list, resources, completions, tool help) call the gate
without destructiveness and only ever see `allow` or `blocked-by-policy`. That
is why destructive tools stay visible in safe mode and fail at execution
instead.

## Tool filtering

| Variable               | Default | Effect                                                                  |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| `MAINWP_ALLOWED_TOOLS` | unset   | When set, only these tool names are exposed. Everything else is denied. |
| `MAINWP_BLOCKED_TOOLS` | unset   | These tool names are denied even if the allowlist includes them.        |

Both are enforced at execution and at every resource, completion, and help path
that resolves an ability, not only at list time.

Filtering is one of several silent reasons a capability is absent. The others:

- `MAINWP_ABILITY_NAMESPACES` (default `mainwp`) is an ordered allowlist.
  Abilities outside it are never fetched. The first namespace is primary and its
  tools appear unprefixed; other namespaces keep a `namespace__` prefix.
- The Dashboard genuinely does not provide the ability (MainWP version, or an
  extension that is not installed or not active).
- The catalog fetch hit the pagination cap (see below).
- The catalog fetch failed and `mainwp://status` reports `connected: false`.

Distinguish those before telling a user that MainWP cannot do something. The
honest statement is that the capability is not exposed in this session, plus the
settings worth checking.

Two resources are not policy-filtered and can therefore describe capability
groups whose tools are filtered out: `mainwp://status` `abilitiesCount` and `mainwp://categories`.
`mainwp://abilities` and `mainwp://help` are filtered.

## Safe mode

| Variable                           | Default | Effect                                               |
| ---------------------------------- | ------- | ---------------------------------------------------- |
| `MAINWP_SAFE_MODE`                 | `false` | Destructive tools stay listed and fail at execution. |
| `MAINWP_REQUIRE_USER_CONFIRMATION` | `true`  | Two-phase confirmation for destructive tools.        |

In safe mode the server also strips an incoming `confirm` argument defensively
before the block, so nothing reaches the Dashboard.

When `MAINWP_REQUIRE_USER_CONFIRMATION=false`, the server stops gating
destructive calls: no preview, no token, no second call. The user turned the
safety net off; that does not remove the obligation to describe a destructive
network-wide operation and get agreement before running it.

## Confirmation state

- Preview expiry is 5 minutes.
- At most 100 previews are held; over that, the oldest are evicted and their
  tokens are dropped. A token can therefore
  become unusable before its 5 minutes are up during heavy use.
- The token key is the Dashboard identity hash, the tool name, and the
  canonicalized non-confirmation arguments. Nested
  values are canonicalized recursively, so a change anywhere in the argument
  tree, at any depth, invalidates the token.
- Token checks that all return `PREVIEW_REQUIRED`: missing token, unknown or
  already-used token, token issued for another tool or another Dashboard
  identity, arguments that no longer match, and no stored preview.
- A failed check deletes the token. Retrying the same confirmed call will not
  succeed; go back to the preview step.
- `confirm` without a declared `dry_run` still issues a token but returns
  `preview: null` and `next_action: confirm_without_preview`. Passing `dry_run` to an ability that
  does not declare it is rejected as `INVALID_PARAMETER` before any upstream
  call, because an upstream handler that ignores unknown fields would execute
  the operation for real.
- Passing `user_confirmed` and `dry_run` together is rejected as
  `CONFLICTING_PARAMETERS`.

## Size and rate limits

| Variable                   | Default            | Effect                                        |
| -------------------------- | ------------------ | --------------------------------------------- |
| `MAINWP_MAX_RESPONSE_SIZE` | `10485760` (10 MB) | Cap on a single response body.                |
| `MAINWP_MAX_SESSION_DATA`  | `52428800` (50 MB) | Cap on cumulative response bytes per session. |
| `MAINWP_REQUEST_TIMEOUT`   | `30000` ms         | Deadline per request and total retry budget.  |
| `MAINWP_RATE_LIMIT`        | `60`               | Requests per minute, `0` disables.            |

The per-response cap is enforced by content-length and again while streaming the
body. It reaches the client as
`INVALID_PARAMS` (-32602) with an "exceeds ... bytes" message, so it is easy to
misread as a bad argument. It means the payload was too big, not that the call
was malformed.

The cumulative cap is checked before a response is added to the counter and
raises `RESOURCE_EXHAUSTED` (-32006). The counter is
process-global and only resets on a new server session; the user restarting the
MCP client is what clears it. Small fixed-size local errors such as the safe-mode
block are deliberately not counted.

The rate limiter is acquired before each ability execution, which is why a large fan-out of per-site calls gets
slower rather than failing. Prefer one scoped call over many small ones.

### Recovery patterns for a cap

In rough order of preference:

1. Re-scope: one site, or a named subset, instead of the whole network.
2. Use the ability's own filters (status, type, date range) to cut the payload.
3. Use the ability's own paging parameters and process a page at a time,
   summarizing as you go instead of accumulating raw payloads.
4. Ask for a narrower field set if the ability supports one.
5. Only then tell the user a new session is needed, and say what was already
   collected so the work is not repeated.

An identical retry after a cap never helps: it produces the same bytes, and on
the session cap it burns more budget.

## Pagination and partial reads

Catalog and category fetches page sequentially at 100 per page and stop at 50
pages. Hitting the cap logs a
warning through the MCP logger and returns what was collected. The tool result
itself carries no marker, and the user may never see the log line.

Consequences to carry into any answer:

- A capped catalog can hide tools that the Dashboard really does offer.
- Result sets from individual abilities are paged by the Dashboard's own
  parameters, not by this cap. Read the tool's schema for how it pages.
- Never derive "we have N sites" or any total from a list that was paged,
  filtered, or capped. Use an ability that reports totals, and say which of the
  two you used.

## Retry

| Variable                  | Default | Effect                              |
| ------------------------- | ------- | ----------------------------------- |
| `MAINWP_RETRY_ENABLED`    | `true`  | Enables automatic retry.            |
| `MAINWP_MAX_RETRIES`      | `2`     | Total attempts including the first. |
| `MAINWP_RETRY_BASE_DELAY` | `1000`  | Base backoff in ms.                 |
| `MAINWP_RETRY_MAX_DELAY`  | `2000`  | Backoff ceiling in ms.              |

Retry applies only when the ability is annotated `readonly`. Retryable conditions are 5xx, 429, and the network
codes ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND. 4xx other than 429 and
cancellations are never retried. The whole attempt chain
shares the request timeout budget, so retries stop early rather than exceeding
it.

Everything else, including every write and every destructive call, runs once. If
it fails or times out, its effect on the Dashboard is unknown: read state back
before deciding what happened, and get fresh user approval and a fresh token
before running it again.
