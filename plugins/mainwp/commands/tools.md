---
description: Show what this MainWP Dashboard exposes, grouped by capability category.
---

Explain what this specific Dashboard can do through the MainWP MCP server.

Steps:

1. Read the `mainwp://help` resource for the tool documentation and the safety conventions, including how preview and confirmation work for destructive operations.
2. Read the `mainwp://categories` resource for the capability categories this Dashboard reports.
3. Summarize by category: what each group is for, and what the user can realistically ask for. Describe capabilities in plain language rather than listing raw identifiers.
4. Call out the destructive groups separately, and say whether safe mode or confirmation is in effect if the server reports it.
5. Finish with a few example requests that match what is actually available here.

Rules:

- The category and status resources are not policy-filtered. They can list capability groups whose tools are hidden from the tool list by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`, so a category appearing here is not a promise that its tools are callable.
- If the user asks for something you cannot find, say it may be filtered by policy rather than absent from the Dashboard, and tell them where to check.
- The catalog is per Dashboard and changes with installed extensions. Report what this connection returns now; do not describe MainWP features in general as if they were available.
- Stay read-only. This command inspects the catalog, it does not run anything from it.
