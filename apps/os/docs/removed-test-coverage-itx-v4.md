# Removed test coverage — itx-v4 replacement (PR #1585)

The itx-v4 migration deleted large test surfaces along with the legacy
implementation. Most had replacements; this document is the honest record of
what was removed **without** replacement, why, and how to dig each item back
up. Companion docs: `../ITX_V4_TEST_HARNESS_CHANGES.md` (harness/wiring
changes), `../ITX_V4_MIGRATION_REPORT.md` (the migration itself).

## How to recover anything listed here

- Every deleted file is intact on `main` until this PR merges, and in history
  forever after: `git show 'main:<path>'` (or `git log --all --diff-filter=D
-- '<path>'` to find the deleting commit, then `git show '<sha>^:<path>'`).
- The migration quarantined suites into `test-quarantine/` folders before
  deleting them at the very end in commit `551f172b7` ("The very end: delete
  the quarantine folders"). `git show '551f172b7^' --stat` lists everything
  that existed at that point; each quarantine folder had a README cataloguing
  its contents.

## Removed WITHOUT replacement (ranked by value of restoring)

### 1. Real third-party MCP interop e2e

- **Was:** `apps/os/src/itx/e2e/itx-mcp-auth.e2e.test.ts` (main) — proved the
  MCP client against Cloudflare's _real_ remote servers
  (`docs.mcp.cloudflare.com`, `bindings.mcp.cloudflare.com`): real
  streamable-HTTP protocol, real 401 semantics, env-gated on
  `CLOUDFLARE_API_TOKEN`. Included a journal negative-control: the full event
  journal never contains the substituted token, only the placeholder.
- **Now:** MCP auth-substitution mechanics are e2e-tested against in-repo
  fixtures only (`e2e/itx/itx.e2e.test.ts` + `src/e2e-fixtures.ts`). Protocol
  interop with a real third-party server and the journal-scan negative
  control are untested.
- **Why removed:** the suite was written against the legacy `itx.mcp`
  surface; porting the fixture-based parts was done, the live-server parts
  were not.
- **Worth restoring:** yes — an env-gated live smoke (skipped without the
  token, like the original) plus one journal-scan assertion. Cheap, and it is
  the only proof against a server we don't control.

### 2. In-workerd DO-internals adversarial suites

- **Was:** `@cloudflare/vitest-pool-workers` lanes on main
  (`test:streams-workers`): stream idle-teardown, redial,
  host-idle-disconnect adversarial tests with fake timers around alarms and
  forced socket drops (`apps/os/src/domains/streams/engine/workers/
durable-objects/*.workers.test.ts`).
- **Now:** behavioral analogues run against real deployments in
  `e2e/itx/stream-lifecycle.e2e.test.ts` / `stream-security.e2e.test.ts`, but
  in-process DO-internals testing (deterministic timers, forced transport
  failures) has no equivalent — the plan deliberately locked "URL-driven e2e
  only, no separate wrangler-dev lane".
- **Known live gap this class of test would catch:** the skipped test in
  `stream-lifecycle.e2e.test.ts` ("dropping a WebSocket waitForEvent caller
  cleans up the internal waitForEvent subscription") documents a real,
  currently-failing cleanup gap in that family.
- **Worth restoring:** only if DO-pinning regressions recur (see the
  DO-duration incident lineage); the lane is heavyweight and was a
  coexistence casualty, not an oversight.

### 3. Live-OpenAI provider e2e

- **Was:** `apps/os/e2e/vitest/agents.itx.e2e.test.ts` (main) had "uses
  OpenAI for explicitly configured agent chats" against the live provider.
- **Now:** the provider-toggle e2e (`agent-tools.itx.e2e.test.ts`) exercises
  the Cloudflare AI lane live; openai-ws is covered by mocked unit tests
  (`agent-processors.test.ts`) and was verified manually against deployed
  previews (streaming chunks), but no automated live-OpenAI e2e exists.
- **Worth restoring:** moderate — the openai-ws path is the production Slack
  path. An env-gated live test mirroring the cloudflare-ai one would close it.

### 4. Fresh-agent configuration e2e lanes

- **Was (main, `agents.itx.e2e.test.ts`):** "project processor configures
  fresh agent streams from child-stream-created", "project worker customizes
  fresh agents by appending events", "renders codemode completions as direct
  auto-triggering agent inputs".
- **Now:** partial equivalents only — a worker-subscriber e2e uses
  child-stream-created internally, and `agent-processors.test.ts` covers
  codemode-output-to-script-execution at the unit level.
- **Worth restoring:** moderate; the "project worker customizes fresh agents"
  lane is the extension point projects are expected to use.

### 5. ItxError contract tests

- **Was:** `apps/os/src/itx/errors.test.ts` (8 tests) + e2e assertions that
  kernel errors cross capnweb as ItxError-shaped errors with codes.
- **Now:** revoke/refusal behavior is e2e-tested, but no test pins an
  error-shape/code contract; the itx surface does not currently promise one.
- **Worth restoring:** only if/when itx re-adopts coded errors as contract.

### 6. Event-docs / docs-markdown surfaces

- **Was:** `apps/os/src/lib/{event-docs,event-docs-host,docs-markdown}.test.ts`
  and the `/docs` routes they covered.
- **Now:** the event-docs catalog UI has no equivalent (kill-list item); the
  example-events composer builds from live processor contract announcements.
- **Worth restoring:** no (product surface removed on purpose).

### 7. Legacy stream-browsing TUI tests

- **Was:** 7 unit files under `packages/iterate/src/stream-tui/` + the
  `stream-tui.spec.ts` browsing spec.
- **Now:** the rebuilt TUI is chat-only (Phase 10 decision); chat has a PTY
  round-trip spec + `data-layer-smoke.ts`.
- **Worth restoring:** no, unless the generic stream browser returns as a
  product feature.

## Removed WITH replacement (summary — details in the harness doc)

- Old itx scenario suites (`itx-egress`, `itx-subscribe`, `itx-openapi`,
  `itx-mcp-auth` fixture parts, old `itx.e2e.test.ts`) → `e2e/itx/**` suites.
- Legacy Slack unit suites (9 + 18 tests on main under
  `src/domains/slack/stream-processors/`) → `src/domains/integrations/
slack-processors.test.ts` (consolidated; case-by-case disposition tracked
  there) + the full-chain `e2e/itx/slack-agent.e2e.test.ts` (synthetic signed
  webhook → router → agent → LLM → egress audit).
- Google OAuth token refresh (`src/domains/secrets/oauth.test.ts`) →
  `src/domains/integrations/google-tokens.test.ts` (restored 2026-07-02 after
  the coverage audit).
- OpenAPI type derivation (`src/itx/capabilities/openapi-types.test.ts`) →
  `src/domains/itx/openapi-types.test.ts` (restored 2026-07-02; the
  `declare function` TS-declaration derivation cases are obsolete — itx
  capability `types` are caller-provided strings).
- `mcp-client-core.test.ts` → the MCP client is now inline in
  `src/rpc-targets.ts`; unit-level coverage folded into the e2e suites (which
  run in preview CI as of 2026-07-02).
- Ingress/router tests (`packages/shared/project-ingress.test.ts`,
  `src/workers/shared/router.test.ts`) → `src/ingress.test.ts` (broader) +
  `src/workers/ingress.test.ts`.
- Manual smoke docs (`docs/slack-smoke-testing.md`,
  `apps/os/docs/agent-smoke-testing.md`) survive but describe legacy
  internals in places; treat the itx e2e suites as the source of truth.

## Deleted with their subject (no behavior to preserve)

`extend()`/child contexts, facet-cap HTTP hosts, the legacy itx kernel
(`itx.test.ts`, `live-target.test.ts`), the legacy streams engine (~285
tests), `callable`/`durable-object-utils`/`type-tree`/`slug-maker` in
packages/shared, `itx-stream-subscribe` DO, the hosted reduce API in
streams-example-app. Reasoning: the subjects were deleted wholesale; their
replacements ship their own tests. Recover via the quarantine commit or
`main` as above.
