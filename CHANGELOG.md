# Changelog

All notable changes to mainwp-mcp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

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
