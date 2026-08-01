# Claude Code Plugin and Cross-Agent Skill

Conventions for the plugin shipped from this repository. User-facing setup
instructions live at <https://docs.mainwp.com/mcp-server>; this file is for
people editing the plugin.

## What ships

```text
.claude-plugin/marketplace.json          marketplace manifest (name: mainwp-mcp, owner: MainWP)
plugins/mainwp/.claude-plugin/plugin.json  plugin manifest (name: mainwp)
plugins/mainwp/.mcp.json                 MCP server config, no env map
plugins/mainwp/commands/*.md             10 commands, registered as /mainwp:<basename>
plugins/mainwp/skills/mainwp-dashboard/  synced mirror of the skill
.agents/skills/mainwp-dashboard/         canonical skill, edited here
```

Install:

```text
/plugin marketplace add mainwp/mainwp-mcp
/plugin install mainwp@mainwp-mcp
```

Under the plugin the MCP server registers as `plugin:mainwp:mainwp`, so its
tools are expected to appear as `mcp__plugin_mainwp_mainwp__<tool>` rather than
the `mcp__mainwp__<tool>` a manual server config produces. Confirm that prefix
against a live interactive session before hardcoding it into matchers or
examples.

If a user already has a manually configured `mainwp` MCP server, installing the
plugin gives them two connections to the same Dashboard: two tool sets, two
caches, two confirmation states. The fix is removing the manual entry and
keeping the plugin's.

## Canonical copy rule

`.agents/skills/mainwp-dashboard/` is canonical. Edit there.
`npm run sync-skill` copies it to `plugins/mainwp/skills/mainwp-dashboard/`,
and CI byte-compares the two copies (`scripts/check-skill-sync.ts`). A drifted
mirror fails the build.

Never edit the copy under `plugins/`. The next sync overwrites it, and until
then the two agents read different instructions.

The canonical location is the cross-agent one on purpose: `.agents/skills/` is
what Codex CLI and other agent-skills clients read, so the skill is not a
Claude Code artifact that other clients borrow.

## Plugin version rule

`plugins/mainwp/.claude-plugin/plugin.json` carries its own version, unrelated
to the server version in `package.json`. Bump it only in a plugin-release PR.
The server version bumps only at publish time on `main`. Do not bump either one
to make a local build or a test run pass.

## Content rules for the skill and commands

**No tool-name enumeration.** The tool list comes from the Dashboard's ability
catalog at runtime and varies with the Dashboard version, installed extensions,
and `MAINWP_ALLOWED_TOOLS`/`MAINWP_BLOCKED_TOOLS`. A hardcoded list goes stale
and teaches the agent to call tools that do not exist on that connection. Point
at the `mainwp://help` and `mainwp://categories` resources instead, and
describe capabilities in plain language.

**Do not restate the server's confirmation-flow text.** The server owns the
preview, token, and confirmation wording, including the difference between a
real `dry_run` preview and confirm-without-preview. A second copy in the skill
drifts from the code and can end up claiming a preview happened when none did.
The skill may say that destructive operations stop for confirmation; the exact
mechanics come from what the server returns.

**No credential literals.** Nothing in `plugins/` carries a Dashboard URL,
username, password, or token, including as a placeholder that looks fillable.

**Commands never synthesize site IDs.** A command that needs a site ID resolves
it from the Dashboard (a site lookup or the `mainwp://site/{id}` resource) and
stops if it cannot. Guessing an ID targets whatever site happens to hold that
row.

**The setup command reports presence only.** It prints whether a variable is
set, never its value, length, or a masked form, and never dumps the environment
or reads credential files.

## Why .mcp.json has no env map

`plugins/mainwp/.mcp.json` declares `command` and `args` and nothing else. The
server inherits the environment Claude Code runs it in, which is where the
user's credentials already are.

An explicit `"MAINWP_URL": "${MAINWP_URL}"` style map was tried and rejected.
Claude Code passes an unset `${VAR}` through literally, so a user with nothing
configured would hand the server the string `${MAINWP_URL}` as a URL and get a
validation failure instead of the friendly missing-configuration guidance the
server prints when the variable is genuinely absent. The `${VAR:-}` form avoids
the literal, but it clobbers genuinely set inherited values with empty. Plain
inheritance keeps unset variables unset and set variables intact.

## Config option changes are a three-way update

Adding, removing, or changing a configuration option updates all three of
these in the same change:

1. The environment-variable table in `README.md`.
2. The docs-site configuration reference
   (<https://docs.mainwp.com/mcp-server/reference/configuration>, source in the
   `mainwp/docs` repo).
3. `.agents/skills/mainwp-dashboard/references/safety-and-limits.md`, when the
   option's semantics are something the skill teaches: safe mode, confirmation
   gating, tool filtering, response and pagination caps, retry behavior.

Then run `npm run sync-skill` so the plugin mirror matches. A config change
that skips step 3 leaves the agent teaching behavior the server no longer has.

## Codex CLI and other agent-skills clients

Verified against codex-cli 0.144.1.

Skills load from `~/.agents/skills/` for user-wide use, or `.agents/skills/` in
a repo checkout. Copy the canonical skill directory to
`~/.agents/skills/mainwp-dashboard/`.

The server goes in Codex's `config.toml`:

```toml
[mcp_servers.mainwp]
command = "npx"
args = ["-y", "@mainwp/mcp"]
env_vars = [
  "MAINWP_URL",
  "MAINWP_USER",
  "MAINWP_APP_PASSWORD",
  "MAINWP_TOKEN",
  "MAINWP_SAFE_MODE",
  "MAINWP_REQUIRE_USER_CONFIRMATION",
  "MAINWP_ALLOWED_TOOLS",
  "MAINWP_BLOCKED_TOOLS",
  "MAINWP_SKIP_SSL_VERIFY",
]
```

That list is the common set, not all of them. Add any other `MAINWP_*`
variable you use from the README configuration table.

`env_vars` is a list of variable names passed through from the parent
environment; no values appear in the TOML. Codex also supports an `env` table
of literal key/value pairs. Do not put an application password there. A user
who insists on it should `chmod 600` the TOML file.

For users who cannot use environment variables at all, the server's
`settings.json` configuration file is the fallback. It holds a plaintext
application password, so `chmod 700` its directory and `chmod 600` the file.
The server does not enforce file modes; that is the user's responsibility.

## Tested versions

Checked 2026-07-30 against Claude Code 2.1.220 and codex-cli 0.144.1.

Two caveats from that check:

- Plugin MCP servers did not surface in `claude -p` headless sessions on
  2.1.220. Interactive sessions are the tested path. Scripted or headless runs
  should configure the server directly rather than relying on the plugin.
- Running `npx -y @mainwp/mcp` with a working directory inside a checkout of
  this repo resolves to the local package and fails with "command not found",
  because `npm exec` matches the local package name before the registry. This
  only bites during development. Run from a directory outside the checkout, or
  point the config at the built `dist/index.js`.
