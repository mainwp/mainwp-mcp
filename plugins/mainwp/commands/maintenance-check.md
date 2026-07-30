---
description: Maintenance sweep across every managed site, with the work ranked by urgency.
---

Build a maintenance picture of the whole network and say what to handle first.

Steps:

1. Check the current tool catalog for a site-listing capability and an update-inventory capability, and plan around what is actually exposed.
2. List every managed site, recording connection state and last sync time.
3. Pull the pending update inventory and split it into core, plugin, and theme work.
4. Flag sites that are disconnected, returning errors, or have not synced recently.
5. Rank the findings: security-relevant updates first, then stale or broken syncs, then routine updates.
6. Report the counts together with the named sites behind each count, and state anything you could not check.

Rules:

- This command takes no arguments. Do not invent site IDs, filters, or time windows to narrow the sweep.
- Stay read-only. Recommend updates, do not apply them from here.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`. Do not substitute an unrelated tool to fill the gap.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
