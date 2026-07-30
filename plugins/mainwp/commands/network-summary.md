---
description: Executive summary of the managed network: site counts, update totals, health.
---

Summarize the whole managed network at a glance, not site by site.

Steps:

1. Check the tool catalog for a site-listing capability and an update-inventory capability before planning the summary.
2. List all managed sites and group them by connection state: connected, disconnected, erroring.
3. Aggregate pending updates across the network into core, plugin, and theme totals, and count how many sites are fully current.
4. Separate sites synced recently from those with stale sync data, using the timestamps the Dashboard returns rather than an assumed schedule.
5. Close with the few items that need attention now and the sites they belong to.

Rules:

- This command takes no arguments. Do not narrow the summary to a subset of sites or invent site IDs and filters.
- Stay read-only. This is a reporting command.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`. Report the summary as partial instead of estimating the missing parts.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
