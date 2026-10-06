# Changelog

All notable changes to mainwp-mcp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.4.0] - 2026-10-06

### Added

Agency, client and site knowledge. On MainWP Dashboard 6.3 and later the server exposes the Dashboard's knowledge abilities (agency, client and site summaries, and listing, reading, creating, updating and deleting knowledge records) like any other ability. Knowledge is coming in MainWP 6.3 but available now in the [Early Release program](https://mainwp.com/add-on/early-access/). The troubleshooting, maintenance and update workflows load a site's knowledge before planning, and the `mainwp-dashboard` skill explains how to use it: verified skill records and context, written or reviewed by a Dashboard user, guide the work; unverified records are information only, and one that contains instructions addressed to an AI agent is named to the user in a separate note instead of being followed; memories are history; skill records are listed with a description, and a record is opened before its content is described or followed. When verified records conflict, the more specific level wins, and a required record wins over records at more specific levels: a required agency record over client and site records, a required client record over site records. Only a person using the Dashboard can mark a record required or change a required one; the abilities refuse it. The update workflow also loads the ignored-updates list, names the ignored items in scope, and holds back or asks about an item that verified context or a verified skill argues against; an unverified record or a memory is raised with the user instead.

The server sends instructions to the client at initialize. They say that verified knowledge skills and context guide the work, that unverified records are information only and an unverified record with instructions addressed to an AI agent is named to the user instead of followed, that memories are history, that skills are listed with a description, that no record authorizes a change to a site, and that a record is opened before its content is described or followed. They also ask for the user's approval before any call that changes sites, say that a tool's preview is the plan to show and that previews shown together can be approved in one reply, note that Dashboards before 6.3 do not gate updates, and forbid removing an update from the ignore list to force it through unless the user asks. Clients decide how to use server instructions.

