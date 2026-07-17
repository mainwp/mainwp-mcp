# Acceptance testing

The acceptance harness tests the local working tree as an installed npm package and communicates with it through the real MCP stdio protocol. Its default packed mode creates a tarball, checks the published file list, installs that tarball in a fresh consumer project, and launches the installed `dist/index.js`.

The deterministic suite covers MCP initialization, discovery, resources, prompts, completions, site reads, check-site latency, theme and update inventories, client and tag listings, independent result checks, structured errors, session recovery, allow and block policies, safe mode, confirmation preview behavior, transport limits, settings-file configuration, and package integrity. Guarded live scenarios cover site sync and a reversible plugin toggle.

The harness does not prove every Dashboard ability, browser behavior, production performance, or compatibility with every MCP client. Fixture runs do not prove real Dashboard authentication, TLS, WordPress permissions, or changing live data. Agent runs add an end-to-end model check, but they do not replace the deterministic suite.

## Architecture

`tests/acceptance/run.ts` is a standalone `tsx` CLI. It selects scenarios, prepares credentials, starts the fixture when requested, launches one isolated MCP server process per scenario, and writes results.

Packed mode uses these stages:

1. `npm pack --json` creates the package tarball.
2. `tar -tzf` proves required files are present and private source or settings files are absent.
3. A fresh temporary consumer runs `npm init -y` and `npm install <tarball>` with its npm cache redirected to a temporary directory.
4. Installed production dependencies are served from a temporary registry bound to `127.0.0.1`. They are packed from the repository's already installed dependency tree. This keeps the consumer install independent and deterministic without contacting an external registry.
5. The harness resolves the installed entry point and both package bins.

Each MCP launch gets a fresh empty working directory and a fresh `HOME`. The launch environment contains only the explicit runtime values needed by that scenario. `settings-file-config` is the deliberate exception: it writes fake fixture credentials to a mode-restricted temporary `settings.json` and passes no `MAINWP_*` credential variables.

The fixture dashboard is a plain HTTP server on `127.0.0.1` with an operating-system-assigned port. It requires fake Basic authentication, serves `tests/evals/fixtures/abilities-full.json`, and reads deterministic site state from `tests/acceptance/fixtures/sites.json`.

`tests/acceptance/lib/verify.ts` reads the Abilities API directly with independent HTTP requests. It does not call through the MCP server. It mirrors the production request method and PHP-style `input[...]` query serialization.

## Prerequisites

- Node.js 20.19 or newer
- The dependencies already installed with `npm ci` or `npm install`
- A completed `npm run build` before source mode or a fixture packed run
- `tar`, `git`, and `npm` available on `PATH`
- For live runs, a reachable MainWP Dashboard and a WordPress Application Password
- For agent runs, the `claude` CLI with working model access

The deterministic fixture suite needs no Dashboard credentials and contacts no host other than `127.0.0.1`.

## Credentials and environment variables

Live credentials are resolved in this order:

1. `MAINWP_URL`, `MAINWP_USER`, and `MAINWP_APP_PASSWORD` from the process environment
2. The file named by `MAINWP_MCP_ACCEPTANCE_ENV`
3. `~/github/dev-tools/network-testbed/.env`

The env file maps `LLM_DASH_URL` to the Dashboard URL and reads `MAINWP_USER` and `MAINWP_APP_PASSWORD`. Values stay in memory. The harness never writes real credentials to a consumer project, settings file, command record, transcript, or result artifact.

Live server and verifier requests accept the testbed's self-signed certificate. The server receives `MAINWP_SKIP_SSL_VERIFY=true`; the verifier uses a request-scoped undici dispatcher with certificate validation disabled.

Additional controls:

- `MAINWP_MCP_ACCEPTANCE_WRITE_HOSTS`: comma-separated exact hostnames allowed for `--writes`, in addition to `localhost`, `127.0.0.1`, and hosts ending in `.local`
- `MAINWP_MCP_ACCEPTANCE_TOGGLE_PLUGIN`: explicit plugin slug eligible for the reversible plugin scenario and preferred by the `agent-plugin-active` probe; the built-in safe slugs are `hello.php` and `hello-dolly/hello.php`

## Commands

Build before running the fixture suite:

```bash
npm run build
npm run test:acceptance:fixture
```

Other entry points:

```bash
npm run test:acceptance
npm run test:acceptance:fast
npm run test:acceptance:writes
npm run test:acceptance:agent
npm run test:acceptance:human
```

