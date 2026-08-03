---
description: Security-focused audit of managed sites: outdated core, plugins, themes.
argument-hint: '[site ids or "all"]'
---

Audit the managed sites for security exposure that shows up in Dashboard data.

Steps:

1. Check the tool catalog for site-listing and update-inventory capabilities, then scope the audit: empty `$ARGUMENTS` or the exact value `"all"` means every site the Dashboard returns; otherwise resolve each supplied site ID through the Dashboard and stop if any is unknown.
2. Check WordPress core versions and call out anything the Dashboard reports as outdated. Support-line status is not Dashboard data: mark it undetermined and needing manual verification rather than asserting it from the version number.
3. Review pending plugin updates, marking releases described as security fixes and components that look long abandoned.
4. Review themes the same way, including inactive themes that are still installed.
5. Rank the sites by exposure and give a concrete order of work, separating what the data proves from what needs a look at the site itself.

Rules:

- Use only the resolved sites: empty arguments or `"all"` means the Dashboard's full site list, anything else means exactly the sites given. Never synthesize site IDs, add sites the user did not ask for, or drop sites to make the report tidier.
- Stay read-only. Do not apply security updates from this command.
- Do not call a plugin or theme vulnerable on a version number alone. Say what the Dashboard reports and where a manual check is needed.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`, then mark that section of the audit as not covered.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