Update previews carry a readable summary. When a destructive update tool's preview is a valid Dashboard 6.3 update
plan, the confirmation response adds `plan_summary`: per-site version changes, held-back items with the reason, major
version jumps, the number of sites getting a core update, a line when the site list is partial, and, when the preview
carries no preview token, a note that a newer version synced before confirmation is the one applied. The raw preview
is still included. A preview that does not validate gets no summary. Dashboard 6.3 update previews are coming in
MainWP 6.3 but available now in the [Early Release program](https://mainwp.com/add-on/early-access/).

Abilities that take a `preview_token` from their own dry run can now be confirmed. When an ability supports `dry_run`
and declares `preview_token` as a nullable string, the preview sends `null` for it (or leaves it out when it is
optional) and keeps the token the preview returns. For the six MainWP update abilities (`run-updates-v1`,
`update-all-v1` and `update-site-{core,plugins,themes,translations}-v1`) when `mainwp` is the primary namespace, the
confirmed call always sends the token captured from the preview, and a different token from the caller is refused
with `PREVIEW_REQUIRED` before anything is sent. For every other ability, a token string from the caller is sent
unchanged and the stored token is used when the caller sent `null` or nothing. Abilities that declare
`preview_token` as a plain string, or have no `dry_run`, send the same payloads as before. Dashboard 6.3 returns no
preview token.

An ability can now use a required `confirm_*` property as its confirmation parameter when its schema pins the value to
`true` (`const: true` or `enum: [true]`). These tools confirm with a token and no preview, and an explicit `dry_run` is
refused for them. A `confirm_*` property that also accepts `false` is treated as an ordinary input and passed through.
Tool descriptions, help, and confirmation responses name the parameter the tool uses.

`mainwp://status`, `mainwp_get_setup_status` and `mainwp_configure` report whether the ability catalog is complete, as
`catalog: { truncated, pagesFetched, pageLimit }`. `truncated` is true when pagination stopped at the 50-page limit,
when an `X-WP-TotalPages` header is malformed, when a full page arrives without one, and when the fetch stops short of
the largest page count any page advertised. A truncated catalog stays connected and its tools stay usable; a complete
refresh or a cache clear resets it.

### Changed

On MainWP Dashboard 6.3 and later, the update tools and `unignore_site_updates_v1` are destructive, so safe mode
blocks them and, with confirmation enabled (the default), they go through the preview and confirmation flow. Update
confirmation is coming in MainWP 6.3 but available now in the
[Early Release program](https://mainwp.com/add-on/early-access/). With `MAINWP_REQUIRE_USER_CONFIRMATION=false` the caller must send `confirm: true` itself; the Dashboard rejects a call
with neither `confirm` nor `dry_run`, and the error carries `mainwp_confirmation_required` as
`error.data.upstream_code`. The update workflow prompt, the `/mainwp:update-workflow` command and the skill use the
Dashboard's preview as the plan: one update call per group of sites with the same items, all previews shown together,
one approval. On earlier Dashboards the update tools run without a preview, as before.

Errors from the Dashboard with a 4xx status keep the WordPress error code. When the body is a well-formed WordPress
error, the code is returned as `error.data.upstream_code` and the error maps to `SERVER_ERROR` (-32000) unless an
existing mapping applies (401, 403, 404, 429 and `*_not_found` are unchanged). A replacement ability the Dashboard
names in `data.replacement`, such as `unignore_site_updates_v1` for the retired unignore path, is returned as
`error.data.replacement` when that tool exists and is allowed by `MAINWP_ALLOWED_TOOLS` and `MAINWP_BLOCKED_TOOLS`.
Before, these errors surfaced as an internal error or were classified by words in their message. Malformed bodies and
5xx errors are unchanged.

Standard tool descriptions drop the Dashboard sentence "Call dry_run first and show the plan to the user." because the
server adds its own preview reminder. Other Dashboard instructions and compact descriptions are unchanged.

Rejected credentials are now reported at startup instead of producing a tool list that cannot work. When the Dashboard
rejects the configured user or Application Password, the server enters a `credentials_rejected` state. The startup
log, `mainwp_get_setup_status`, and 401 errors during a call name the rejected user, where each of `MAINWP_URL`,
`MAINWP_USER`, and `MAINWP_APP_PASSWORD` came from, and what WordPress expects: the login name or email address rather
than the display name, and an Application Password rather than the account's login password. Network, TLS, timeout,
and 5xx failures keep the existing degraded retry path. The Application Password is never logged or returned.

The startup log names the source of each connection setting instead of reporting "mixed". When an environment variable
overrides a different value in `settings.json`, the startup log says so for that setting, and so does the setup status
when the Dashboard rejects the credentials, so an edit to the file that had no effect is explained.

String inputs now honor the `maxLength` an ability's input schema declares, up to a ceiling of 64 MiB. They were
capped at 10,000 characters regardless of the schema, which blocked abilities that take base64 file uploads.
Properties without a usable `maxLength` keep the 10,000-character default, and read-only tools are still bounded by
the request URL limit. The stdio transport accepts messages large enough to carry the largest allowed string of ASCII
text, such as base64.

On GET and DELETE calls, boolean inputs are sent as `1` and `0` instead of `true` and `false` when the ability's
schema plainly declares the position as a boolean. WordPress 6.9 and 7.0 pass query values through as raw strings, and
PHP code that tests a flag by truthiness reads the string `"false"` as true. Undeclared keys, positions under `anyOf`,
`oneOf` or `allOf`, items of arrays that declare `uniqueItems`, and type lists that name `integer`, `number`, `string` or `array` before `boolean` keep
`true`/`false`.

Abilities with a required input that may be `null` now receive their input as JSON, so a `null` stays `null`: GET
calls send `input_json`, DELETE calls send a JSON body. This applies to `mainwp/` abilities whose input schema is an
object without a default and requires a nullable key, and needs MainWP Dashboard 6.2 or later; on an older Dashboard
the error says to update. A string sent for a top-level property whose declared types exclude `string` is converted to
the declared type when it is in canonical form and refused before the call when it is not.

### Fixed

The `mainwp://site/{id}` resource works again. It sent `site_id` to an ability that requires `site_id_or_domain`, so
the Dashboard rejected every read.

A confirmed write whose result exceeds the session data limit now says that the upstream request succeeded and the
result was omitted (`execution_attempted`, `upstream_response_received`, `result_omitted`), and asks the caller to
verify the operation's state before retrying. The error code stays `RESOURCE_EXHAUSTED`. It previously looked like
nothing had run.

A confirmed execution no longer forwards a `dry_run` argument from the caller, which could turn the approved call into
another preview.

`*_id` inputs whose schema declares a string type now accept string ids such as UUIDs. They are checked as non-empty
strings of at most 255 characters with no control characters. Integer-typed and untyped ids keep the positive-integer
rule.

Calls with no arguments now send an input parameter when the ability declares an input schema: an empty `input`
parameter on GET and DELETE when the schema has no default, and an empty `input` object on POST. Abilities that take
their input as JSON send `input_json={}` on GET and a `{"input":{}}` body on DELETE instead. Abilities whose
schema requires an input object rejected these calls before. An empty POST call to an ability without an input schema
now sends `{}` instead of `{"input":{}}`.

Abilities that require an explicit `confirm` or `dry_run` value now receive one. For an ability with a `confirm`
parameter and a declared `dry_run`, previews and explicit dry runs send `dry_run: true`, plus `confirm: false` when
`confirm` is required and accepts `false`. Confirmed calls send `confirm: true`, plus `dry_run: false` when `dry_run`
is required and accepts `false`. Abilities that do not require these keys get the same payloads as before.

`user_confirmed` and `confirmation_token` are no longer forwarded to the Dashboard on previews, explicit dry runs, or
calls made with confirmation disabled. Abilities that reject undeclared input keys failed these calls.

Input validation rejects non-finite numbers, so a preview and the call it confirms always carry the same values.
Arrays nested inside arrays are checked against the same limits as other elements.

A preview whose response exceeds the session data limit no longer leaves a pending confirmation behind, and no longer
replaces the token from an earlier preview of the same call. The pending-preview cap now holds at 100 entries and
evicts the oldest preview first.

### Security

Inputs an ability's schema marks `writeOnly` are redacted from results, confirmation previews, errors, and logs.
Values shorter than four characters and booleans are left as they are, since matching them wherever they appear would
mangle unrelated counts and keys. When a call carried `writeOnly` input and the request fails, the error reports the
HTTP status and a short upstream error code instead of the upstream message. Redaction applies once the Dashboard
marks the relevant inputs `writeOnly`.

Transport errors no longer include the request's query string, which carries GET and DELETE input. A successful
response that is not valid JSON fails with a fixed message instead of quoting the body.

Pending previews store a digest of the call's arguments instead of the arguments themselves.

Refreshed the dependency lockfile within declared ranges to clear published advisories in runtime dependencies:
`undici` 7.29.1, `fast-uri` 3.1.8, `hono` 4.13.11, `ip-address` 10.7.2, `qs` 6.16.0, `proxy-addr` 2.0.8, `zod` 4.6.5,
`jose` 6.2.12, and `ajv` 8.20.0. `npm audit` reports 0 vulnerabilities. `package.json` is unchanged.

## [1.3.0] - 2026-08-07

### Added

First-run setup. A server started with no Dashboard URL or credentials now
launches in setup mode: the MainWP tools stay hidden and two setup tools take
their place. `mainwp_get_setup_status` reports what is missing and returns
setup instructions for the assistant to relay. `mainwp_configure` takes a
Dashboard URL, username, and Application Password, verifies them against the
Dashboard, and saves them to `~/.config/mainwp-mcp/settings.json` with
owner-only permissions (0600, in a 0700 directory). The password is scrubbed
from the server's logs and from every response. Once configuration succeeds,
the full tool list appears in the same session for clients that honor MCP
list-changed notifications; other clients need a reconnect or restart.

`mainwp_configure` refuses rather than saving something that would be ignored
or unsafe. It will not run when a connection environment variable is set
(environment variables outrank the file it writes), when a `settings.json` in
the server's working directory would shadow the saved file, or when the server
already has credentials loaded. The last refusal is deliberate: chat-based
setup can connect an unconfigured server but can never repoint a working one,
so instructions injected into the conversation cannot swap your Dashboard for
someone else's. To change existing credentials, edit the config file or the
client's `env` block and restart the client. Setup writes only the three
connection fields, never security settings, and blocking `mainwp_configure`
through `MAINWP_BLOCKED_TOOLS` removes chat-based setup entirely.

A server whose credentials are present but whose Dashboard was unreachable at
startup now stays up in a degraded state instead of exiting. Calling
`mainwp_get_setup_status` retries the connection with the credentials already
loaded, so a Dashboard that comes back online is picked up without a client
restart.

### Changed

An unconfigured start is no longer a failed launch. Since 1.1.0 the server
printed setup guidance to stderr and exited 1; it now stays running and
serves the setup tools over MCP. **This is a behavior change** for anything
that read the exit code as the missing-configuration signal. Configuration
that is present but invalid keeps the existing fatal-error behavior.

## [1.2.0] - 2026-08-03

### Added

A Claude Code plugin, installed with `/plugin marketplace add mainwp/mainwp-mcp`
followed by `/plugin install mainwp@mainwp-mcp`. It registers the MCP server, a
`mainwp-dashboard` skill that teaches an agent how to work against a MainWP
Dashboard, and ten `/mainwp:*` workflow commands. The bundled server config
carries no credentials; the server inherits them from the environment Claude
Code runs it in, so an unconfigured setup still gets the server's setup
guidance. The skill's canonical copy lives at
`.agents/skills/mainwp-dashboard`, which Codex CLI and other agent-skills
clients read directly; `npm run sync-skill` mirrors it into the plugin and CI
byte-compares the two. Conventions are in `docs/plugin.md`. This adds no server
behavior and does not change the published package.

### Changed

Confirmation instructions now state that approval must come from the user. The
destructive-operation flow told the agent to proceed "if they approve" without
ruling out the agent counting the original request as that approval, so an
agent could preview and confirm in one turn with the user never seeing the
preview. Tool descriptions, both confirmation responses (preview and
no-preview), and the compact FLOW strings now all say a bare request for the
operation is not approval: the agent stops and waits for an approving reply
sent after the user sees the preview or operation description, unless the user
explicitly authorized proceeding through confirmation up front. The compact
strings carry the same gate so compact mode cannot reopen the loophole.

### Security

A `settings.json` planted in the server's working directory can no longer turn
off the destructive-operation confirmation gate or TLS verification. The
working-directory file is untrusted for security-loosening values:
`requireUserConfirmation: false`, `skipSslVerify: true`, and `allowHttp: true`
are dropped there with a stderr warning. Environment variables and
`~/.config/mainwp-mcp/settings.json` keep working as before.

Stderr log lines now strip terminal control characters, so remote error text
can no longer inject escape sequences into the operator's terminal. Multi-line
startup error messages render on a single line as a side effect.

Error sanitization now also redacts HTTP Basic credentials, `Authorization`
headers, and spaced WordPress application passwords, and caps the error text it
processes, so oversized or credential-bearing remote errors cannot leak
secrets or stall the server. Redaction covers serialized forms (JSON at any
nesting depth, PHP dumps, URL-encoded bodies), and the server's own
credentials are additionally scrubbed by value wherever they appear in an
error, in any encoding that preserves them.

HTTP redirects from the Dashboard are no longer followed. A 3xx response now
fails the request instead of silently re-sending it (with credentials) to
whatever host the redirect names. Point `MAINWP_URL` at the final URL if your
Dashboard sits behind a redirect.

## [1.1.0] - 2026-07-21

### Added

`--help` and `--version` CLI flags. `--help` prints usage, the required
environment variables, and a ready-to-paste `claude mcp add` command;
`--version` prints the server version. Both write to stdout, exit 0, and
work with nothing configured.

### Changed

Starting the server with no configuration now prints setup guidance
instead of a fatal error line. A bare `npx -y @mainwp/mcp` used to open
with `[ERROR] Fatal error: MAINWP_URL is required`, which reads like a
crash to someone who has not configured anything yet. The missing-URL and
missing-credentials cases now say what is missing, list the three
environment variables to set, and link the setup guide. The exit code
stays 1 so MCP clients still register the launch as failed, and the
process exits by letting the event loop drain so the guidance is not
truncated when stderr is piped. Configuration that is present but invalid
keeps the existing fatal-error behavior.

## [1.0.0] - 2026-07-20

### Security

Destructive abilities that declare no `confirm` parameter now fail closed. The confirmation flow used to return a skip decision for them, so a destructive-classified ability without a declared `confirm` parameter executed with no preview, token, or user approval even with `requireUserConfirmation` enabled. Such calls now return a `CONFIRMATION_UNSUPPORTED` error naming the missing confirm support. **This is a behavior change** for third-party or misannotated destructive abilities that never declared `confirm`; the built-in deletion tools all declare it and are unaffected. The former `INVALID_PARAMETER: user_confirmed not supported` response is folded into the new error.

Dashboard-provided ability `instructions` are now sanitized before entering tool descriptions: control and format characters (newlines, ANSI, bidi marks) collapse to spaces and the text is capped at 300 characters. Remote metadata used to be forwarded verbatim and unbounded, giving a compromised Dashboard or extension a context-flooding channel into every tool description.

Refreshed the dependency lockfile within declared ranges: `undici` to 7.28.0 and the MCP SDK's transitive HTTP-transport dependencies to patched versions, clearing all `npm audit` advisories (previously 4 high, 4 moderate on the production tree).

All remote ability and category content is now normalized once at the fetch boundary: labels, categories, descriptions, and `instructions` get non-string values replaced, control/format characters stripped, and hard length caps (200/100/2000/300 chars) before reaching tool descriptions, mainwp:// resources, or help output. Input and output schemas are deep-bounded by a generic, field-aware walker covering every keyword at every depth (`properties`, `items`, `oneOf`, `$defs`, `additionalProperties`, anything else): presentation fields (`description`, `title`, `$comment`) are sanitized and capped at 500 chars, while semantic strings (enum/const values, `pattern`, `$ref`, defaults) are never mutated — an ability whose schema carries a semantic string over 2000 chars, an oversized key, or more than 2000 nodes is dropped from the catalog with a warning instead of being silently altered. Previously only the `instructions` field was capped, only on the tools/list path — the help and abilities resources returned remote text verbatim, and a non-string `instructions` value threw during tool conversion, which the ListTools handler turned into an empty tool catalog for the whole server.

Tool discovery now uses the same fail-closed destructive classifier as the execution policy. An ability with missing or malformed `destructive` annotations used to be advertised as a plain write operation with no destructive hint (and, when it declared `confirm`, without the `user_confirmed`/`confirmation_token` parameters the executor requires) while execution treated it as destructive. Discovery now tags such tools DESTRUCTIVE, emits normalized MCP annotation hints (`destructiveHint` follows the classifier; positive hints require literal `true`; annotations are always present), and injects the confirmation parameters. **This is a behavior change** for unannotated abilities' advertised metadata; correctly annotated abilities are unaffected.

Declaring a `confirm` or `dry_run` parameter now requires a subschema that can accept the boolean `true` the server sends for it. A destructive ability whose `confirm` subschema provably rejects `true` (a `false` boolean schema, `type: "string"`, an enum without `true`) has no working confirmation channel and now takes the same fail-closed `CONFIRMATION_UNSUPPORTED` path as one that never declared `confirm`, at discovery (no confirmation-parameter injection) and at execution alike; an unusable `dry_run` declaration is rejected like an undeclared one instead of being forwarded upstream. Permissive subschemas (`{}`, description-only, no `type`) still count as declared.

The `safeMode` description in the shipped `settings.schema.json` no longer calls safe mode suitable for "read-only access"; it now states that non-destructive writes remain available and points to `allowedTools` for read-only setups.

`prepublishOnly` additionally runs the production dependency audit (high severity and above) and the packed-package fixture acceptance suite.

### Added

The server warns at startup when a bearer token (`MAINWP_TOKEN`) is configured without a complete username and application password pair. The WordPress Abilities API rejects bearer tokens, so a token-only setup fails with 401s at request time; the warning surfaces the problem at startup instead.

Ability namespaces are now configurable. The server used to surface only `mainwp/` abilities; the new `abilityNamespaces` setting (or the `MAINWP_ABILITY_NAMESPACES` environment variable) lets you expose abilities that third-party MainWP extensions register through the WordPress Abilities API. The first namespace in the list is the primary one and its tools keep their plain names, so `mainwp/list-sites-v1` still appears as `list_sites_v1`. Abilities from other namespaces carry a prefix: `acme/do-thing-v1` becomes `acme__do_thing_v1`. Hyphenated namespaces such as `acme-corp` work end to end, including execution. Built-in resources and prompt completions depend on `mainwp/get-site-v1` and `mainwp/list-sites-v1`, so keep `mainwp` in the list when adding others.

The server now warns at startup when `mainwp` is missing from `abilityNamespaces`, and after fetching abilities when the namespace filter matches none of them. A misconfigured allowlist used to boot a server that advertised zero tools with nothing in the logs explaining why. An empty upstream gets its own message so a dead API is distinguishable from a filter mismatch.

### Changed

The `mainwp://abilities` and `mainwp://help` resources now respect `allowedTools`/`blockedTools`: blocked tools no longer appear in their payloads, and the per-tool help resource (`mainwp://help/tool/{name}`) returns a permission error for blocked tools instead of documenting them. **This is a behavior change** for clients that read the full catalog from these resources under a restrictive policy; they now see the same filtered set as `tools/list`. The `mainwp://categories` list and `mainwp://status` ability count remain unfiltered. Internally, every policy check now routes through a single pure decision function (`src/policy.ts`).

Destructive classification is now strictly fail-closed: only a literal `destructive: false` annotation counts as non-destructive, so malformed values (`0`, `""`, `"yes"`) classify as destructive instead of following JavaScript truthiness. The `mainwp://site/{id}` resource and site-ID completions, which execute abilities directly, now apply this classification before executing: with safe mode or confirmation gating active, a destructive-classified (or unannotated) underlying ability denies the resource and returns empty completions. **This is a behavior change** for Dashboards that ship no annotations on `mainwp/get-site-v1` or `mainwp/list-sites-v1` — the same default-deny stance tool calls already had.

Destructive tool calls now go through strict confirmation gating. A bare call to a confirm-capable tool, with no preview and no confirmation token, returns a `PREVIEW_REQUIRED` error instead of proceeding with a logged warning. **This is breaking for clients that relied on the old skip**: run the preview step first, then confirm. Abilities that require confirmation but expose no `dry_run` parameter no longer get a fabricated dry-run call; they return a token-issuing `CONFIRMATION_REQUIRED` response with `preview: null`, and execution proceeds once the client confirms with that token.

Nested objects and arrays of objects in the input of GET/DELETE abilities are now rejected with an invalid-params error. They used to be serialized into the query string as `[object Object]`, which the Dashboard silently misread.

Malformed boolean configuration now fails startup instead of logging a warning and falling back to the default. Accepted values are `true/1/yes/on` and `false/0/no/off`; anything else stops the server with an error naming the variable.

### Removed

The package no longer installs a global command named `mcp`. That name is too generic for a public package and collides with other MCP tooling. The command is `mainwp-mcp`, and `npx @mainwp/mcp` keeps working since the package now has a single bin entry.

The `toolNameToAbilityName` export is gone. Tool names stopped being uniquely decodable once multiple namespaces came into play, so reverse lookup now goes through an index built when abilities are fetched. Anything importing that function from this package needs to switch to `getAbilityByToolName`.

### Fixed

The installed `mainwp-mcp` command now starts when invoked through npm's bin symlink. The entry-point check compared the module URL against `process.argv[1]` without resolving symlinks, so the CLI exited silently with status 0 when run via `npx` or a `node_modules/.bin` link. The check now resolves the invoked path first.

Confirmation previews and tokens are now scoped to the dashboard and principal that issued them. The preview state is module-level, so with multiple `createServer(config)` instances in one process a token issued against one dashboard could confirm the same tool and arguments against another. Preview keys now carry a config identity hash, matching the isolation the abilities cache already enforces.

Confirmation preview keys now serialize nested arguments faithfully. The previous serialization dropped nested values (including keys named `__proto__` and objects inside arrays), so a confirmation call could swap nested argument values past the token binding. Arguments are canonicalized recursively onto null-prototype objects before keying.

Tool schemas for destructive tools now declare the `confirmation_token` parameter, and the advertised confirmation flow names the token step. Clients that validate arguments against the schema could not send the token the server requires, and the described flow still matched the old tokenless behavior. Confirm-only abilities without `dry_run` no longer promise a preview in their description.

Passing `confirm: true` together with a declared `dry_run: true` no longer forwards `confirm` upstream. The dry-run call now goes out with `confirm` stripped, matching the preview path, so upstream handlers never see the ambiguous combination.

A malformed ability entry in the Dashboard response (a null entry or a non-string name) is now skipped with a warning instead of throwing and failing the whole catalog refresh.

A malformed property value inside an ability's input schema (a string or array where an object belongs) is now coerced to an empty object instead of crashing the whole tools/list response during description backfill. Property maps are also built with null prototypes, so a hostile parameter named `__proto__` survives as a real schema property instead of polluting the map and skewing the confirm/dry_run detection.

The abilities cache signature now includes `skipSslVerify` and `maxResponseSize`, so a strictly configured server instance never reuses data fetched by an instance with TLS verification disabled or a larger response cap.

Confirmed execution of a destructive tool now always requires the `confirmation_token` issued by the preview. The server used to fall back to matching the pending preview by tool name and arguments, so `user_confirmed: true` with the same arguments executed without the token, letting a caller confirm a preview it never read. A tokenless confirmation now returns `PREVIEW_REQUIRED` and the issued token stays valid.

A "site not found" error from a live Dashboard now surfaces with the resource-not-found error code. The Dashboard reports a nonexistent site as HTTP 403 with the `mainwp_site_not_found` error code, and the classifier trusted the status before the structured code, so clients received a permission-denied error and recovered down the wrong path. Structured not-found codes now classify first.

Passing `dry_run: true` to an ability that does not declare a `dry_run` parameter now returns an invalid-parameter error instead of skipping the confirmation flow. The server used to forward the parameter upstream, and a handler that ignores unknown input would have run the destructive operation without confirmation.

Request timeouts and client cancellations are no longer conflated. The request timeout stays armed while the response body is read, and timing out surfaces as a retryable `ETIMEDOUT`; an abort from the caller surfaces as a cancellation rather than a timeout.

Spurious `tool_list_changed` notifications after every cache refresh are gone. Tool schema enrichment was mutating the cached abilities in place, so each refresh compared a different fingerprint and notified clients even when nothing had changed. Enrichment now works on a copy.

Error classification prefers the structured HTTP status from the API response (401, 403, 404, 429, 5xx) over parsing the error message text, so error codes stay correct when upstream wording changes.

A failed ability refresh can no longer leave the tool index half built. The cache swaps in atomically, and if the fetch hits duplicate tool names the previous index keeps serving while the error is reported. Abilities with malformed names, an extra slash for example, are dropped at fetch time with a logged warning rather than surfacing as invalid MCP tool names.

Failed tool calls now set `isError: true` on the MCP result. The error JSON was already in the response content but the flag was missing, so clients that branch on it treated failures as successes. Unknown tools, input validation failures, ability execution failures, cancellations, safe mode blocks, and confirmation rejections all carry the flag; confirmation previews and idempotent no-change responses stay ordinary results. The JSON error bodies are unchanged, so anything parsing them keeps working.

## [1.0.0-beta.2] - 2026-03-26

### Changed

Split `abilities.ts` and `tools.ts` into focused modules. Both files had grown into 500+ line grab bags. Each new module owns one concern:

- `http-client.ts` handles HTTP requests, pagination, and error responses
- `help.ts` builds the help and description text for abilities
- `tool-schema.ts` converts MainWP abilities into MCP tool schemas
- `session.ts` tracks per-session tool usage stats
- `confirmation.ts` manages the destructive action confirmation flow

Shared helpers (`getErrorMessage`, `buildLoggerMethods`, `jsonResource`) moved to `logging.ts` and `errors.ts` where they belong. Re-exports removed, all imports point to the actual module now.

### Security

Tightened input validation based on code review findings (config parsing, request parameters).