`test:acceptance:human` runs the packed fixture suite, guarded live write suite, and agent suite in that order. The command uses `&&`, so it stops at the first failing layer.

The default target is live and the default mode is packed. `test:acceptance:fast` uses the repository's existing `dist/index.js` and still launches the real MCP server.

List or select deterministic scenarios:

```bash
npx tsx tests/acceptance/run.ts --list
npx tsx tests/acceptance/run.ts --target fixture --scenario count-sites-consistency
npx tsx tests/acceptance/run.ts --scenario startup-handshake --scenario discovery-tools
```

Preserve a packed consumer for inspection:

```bash
npx tsx tests/acceptance/run.ts --target fixture --keep-consumer
```

Select an agent scenario:

```bash
npx tsx tests/acceptance/agent-run.ts --list
npx tsx tests/acceptance/agent-run.ts --scenario agent-count-sites
```

Write scenarios require both `--writes` and an allowed Dashboard host. Runs without both conditions report those scenarios as skipped. A skipped or unverified scenario is visible in the totals and is never counted as passed.

## Correctness and evidence order

Scenario assertions use evidence in this order:

1. Direct Abilities API reads from the independent verifier establish current state.
2. MCP calls exercise the installed server through JSON-RPC over stdio.
3. Structured MCP response fields are parsed and compared with the independent state.
4. A second direct read proves state preservation or the requested write.
5. Prose is used only for diagnostics, never as the correctness oracle.

For example, `list-sites-cross-check` compares both the site count and the complete set of site URLs. `not-found-input` requires an `isError` result, then calls `count_sites_v1` on the same client session to prove recovery. `confirmation-gate-no-token` checks the structured confirmation status and token, then independently proves that the site set did not change.

Agent verdicts are also deterministic. Generic scenarios must use an expected `mcp__mainwp__*` tool family, supply structured arguments, receive a non-error tool result, and produce a factual final answer that matches an independent verifier read. Custom evaluators enforce the expected error, multi-tool chain, or full-site coverage when the generic path is insufficient. The model does not grade itself.

The agent layer contains nine scenarios:

- `agent-count-sites`: count all connected sites.
- `agent-updates`: identify sites with pending plugin updates.
- `agent-plugin-active`: report whether a discovered plugin is active on its site.
- `agent-nonexistent-site`: consult the Dashboard and report that a probe site is absent without repeating plugin names from real sites.
- `agent-tags`: report the complete paginated tag count and names.
- `agent-theme-chain`: find the single site with pending plugin updates, then report its active theme.
- `agent-confirm-delete-site`: complete the fixture deletion confirmation flow.
- `agent-safemode-refusal`: attempt a fixture deletion and require a correlated `SAFE_MODE_BLOCKED` result with unchanged state.
- `agent-site-status`: check every live site and report the independently verified connectivity result.

An agent scenario may define `serverEnv` for literal, non-secret server flags that apply only to that scenario. These values are merged into the temporary `claude-mcp.json` server environment. `agent-safemode-refusal` uses this field to set `MAINWP_SAFE_MODE=true`.

The `agent-confirm-delete-site` scenario is the state-changing write exception in the agent layer. It points the packed MCP server at a newly started local fixture, asks in natural language for an explicitly authorized site deletion without naming a tool, and grades the transcript and state independently. The transcript must contain a `delete_site_v1` result with `CONFIRMATION_REQUIRED` and a token, followed by a confirmed `delete_site_v1` call using that token. A direct fixture read must then show exactly one fewer site and the target site absent. Refusing or stopping before confirmation is a failed scenario with the transcript reason preserved.

## Completion and transport-limit coverage

`prompt-completions` targets both live and fixture Dashboards. It requests the existing `update-workflow` prompt's `update_type` completion with the prefix `c`, requires a non-empty result, and checks every suggestion against the `mainwp/list-updates-v1` input enum read directly by the independent verifier. The scenario also launches with `list_sites_v1` blocked and verifies that the current site-ID completion path returns the permission-denied code.

The fixture-only `oversized-response-recovery` scenario opts into a large `list_sites_v1` response with a reserved search value. It launches the packed server with a response limit above the fixture catalog size but below the fault response size, requires a structured error, and then proves that `count_sites_v1` succeeds on the same MCP session.

