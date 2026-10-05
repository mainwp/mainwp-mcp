# Configuration Reference

This guide moved to the MainWP documentation site:

**<https://docs.mainwp.com/mcp-server/reference/configuration>**

It covers every environment variable and `settings.json` field, the
settings-to-variable mapping, resource limits, retry logic, and SSL options.
Related guides that also lived on this page:

- Tool filtering: <https://docs.mainwp.com/mcp-server/guides/restrict-tools>
- Ability namespaces: <https://docs.mainwp.com/mcp-server/guides/other-plugin-abilities>
- Schema verbosity and token usage: <https://docs.mainwp.com/mcp-server/guides/token-usage>
- Safe mode and user confirmation: <https://docs.mainwp.com/mcp-server/safety>

Changing an option also touches the bundled Claude Code plugin's skill when
the skill teaches that option's semantics; the update rule is in
[plugin.md](plugin.md).
