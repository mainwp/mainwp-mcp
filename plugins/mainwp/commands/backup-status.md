---
description: Report backup coverage and freshness across managed sites.
argument-hint: '[site ids or "all"]'
---

Report which managed sites are backed up, how recently, and which are not covered.

Steps:

1. Check the tool catalog for site-listing and backup-related capabilities, then scope: empty `$ARGUMENTS` or the exact value `"all"` means every site the Dashboard returns; otherwise resolve each supplied site ID through the Dashboard and stop if any is unknown.
2. Sort every site into one of three states and keep them separate: the Dashboard reports backup coverage, the Dashboard reports no coverage, or the Dashboard has no backup data for the site at all. Missing data is unknown, not "no coverage".
3. For covered sites, report the exact age of the last recorded backup rather than vague buckets; if grouping helps, use under 24 hours as recent and over 7 days as aging (the same thresholds the server's backup-status prompt uses), and say so.
4. Call out reported-uncovered sites as the highest priority, and unknown-state sites right behind them as needing verification.
5. Finish with what to fix first, and state plainly which backup details the Dashboard does not expose.

Rules:

- Use only the resolved sites: empty arguments or `"all"` means the Dashboard's full site list, anything else means exactly the sites given. Never synthesize site IDs or widen a non-empty scope on your own.
- Stay read-only. Do not start, schedule, or delete backups from this command.
- Backup visibility depends on what the Dashboard and its extensions report. Absence of data is not proof a backup is missing; label it as unknown.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