The fixture-only `request-timeout-recovery` scenario opts into a delayed `list_sites_v1` response. It uses the existing `MAINWP_REQUEST_TIMEOUT` environment setting to launch the packed server with a short deadline, requires the structured timeout code, and then proves same-session recovery with `count_sites_v1`. Both fault modes are request-specific, so ordinary fixture scenarios are unchanged.

## Artifacts

Every run writes to:

```text
test-results/acceptance/<UTC timestamp>-<short SHA>[-dirty][-agent]/
```

The directory contains:

- `manifest.json`: git branch, commit, dirty state, diff hash, package and runtime versions, flags, timing, and tarball integrity
- `events.jsonl`: redacted MCP messages in both directions with scenario, ISO timestamp, and monotonic milliseconds
- `commands.jsonl`: command argv, working directory, exit code, duration, and redacted output tails
- `results.json`: scenario statuses and every named assertion with expected, actual, and pass fields
- `summary.md`: compact human-readable totals and status table
- `server-<scenario>.stderr.log`: redacted server diagnostics for each launch
- `agent-transcript.jsonl`: redacted Claude stream events when running the agent layer

The redactor is initialized with the username, application password with and without spaces, Dashboard origin, and Basic Authorization value. Every artifact write passes through it. Fixture credentials follow the same path so fixture runs test the redaction mechanism.

## Adding a deterministic scenario

Add a module under `tests/acceptance/scenarios/`, export it from `scenarios/index.ts`, and use the shared `ScenarioDefinition` type. State an objective purpose and record explicit pass criteria with `ctx.assert`.

This complete example is the implementation shape used by `count-sites-consistency`:

```ts
import type { ScenarioDefinition } from './types.js';

export const countSitesConsistency: ScenarioDefinition = {
  id: 'count-sites-consistency',
  purpose: 'Verify the MCP count-sites result equals an independent direct count.',
  kind: 'read',
  targets: ['live', 'fixture'],

  async run(ctx) {
    const { result, data } = await ctx.client.callToolJson('count_sites_v1');
    const directCount = await ctx.verifier.countSites();

    ctx.assert.equal('count_sites_v1 succeeds', result.isError, undefined);
    ctx.assert.equal(
      'MCP and independent counts match',
      (data as { total: number }).total,
      directCount
    );
  },
};
```

Use `preconditions` for target-specific discovery or a non-default server launch. Return `skipped` when a documented external precondition is absent, such as no safe plugin being installed. Do not convert a failed assertion into a skip.

For a write scenario, define `cleanup(ctx)` whenever the operation can leave state changed. Cleanup runs after success or failure while the same MCP session is still available.

## Reproducing a failure

1. Open `summary.md` and find the failed scenario.
2. Read its failed assertions and error in `results.json`.
3. Inspect that scenario's messages in `events.jsonl` and its stderr log.
4. Check `manifest.json` for the exact commit, dirty state, diff hash, mode, target, package integrity, Node version, and npm version.
5. Re-run only that scenario with the same target and mode.

Example:

```bash
npx tsx tests/acceptance/run.ts \
  --target fixture \
  --mode packed \
  --scenario count-sites-consistency \
  --keep-consumer
```

`commands.jsonl` records the package and consumer commands needed to diagnose a packing or installation failure. The preserved consumer path printed by `--keep-consumer` can be used to inspect the installed package and bin links.

## Deterministic and agent-driven runs

The deterministic runner chooses each MCP operation itself and verifies structured values. It is suitable for CI and produces the same fixture result on every run.

The agent runner gives Claude Code a natural-language task without naming a tool. Its temporary MCP config contains literal `${MAINWP_URL}`, `${MAINWP_USER}`, `${MAINWP_APP_PASSWORD}`, `${MAINWP_SKIP_SSL_VERIFY}`, and `${MAINWP_ALLOW_HTTP}` placeholders plus any literal scenario `serverEnv` flags. Real credential values exist only in the spawned process environment. Live scenarios use resolved Dashboard credentials. The confirmation and safe-mode scenarios use only local fixture credentials, and selecting either by itself does not require live credentials. If the CLI or model is unavailable, the scenario is `unverified` and records the exact blocked command.

Live Dashboard data can change between an MCP call and the independent read. Site sync can complete asynchronously. Installed plugins and available updates vary by site. Agent tool choice and wording can vary by model. These are known sources of nondeterminism. Fixture scenarios avoid them; live and agent artifacts preserve enough ordered evidence to explain them.
