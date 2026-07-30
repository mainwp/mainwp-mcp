---
description: Detailed report for one managed site: overview, updates, health, next actions.
argument-hint: <site-id or site name>
---

Produce a readable report for one site.

Steps:

1. Resolve the site from `$ARGUMENTS`. If it is empty, list the managed sites and ask the user which one, then stop until they answer.
2. Check the tool catalog for site-detail and update-inventory capabilities, then gather the site record: name, URL, WordPress version, sync state and time.
3. Report update status by category, with counts and the actual plugin and theme names rather than counts alone.
4. Report health: connection state, recent errors or warnings, and how reliable the sync has been.
5. Close with prioritized action items and anything that needs attention now.
6. Keep the format scannable, with short sections and no filler.

Rules:

- Never guess the site. Do not default to the first site in the list, and do not act on a fuzzy name match until you have named the specific site and URL back to the user and they confirmed it.
- Report only this site. Do not pull in neighbors for comparison unless the user asks.
- Stay read-only. This command reports, it does not change anything.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`, then mark that section of the report as unavailable rather than leaving it blank.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
