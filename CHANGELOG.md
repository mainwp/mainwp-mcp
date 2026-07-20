# Changelog

All notable changes to mainwp-mcp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

Destructive abilities that declare no `confirm` parameter now fail closed. The confirmation flow used to return a skip decision for them, so a destructive-classified ability without a declared `confirm` parameter executed with no preview, token, or user approval even with `requireUserConfirmation` enabled. Such calls now return a `CONFIRMATION_UNSUPPORTED` error naming the missing confirm support. **This is a behavior change** for third-party or misannotated destructive abilities that never declared `confirm`; the built-in deletion tools all declare it and are unaffected. The former `INVALID_PARAMETER: user_confirmed not supported` response is folded into the new error.

Dashboard-provided ability `instructions` are now sanitized before entering tool descriptions: control and format characters (newlines, ANSI, bidi marks) collapse to spaces and the text is capped at 300 characters. Remote metadata used to be forwarded verbatim and unbounded, giving a compromised Dashboard or extension a context-flooding channel into every tool description.

Refreshed the dependency lockfile within declared ranges: `undici` to 7.28.0 and the MCP SDK's transitive HTTP-transport dependencies to patched versions, clearing all `npm audit` advisories (previously 4 high, 4 moderate on the production tree).

All remote ability and category content is now normalized once at the fetch boundary: labels, categories, descriptions, and `instructions` get non-string values replaced, control/format characters stripped, and hard length caps (200/100/2000/300 chars) before reaching tool descriptions, mainwp:// resources, or help output. Input and output schemas are deep-bounded by a generic, field-aware walker covering every keyword at every depth (`properties`, `items`, `oneOf`, `$defs`, `additionalProperties`, anything else): presentation fields (`description`, `title`, `$comment`) are sanitized and capped at 500 chars, while semantic strings (enum/const values, `pattern`, `$ref`, defaults) are never mutated — an ability whose schema carries a semantic string over 2000 chars, an oversized key, or more than 2000 nodes is dropped from the catalog with a warning instead of being silently altered. Previously only the `instructions` field was capped, only on the tools/list path — the help and abilities resources returned remote text verbatim, and a non-string `instructions` value threw during tool conversion, which the ListTools handler turned into an empty tool catalog for the whole server.

Tool discovery now uses the same fail-closed destructive classifier as the execution policy. An ability with missing or malformed `destructive` annotations used to be advertised as a plain write operation with no destructive hint (and, when it declared `confirm`, without the `user_confirmed`/`confirmation_token` parameters the executor requires) while execution treated it as destructive. Discovery now tags such tools DESTRUCTIVE, emits normalized MCP annotation hints (`destructiveHint` follows the classifier; positive hints require literal `true`; annotations are always present), and injects the confirmation parameters. **This is a behavior change** for unannotated abilities' advertised metadata; correctly annotated abilities are unaffected.

The `safeMode` description in the shipped `settings.schema.json` no longer calls safe mode suitable for "read-only access"; it now states that non-destructive writes remain available and points to `allowedTools` for read-only setups.

`prepublishOnly` additionally runs the production dependency audit (high severity and above) and the packed-package fixture acceptance suite.

### Added

The server warns at startup when a bearer token (`MAINWP_TOKEN`) is configured without a complete username and application password pair. The WordPress Abilities API rejects bearer tokens, so a token-only setup fails with 401s at request time; the warning surfaces the problem at startup instead.

### Changed

The `mainwp://abilities` and `mainwp://help` resources now respect `allowedTools`/`blockedTools`: blocked tools no longer appear in their payloads, and the per-tool help resource (`mainwp://help/tool/{name}`) returns a permission error for blocked tools instead of documenting them. **This is a behavior change** for clients that read the full catalog from these resources under a restrictive policy; they now see the same filtered set as `tools/list`. The `mainwp://categories` list and `mainwp://status` ability count remain unfiltered. Internally, every policy check now routes through a single pure decision function (`src/policy.ts`).

Destructive classification is now strictly fail-closed: only a literal `destructive: false` annotation counts as non-destructive, so malformed values (`0`, `""`, `"yes"`) classify as destructive instead of following JavaScript truthiness. The `mainwp://site/{id}` resource and site-ID completions, which execute abilities directly, now apply this classification before executing: with safe mode or confirmation gating active, a destructive-classified (or unannotated) underlying ability denies the resource and returns empty completions. **This is a behavior change** for Dashboards that ship no annotations on `mainwp/get-site-v1` or `mainwp/list-sites-v1` — the same default-deny stance tool calls already had.

Destructive tool calls now go through strict confirmation gating. A bare call to a confirm-capable tool, with no preview and no confirmation token, returns a `PREVIEW_REQUIRED` error instead of proceeding with a logged warning. **This is breaking for clients that relied on the old skip**: run the preview step first, then confirm. Abilities that require confirmation but expose no `dry_run` parameter no longer get a fabricated dry-run call; they return a token-issuing `CONFIRMATION_REQUIRED` response with `preview: null`, and execution proceeds once the client confirms with that token.

Nested objects and arrays of objects in the input of GET/DELETE abilities are now rejected with an invalid-params error. They used to be serialized into the query string as `[object Object]`, which the Dashboard silently misread.

Malformed boolean configuration now fails startup instead of logging a warning and falling back to the default. Accepted values are `true/1/yes/on` and `false/0/no/off`; anything else stops the server with an error naming the variable.

### Removed

The package no longer installs a global command named `mcp`. That name is too generic for a public package and collides with other MCP tooling. The command is `mainwp-mcp`, and `npx @mainwp/mcp` keeps working since the package now has a single bin entry.

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

## [1.0.0-beta.3] - 2026-06-10

### Added

Ability namespaces are now configurable. The server used to surface only `mainwp/` abilities; the new `abilityNamespaces` setting (or the `MAINWP_ABILITY_NAMESPACES` environment variable) lets you expose abilities that third-party MainWP extensions register through the WordPress Abilities API. The first namespace in the list is the primary one and its tools keep their plain names, so `mainwp/list-sites-v1` still appears as `list_sites_v1`. Abilities from other namespaces carry a prefix: `acme/do-thing-v1` becomes `acme__do_thing_v1`. Hyphenated namespaces such as `acme-corp` work end to end, including execution. Built-in resources and prompt completions depend on `mainwp/get-site-v1` and `mainwp/list-sites-v1`, so keep `mainwp` in the list when adding others.

The server now warns at startup when `mainwp` is missing from `abilityNamespaces`, and after fetching abilities when the namespace filter matches none of them. A misconfigured allowlist used to boot a server that advertised zero tools with nothing in the logs explaining why. An empty upstream gets its own message so a dead API is distinguishable from a filter mismatch.

### Removed

The `toolNameToAbilityName` export is gone. Tool names stopped being uniquely decodable once multiple namespaces came into play, so reverse lookup now goes through an index built when abilities are fetched. Anything importing that function from this package needs to switch to `getAbilityByToolName`.

### Fixed

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
