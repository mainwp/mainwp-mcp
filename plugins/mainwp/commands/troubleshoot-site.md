---
description: Diagnose one managed site: connectivity, sync health, pending updates, errors.
argument-hint: <site-id or site name>
---

Diagnose a single site and say what to do about what you find.

Steps:

1. Resolve the site from `$ARGUMENTS`. If it is empty, list the managed sites and ask the user which one, then stop until they answer.
2. Check the tool catalog for site-detail and update-inventory capabilities, then pull the site's current record: connection state, WordPress version, last sync.
3. Judge the sync: a stale or failing sync usually means a connectivity or child-plugin problem, so treat it as the first suspect.
4. Check pending updates for that site, and note anything that looks related to the symptom the user described.
5. Collect the errors and warnings the Dashboard reports for the site, without paraphrasing them into something cleaner than they are.
6. Report the current status, the issues found, and the fixes in the order they should be tried.

Rules:

- Never guess the site. Do not default to the first site in the list, and do not act on a fuzzy name match until you have named the specific site and URL back to the user and they confirmed it.
- If the user narrows the focus, for example to connectivity, performance, security, or updates, keep that focus instead of running the full sweep.
- Stay read-only unless the user asks for a fix. Any repair action goes through the server's confirmation flow, never as an automatic follow-up.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
