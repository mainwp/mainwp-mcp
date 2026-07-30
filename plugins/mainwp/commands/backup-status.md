---
description: Report backup coverage and freshness across managed sites.
argument-hint: '[site ids or "all"]'
---

Report which managed sites are backed up, how recently, and which are not covered.

Steps:

1. Check the tool catalog for site-listing and backup-related capabilities, then scope to the sites in `$ARGUMENTS`, or to all managed sites when it is empty.
2. Determine which sites have a backup solution the Dashboard can see, and which have none.
3. Group the covered sites by backup age: recent, aging, and nothing recorded.
4. Call out sites with no backup coverage or no recorded backup at all as the highest priority.
5. Finish with what to fix first, and state plainly which backup details the Dashboard does not expose.

Rules:

- Use only the sites named in `$ARGUMENTS`. Never synthesize site IDs or widen the scope on your own.
- Stay read-only. Do not start, schedule, or delete backups from this command.
- Backup visibility depends on what the Dashboard and its extensions report. Absence of data is not proof a backup is missing; label it as unknown.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
