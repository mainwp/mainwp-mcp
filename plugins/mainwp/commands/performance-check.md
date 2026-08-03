---
description: Performance indicators for one site or the whole network, from Dashboard data.
argument-hint: '[site id or "all"]'
---

Report the performance signals the Dashboard can see and where they point.

Steps:

1. Read `$ARGUMENTS` for a site scope. Empty or the exact value `"all"` means every site the Dashboard returns; any other value must resolve to a managed site through the Dashboard — stop and say so if it is unknown.
2. Check the tool catalog for site-listing and site-detail capabilities, then gather the sites in scope.
3. Review connection health: sync reliability, timeouts, and any repeated failures.
4. Review resource indicators the data supports, such as active plugin counts, the active theme, and anything the Dashboard reports about storage or database size.
5. Point out the sites most likely to gain from optimization, with the specific signal behind each call.
6. Separate what the Dashboard data actually shows from what needs a real front-end measurement.

Rules:

- Use only the scope in `$ARGUMENTS`. Never synthesize a site ID and never silently switch to a different site.
- Stay read-only. Do not change plugins, themes, or settings to test a theory.
- MainWP data is inventory and sync health, not page timing. Do not present it as load-time measurement or invent scores.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
