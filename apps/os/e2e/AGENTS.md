# os e2e test infrastructure

Use this folder for Vitest end-to-end tests that exercise OS through public routes against a live
deployment (local dev, preview, or prod).

## Shape

Active e2e tests drive OS through **itx** — the same project capability handle the dashboard,
REPL, and CLI use. The oRPC product surface is gone; nothing here talks to oRPC anymore.

- `vitest.config.ts` owns run-level config, artifact roots, and console capture. `pnpm e2e` runs
  `e2e/vitest/**/*.test.ts` plus the cross-runtime examples matrix in
  `e2e/examples/*.e2e.test.ts` and unit tests for its support machinery in
  `e2e/test-support/*.test.ts` through it. Nothing filters on any other filename shape.
- `test-support/os-client.ts` exposes the admin itx handle (`createAdminOsItx`) plus base-URL /
  bearer-token resolution.
- `test-support/create-test-project.ts` creates a disposable OS project via itx
  (`createTestProject` → `{ project, itx(), agent(path), [Symbol.asyncDispose] }`; removal is a
  no-op until itx grows `projects.remove`). `handle.itx()` returns a fresh admin itx handle
  narrowed to the project; reach streams and agents through it
  (`itx.streams.get(path).{append,getEvents,waitForEvent,subscribe}`,
  `itx.agents.get(path).{sendMessage,ask}`).

## Lanes

The usual invocation is `doppler run --config <config> -- pnpm e2e [-t <filter>]` from `apps/os`.
How to target local dev / previews / prd and the canonical env vars
(`APP_CONFIG_BASE_URL`, `APP_CONFIG_ADMIN_API_SECRET`, the `OS_E2E_*` harness knobs) are documented
in [docs/testing.md](../../../docs/testing.md).

- Live deployment tests: `pnpm e2e` (one config, `e2e/vitest.config.ts`, one project named
  `node`). It runs the engine suites in `e2e/vitest/` (the itx catalogue, streams, agents,
  integrations, sandbox, ingress, preview smoke, …) and the cross-runtime example matrix in
  `e2e/examples/`. Browser coverage for the catalogue lives in
  `specs/repl-examples.spec.ts`, which drives the real REPL.
- Preview smoke: `pnpm e2e -t "OS preview smoke"` (`preview-smoke.e2e.test.ts`) exercises a
  deployed preview, including its project MCP route (it derives its project slug from
  `GITHUB_SHA` when set).
- Stream TUI behavior specs: `tsx ./e2e/tui-test/run.ts` (see `tui-test/README.md`). The script
  builds the published Iterate package, creates a disposable OS project, and launches that built
  CLI through Microsoft TUI Test. Preview CI runs this lane whenever OS is selected (disposal is a
  no-op until itx grows `projects.remove`, like every other test project).

## File names in `e2e/vitest/`

Two similar-looking shapes mean different things:

- **`itx-<topic>.e2e.test.ts`** (prefix) — the hand-written itx engine contract. These are the
  shards of the old `itx.e2e.test.ts` monolith, split in PR #1824 purely so file-level workers
  can spread them (test bodies unchanged; e.g. egress + secret substitution landed in
  `itx-egress.e2e.test.ts`). Each carries the header
  `// These are hand written tests - they MUST pass`, which dates back to the itx-v4 engine's
  original test file: hand-authored contract assertions, as opposed to the catalogue-driven
  examples matrix next door whose covered scripts evolve with the examples catalogue. A failure
  here is a product regression — fix the product, never weaken the assertion to green it.
- **`<feature>.itx.e2e.test.ts`** (infix) — historical, not a control. The `.itx.` marker was
  born in PR #1488 to distinguish the itx ports of the oRPC-era suites from their (since
  deleted) `*.orpc-legacy.ts` reference siblings, and then spread by convention to feature
  suites that drive OS purely through a project's itx handle with no raw HTTP/WebSocket
  probes. Every active e2e test drives itx now, and nothing — vitest include, CI, lint —
  keys off the infix. Treat it as informational; don't add it to new files.

## Scripts in tests

A script that demonstrates a user-facing pattern belongs in the examples
catalogue (`src/itx/examples-source.ts`): the test executes the entry by id
via `runExample()` (`test-support/run-example.ts`) and owns the assertions on
top. A probe — protocol semantics, concurrency blasts, incident repros,
malformed input — uses `itxScript()` (typed `execute()` by default,
`executeSource()` when the string itself is the point) and is never a
catalogue entry. Scripts carried by other channels (agent chat fences) are
authored with `defineItxScript()` so they typecheck the same way.
