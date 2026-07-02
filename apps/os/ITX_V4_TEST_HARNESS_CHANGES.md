# itx-v4 migration — e2e test harness changes (vitest + Playwright)

Companion to `ITX_V4_MIGRATION_REPORT.md` and the removals-without-replacement record (`docs/removed-test-coverage-itx-v4.md`): every change the migration made to
test wiring, harnesses, and helpers, why, and what was lost. The guiding rules
were locked in the plan: **keep ALL existing Playwright infrastructure intact**
(config, middlewright plugins, forged-session fixture pattern, webServer flow),
**tests are URL-driven e2e only** (vite dev server or deployed worker), and
**quarantine over delete** (catalogued, excluded from configs, restorable).

## What did NOT change

- `playwright.config.ts`, the middlewright plugins (spinner-waiter, video
  mode), the webServer flow, and `specs/test-support/test.ts` (the `helpers`
  fixture): **zero diff vs main**.
- `packages/shared/src/test-support/vitest-e2e/` (the vitest-artifacts
  machinery: per-run temp roots full of logs, run slugs): untouched; both os
  vitest e2e configs still use it, and CI still uploads `/tmp/os-e2e-*`,
  `/tmp/os-itx-e2e-*`, and `test-results/` (artifact.ci check green).
- `.github/ts-workflows/` (workflow generation, artifact upload): zero diff.
  `scripts/preview/` changed in exactly one place (see "Restored after the
  audit"): the preview test lane's `pnpm e2e -t "OS preview smoke"` became an
  unfiltered `pnpm e2e`, so the command now runs the full OS e2e suite → itx
  examples matrix (node project) → full root `pnpm spec` against the deployed
  slot.
- Existing spec bodies: `dashboard.spec.ts` and `reactivity.spec.ts` untouched;
  `repl-examples.spec.ts` / `forged-session-repl.spec.ts` changed by exactly
  one locator (`{ name: "Run", exact: true }` — generated project slugs
  containing "run" substring-matched sidebar buttons under strict mode).

## Root Playwright (`specs/`)

| File                             | Change                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-support/forged-session.ts` | `createAdminProject` re-pointed from the legacy `withItx({token})` client to itx's `connectItx({auth: {type:"admin-secret"}})`; the `project.processor.onStateChange` phase-"ready" poll was deleted (itx `projects.create` resolves only after the bootstrap saga committed); disposal is a no-op until itx project removal lands (task #13). JWT forging unchanged. | The fixture's _internals_ had to follow the surface; the fixture _pattern_ (mint claims, seed cookie, `await using`) is unchanged. In-file comments record what the legacy code did.                                                        |
| `signup.spec.ts` (new)           | Real email-OTP signup (OTP 424242) via `test-support/email-otp-signup.ts`; env-gated skip where the lane is disabled.                                                                                                                                                                                                                                                 | Goal-1 coverage. Deliberately NOT the forged-session fixture — the flow under test is real signup.                                                                                                                                          |
| `create-project.spec.ts` (new)   | Fresh real user → UI form → onboarding chat page.                                                                                                                                                                                                                                                                                                                     | Goal-2 coverage. A forged session can't refresh its access token to pick up the new project claim, so this uses a real session; it exercises the stale-claims directory path end-to-end (it caught the broken service-token `bySlug` lane). |
| `agent-chat.spec.ts` (new)       | `helpers.createFixture` → onboarding feed → LLM reply asserted via `agent-feed-message[data-kind]` testids.                                                                                                                                                                                                                                                           | Goal-3 coverage, house style, generous-but-bounded LLM timeouts.                                                                                                                                                                            |

New-spec deviations from suite defaults are commented in-file (per-call
spinner-waiter disables where pending states render two spinner-matching
elements; a 240s budget for two LLM turns).

## OS vitest e2e (`apps/os/e2e/`)

- **New `e2e/itx/` suites** (ported from minimal-itx-v4's black-box e2e):
  streams, stream-security, project-ingress, itx, stream-lifecycle +
  `test-helpers.ts`/`setup.ts`/`itx-capability-fixtures.ts` and the
  `onboarding-smoke.ts` operational smoke. They run inside the existing
  `e2e/vitest.config.ts` project (its `include` gained
  `./e2e/itx/**/*.e2e.test.ts` + a setup file that resolves
  `ITX_BASE_URL` from the dev-server discovery file). URL-driven, admin-secret
  authenticated; worker-hosted fixtures are served by the deployed api worker
  (`/__itx_e2e/…`), replacing minimal's `verify-miniflare` lane per the plan.
- **`test-support/os-client.ts` / `create-test-project.ts`**: same factory +
  `await using` disposable conventions, internals swapped to the itx client
  (`connectItx`, explicit credential objects instead of a bearer token param).
  Project disposal is a documented no-op until itx project removal exists.
- **`agents.itx.e2e.test.ts`** split: the provider-toggle half became
  `agent-tools.itx.e2e.test.ts` (agent drives a script appending a proof
  event); the Slack half is quarantined (returns with Phase 12).
- **`workspace-itx-preview-example.ts`** (MCP SDK client proof): rewritten from
  the deleted workspaces domain (gitClone/write/commit/push) to
  `repo.commitFiles` + an idempotent identical re-commit as the read-back.
- **tui-test lane**: rewritten for the rebuilt chat TUI — `stream-tui.spec.ts`
  is now a chat round-trip through a real PTY; new `data-layer-smoke.ts` runs
  the full headless loop (create → subscribe → greeting → pong).

## itx examples matrix (`apps/os/e2e/examples/`)

- `examples-matrix.e2e.test.ts` + `example-matrix.ts` rewritten for the itx surface;
  every catalogue example runs identically across **five runtimes**: browser
  (vitest browser project / Playwright REPL spec), node, **cli** (spawned
  `tsx scripts/cli.ts itx run` parsing its single JSON stdout — restored once
  the CLI moved onto itx), run-script (`project.runScript`), and
  project-worker (examples baked into the project's repo `worker.js`). The
  "runnable example must have a case" invariant and the browser-mode harness
  are kept.
- Coexistence-era `ITX_API_PATH=/api/itx-next` plumbing was removed everywhere
  when itx took over `/api/itx`.

## Quarantine folders (now deleted)

During the migration, legacy suites were quarantined into
`test-quarantine/` folders (apps/os old-surface itx scenario suites,
streams-example-app's reduce-RPC test, packages/iterate's legacy
stream-browsing TUI tests) instead of being deleted, so later phases could
restore anything still needed. At the very end — after all phases landed and
their replacements were verified — the quarantine folders were deleted
(commit `551f172b7`). Everything in them is recoverable from git history at
that commit; the coverage disposition is catalogued in the sections below.

## Deleted test lanes (the honest losses)

- **The workers-pool lane is gone.** `test:streams-workers`
  (`@cloudflare/vitest-pool-workers` over the legacy streams implementation's DO tests:
  idle-teardown, redial, host-idle-disconnect adversarial suites) and the
  `src/durable-objects/*` config-per-file lanes (`itx-stream-subscribe`,
  `codemode-session`, `project-ingress`) died with their subjects. itx
  deliberately has **no in-workerd unit lane** — the plan locked "URL-driven
  e2e only, no separate wrangler-dev lane". Equivalent _behavioral_ coverage
  lives in `e2e/itx/` (stream lifecycle/security/ingress against real
  deployments), but in-process DO-internals testing (fake timers around
  alarms, forced socket drops) has no direct replacement. If that class of
  test is missed, the recoverable reference is in git history at the purge
  commit.
- **Legacy unit tests deleted with their subject** (~285 tests:
  stream-processor machinery, review-regression suites, slack/agent processor
  units). itx brought its own unit tests (in `src/**`) and the
  e2e suites above; `pnpm test` in apps/os is now 154 unit tests + the e2e
  lanes.
- **`packages/shared` test lanes** for callable/durable-object-utils deleted
  with those trees (`test:callable`, `test:durable-object-utils*` and their
  vitest configs, including the DO-utils e2e alchemy deployment harness).
- **Real third-party MCP interop.** The old `itx-mcp-auth.e2e.test.ts` proved
  the MCP client against Cloudflare's real remote servers
  (`docs.mcp.cloudflare.com` — real streamable-HTTP, real 401 semantics) and
  included a journal negative-control (the full event journal never contains
  the substituted token). The replacement suites test auth-substitution
  mechanics against in-repo fixtures only. An env-gated live smoke + a
  journal-scan assertion would restore parity.
- **Live-OpenAI provider e2e.** The provider-toggle e2e exercises the
  Cloudflare AI lane live; openai-ws is covered by mocked unit tests
  (`agent-processors.test.ts`) plus the deployed-preview streaming smoke, not
  by a dedicated live e2e.
- **Fresh-agent configuration lanes** from the old `agents.itx.e2e.test.ts`
  ("project processor configures fresh agent streams from
  child-stream-created", "project worker customizes fresh agents by appending
  events") have only partial equivalents (worker-subscriber e2e +
  `agent-processors.test.ts` codemode unit).
- **ItxError contract tests.** The legacy kernel asserted error codes/shapes
  crossing capnweb; itx revokes/refusals are e2e-tested behaviorally but no
  test pins an error-shape contract.

## Restored after the audit (2026-07-02)

- `src/domains/integrations/google-tokens.test.ts` — Google token refresh
  (stored-token fast path, refresh + AES-GCM persistence) re-seamed onto the
  integrations domain.
- `src/domains/itx/openapi-types.test.ts` — operation flattening, $ref
  resolution, body-schema splitting; plus a refusal-shape assertion in the
  OpenAPI e2e (the self-describing `— valid params: …` tail was found dropped
  in the port and restored).
- The preview CI lane now runs the FULL apps/os e2e suite (`pnpm e2e`, no
  title filter), so the itx/streams/ingress/slack-agent suites run on every
  preview deploy again — this had silently narrowed to the "OS preview smoke"
  when the old `e2e:itx` scenario files were deleted. Dead
  `OS_ITX_E2E_EGRESS_CONCURRENT`/`OS_ITX_E2E_LIVE_CONCURRENT` flags removed.

## Net CI shape (unchanged contract, new contents)

`pnpm test` (unit) → `pnpm e2e` (preview smoke + itx suites + agent-tools) →
`pnpm e2e:examples` (matrix) → root `pnpm spec` (21 specs) — all green locally and
in PR CI against the deployed preview, with vitest-artifacts run roots and
Playwright traces uploaded as CI artifacts.
