---
description: Diagnose the MainWP MCP connection and configuration without exposing secrets.
---

Read-only diagnostic. Report whether the MainWP MCP server is configured and connected.

Hard rule: never echo a credential value, in full, truncated, masked, or as a length. This command reports presence only.

Step 1. Run this probe exactly as written, with no additions:

```bash
[ -n "$MAINWP_URL" ] && echo "MAINWP_URL set" || echo "MAINWP_URL unset"
[ -n "$MAINWP_USER" ] && echo "MAINWP_USER set" || echo "MAINWP_USER unset"
[ -n "$MAINWP_APP_PASSWORD" ] && echo "MAINWP_APP_PASSWORD set" || echo "MAINWP_APP_PASSWORD unset"
[ -n "$MAINWP_TOKEN" ] && echo "MAINWP_TOKEN set" || echo "MAINWP_TOKEN unset"
[ -n "$MAINWP_SAFE_MODE" ] && echo "MAINWP_SAFE_MODE set" || echo "MAINWP_SAFE_MODE unset"
[ -n "$MAINWP_REQUIRE_USER_CONFIRMATION" ] && echo "MAINWP_REQUIRE_USER_CONFIRMATION set" || echo "MAINWP_REQUIRE_USER_CONFIRMATION unset"
[ -n "$MAINWP_ALLOWED_TOOLS" ] && echo "MAINWP_ALLOWED_TOOLS set" || echo "MAINWP_ALLOWED_TOOLS unset"
[ -n "$MAINWP_BLOCKED_TOOLS" ] && echo "MAINWP_BLOCKED_TOOLS set" || echo "MAINWP_BLOCKED_TOOLS unset"
[ -n "$MAINWP_SKIP_SSL_VERIFY" ] && echo "MAINWP_SKIP_SSL_VERIFY set" || echo "MAINWP_SKIP_SSL_VERIFY unset"
```

Not allowed in this command, for any reason:

- `env`, `set`, or `printenv`, or any other command that dumps the environment.
- Shell tracing such as `set -x`, which would print values.
- Interpolating a variable's value into output, a comparison, or a log line.
- Reading credential files, including the server's `settings.json`.

Step 2. Read the `mainwp://status` resource and report the connection state it returns: reachable or not, which Dashboard identity is in use, and the kind of error the server surfaces (unreachable, authentication rejected, TLS failure, and so on). Summarize errors in your own words rather than quoting raw error text — the hard rule above applies to error output too.

Step 3. If the server is unconfigured or cannot connect, point the user at the configuration reference at https://docs.mainwp.com/mcp-server. Explain that credentials come from their own environment, that the supported path is a WordPress application password with `MAINWP_USER` and `MAINWP_APP_PASSWORD`, and that a manually configured `mainwp` MCP server alongside this plugin is a duplicate connection: remove the manual entry and keep the plugin's.

Report the findings and stop. Do not attempt to fix the configuration and do not write any file.
