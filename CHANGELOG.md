# Changelog

All notable changes to mainwp-mcp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0-beta.3] - 2026-06-10

### Added

Ability namespaces are now configurable. The server used to surface only `mainwp/` abilities; the new `abilityNamespaces` setting (or the `MAINWP_ABILITY_NAMESPACES` environment variable) lets you expose abilities that third-party MainWP extensions register through the WordPress Abilities API. The first namespace in the list is the primary one and its tools keep their plain names, so `mainwp/list-sites-v1` still appears as `list_sites_v1`. Abilities from other namespaces carry a prefix: `acme/do-thing-v1` becomes `acme__do_thing_v1`. Hyphenated namespaces such as `acme-corp` work end to end, including execution. Built-in resources and prompt completions depend on `mainwp/get-site-v1` and `mainwp/list-sites-v1`, so keep `mainwp` in the list when adding others.

### Removed

The `toolNameToAbilityName` export is gone. Tool names stopped being uniquely decodable once multiple namespaces came into play, so reverse lookup now goes through an index built when abilities are fetched. Anything importing that function from this package needs to switch to `getAbilityByToolName`.

### Fixed

A failed ability refresh can no longer leave the tool index half built. The cache swaps in atomically, and if the fetch hits duplicate tool names the previous index keeps serving while the error is reported. Abilities with malformed names, an extra slash for example, are dropped at fetch time with a logged warning rather than surfacing as invalid MCP tool names.

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
