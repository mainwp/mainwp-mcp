---
description: Plan a safe update run: what to update, in what order, on which sites.
argument-hint: '[plugins|themes|core|all] [site ids or "all"]'
---

Turn the pending updates into an ordered plan the user can approve before anything runs.

Steps:

1. Read `$ARGUMENTS` for an update type and a site scope. Missing values mean all update types and all managed sites; do not guess narrower.
2. Check the tool catalog for update-inventory and update-execution capabilities, then list the pending updates in scope.
3. Group them by risk: security fixes, then bug fixes, then feature releases, and note anything that usually needs a manual step.
4. Propose an order that puts core before plugins and themes, and puts lower-stakes sites ahead of production ones.
5. Report backup coverage for the affected sites before recommending anything be applied.
6. Present the plan and stop. Wait for the user to say which part to run.

Rules:

- Use only the update type and sites in `$ARGUMENTS`. Never synthesize site IDs and never expand the scope to make the run look complete.
- Applying updates is destructive. Run an update tool only when the user explicitly asks for that step, and follow the server's preview and confirmation flow as it is returned. Never claim a preview happened when the ability did not provide one.
- Safe mode or a policy filter can block update execution outright. If that happens, say so and leave the plan as the deliverable.
- If a capability you need is not in the tool catalog, say it is not exposed on this Dashboard and note it may be filtered by `MAINWP_ALLOWED_TOOLS` or `MAINWP_BLOCKED_TOOLS`.
- Your client may also expose this workflow as a MainWP MCP prompt; either entry point is fine.
