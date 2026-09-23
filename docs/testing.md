# Testing: Unit, E2E, And Playwright Specs

How the test lanes are organized, how to run each against any environment,
the canonical environment variables, and [the retry/timeout
policy](#retries-and-timeouts) every lane follows. For unit-test style (fake
timers, `test.for` tables with hand-written literal expectations), see
[Vitest patterns](vitest-patterns.md).

For cross-run timing analysis and the telemetry event/query contract, see
[CI and test telemetry](ci-test-telemetry.md). Every runner writes the same raw
artifact contract (not only retries); one always-running CI finalizer validates,
normalizes and retains Vitest hook/body/module/import timing and attempts as a
workflow artifact. PostHog delivery of those events is downsampled to zero
(`scripts/ci/posthog-events.ts`, since #2494): the artifacts are the record.

Run commands from the repository root unless stated otherwise.

| Command                                  | Coverage                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm typecheck`                         | Every retained workspace                                                     |
| `pnpm lint`                              | Source lint and applicable repository rules                                  |
| `pnpm format:check`                      | Formatting                                                                   |
| `pnpm knip`                              | Unused files, exports and dependencies (OS, Kit, shared, UI, SDK/CLI)        |
| `pnpm test`                              | Workspace unit tests, including OS unit and Workers projects                 |
| `pnpm e2e`                               | OS integration suite; local Worker unless a deployed target is configured    |
| `pnpm spec`                              | Root browser specs: one project per app host, plus the issuer at phone width |
| `pnpm --dir apps/kit firmware:test:host` | Firmware host tests                                                          |

> [!NOTE]
> A quarantined suite is called out here, in a CAUTION box naming the skip,
> its evidence and its restoration criteria, so nobody mistakes a hidden hole
> for coverage. No suite is quarantined today. The two boxes that stood here
> (Cloudflare Artifacts event delivery, the live-capability WebSocket mesh)
> described legacy `apps/os` suites that #2837 deleted.

## Philosophy

Six principles carry this system. They are conscious design — most trace
to specific people and incidents — and should be argued with, not drifted
away from.

1. **Prove the behavior users actually get.** The default test is e2e from
   very far away: through the itx surface (capnweb at `/api`, exactly like a
   production client) or a real browser, against a live deployment, with no
   test-only seams. The local e2e run already boots the real worker in
   workerd, so a live target is always one command away.

2. **Fail fast; fix the product, not the timeout.** (Misha Kaletsky's
   design — the [middlewright](https://github.com/iterate/middlewright)
   plugin family, extracted from this repo's test infra.) Playwright
   actions get a brutal ~1s budget that extends — up to ~30s — only
   while the app visibly reports progress (`data-spinner`). A slow flow
   that makes a test flaky is a product bug: add the loading state users
   wanted anyway. In his words: "it makes your test pass fast, fail fast,
   and it incentivises agents to improve the product when tests fail,
   instead of bumping timeouts which makes tests worse and lets your
   product get away with bad UX." Any explicit timeout override carries a
   `// comment` saying why (the `middlewright/require-timeout-comment` lint
   rule enforces it in specs, beside `prefer-locator-waits` and
   `prefer-positive-waits`). The root `specs/` harness sets the tight action
   budget and the spinner-waiter ([specs/AGENTS.md](../specs/AGENTS.md)).

3. **Every test owns its state.** Each e2e test mints its own project
   (`freshCtx` in `apps/os/e2e/support/client.ts`, carrying the run's id and
   the vitest worker's slot) and each spec stamps its own identities
   (`stamp()`). No shared fixtures, no ordering, no cleanup coupling — this
   is what makes parallel workers (and concurrent tests within an e2e file)
   and rule 4 sound.

4. **One retry, watchdogs above, telemetry always.** Retries live in
   exactly one layer (the individual test, CI only); everything above is
   a fail-never-retry watchdog sized to ~2× healthy p99; every absorbed
   retry is logged and recorded but does not make an otherwise-green
   ordinary PR run fail. A recurring or pathologically slow unrelated flake
   is explicitly quarantined and tracked instead of repeatedly taxing the
   critical path.
   Budgets are evidence, not vibes — see [Retries and
   timeouts](#retries-and-timeouts) and the marathon audit.

5. **Harnesses must be honest about fidelity.** Where we do unit-test,
   fakes implement the real interfaces (`memoryStream` in
   `apps/os/src/stream/test-support.ts` mirrors the Stream's commit
   semantics, idempotency at the door and the scanned-range proof; the fake
   git remote speaks real protocol v2 through the repo facet's own codecs),
   every processor with side effects has a re-reduce test (replaying the log
   runs no side effect twice), and a harness that structurally cannot catch
   a bug class says so in its file header — and names the test that can (the
   `cfartifacts.e2e.test.ts` header lists what the fake remote cannot prove).

6. **A test runtime earns its place.** Unit tests run in plain node; real
   runtime coverage comes from the e2e lane against the real worker (local
   workerd, or a live deployment — production-shaped by construction). The
   one extra runtime, the `workers` project (`@cloudflare/vitest-plugin`,
   `apps/os/__workers-tests__/`), exists for the proven gap: hibernation,
   eviction and alarm cases that need `cloudflare:test` controls no client
   can reach. Adding another runtime needs a proven coverage gap, not a
   preference.

## Lanes

The geography rule: `specs/` tests the product through a browser;
`<app>/e2e/` tests that deployable's own contract. Every e2e suite must be
wired to a CI lane or explicitly documented as manual — a tag filter or
unset env var that silently skips tests is the failure mode this table
exists to prevent (a `@preview` title filter once quietly reduced the
streams example app's CI coverage to 3 of ~37 tests while the rest rotted).

| Lane             | Command (repo root unless noted)                                | Lives in                                                                                             | In CI                                                                                                                                       | Proves                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | `pnpm test`                                                     | `apps/os/src/**/*.test.ts` (colocated), `apps/os/scripts/*.test.ts`, every workspace's own suite     | Depot **Test** workflow, every PR — full suite                                                                                              | In-process logic; no deployment needed.                                                                                                                                                                               |
| Workers          | `pnpm test` (`--project workers` in `apps/os`)                  | `apps/os/__workers-tests__/`, `apps/agents/__workers-tests__/`                                       | Depot **Test** workflow, every PR — full suite                                                                                              | Inside workerd next to the worker (Vite's built `dist/server/index.js` through `SELF.fetch`, never a source import): hibernation, eviction, alarms and pins that need `cloudflare:test` controls.                     |
| OS e2e           | `pnpm e2e`                                                      | `apps/os/e2e/*.e2e.test.ts`, `apps/agents/e2e/`                                                      | Preview OS **e2e** job, every preview deploy — full suite, against the PR's preview                                                         | One real worker (local workerd by default, the deployed worker with `WORKER_BASE_URL`), every file a capnweb client at `/api` exactly like a production client; files in parallel and tests within a file concurrent. |
| Playwright specs | `pnpm spec`                                                     | `specs/` (root `playwright.config.ts`, one project per app host: `os`, `os-phone`, `notes`, `suite`) | Preview OS **e2e** job — the `os`, `os-phone` and `suite` projects, side by side with OS e2e                                                | Browser-level product flows: issuer sign-in and consent (plus a phone-width project), the issuer's server functions, the project mini-app, and the Dash, Agents, Notes and Voice flows as they move into `specs/`.    |
| Notes specs      | `pnpm spec --project notes` (`NOTES_BASE_URL`, `DEMO_BASE_URL`) | `specs/notes/`                                                                                       | Preview OS **e2e** job, in the same `pnpm spec` run, against the preview's Notes app; a missing `NOTES_BASE_URL` fails in CI, skips locally | Sign in through the issuer, create a project, save a note and read it after reload, against the preview pair.                                                                                                         |
| Kit host         | `pnpm --dir apps/kit firmware:test:host` (part of Kit's `test`) | `apps/kit/firmware/tests/`                                                                           | Depot **Test** workflow, every PR (through `pnpm test`)                                                                                     | Firmware logic compiled for the host and run under CTest.                                                                                                                                                             |
| Dummy petshop    | `pnpm test` (its unit suite)                                    | `apps/dummy-petshop/src/`                                                                            | Depot **Test** workflow; the fixture itself deploys from `main` (Deploy dummy-petshop)                                                      | The OAuth/API fixture the OS secret and connection e2e rows dial (`PETSHOP_BASE_URL`, default `https://dummy-petshop.iterate.workers.dev`).                                                                           |
| Soak             | `pnpm --dir apps/os e2e:soak --runs N` (`WORKER_BASE_URL`)      | `apps/os/scripts/e2e-soak.ts`                                                                        | **Manual** — dispatch `os-next-e2e-soak.yml`; a measurement, not a gate                                                                     | The e2e suite N times against one deployed worker, tallying every row that did not pass every time.                                                                                                                   |
| Crash hunt       | `RUN_ISOLATE_CRASH_HUNT=1 pnpm e2e isolate-ceilings`            | `apps/os/e2e/isolate-ceilings-deployed.e2e.test.ts`                                                  | Nightly against prd (`os-next-crash-hunt.yml`); opt-in rows, so the preview run stays deterministic                                         | Drives one context's Durable Object up to and past its isolate ceiling on purpose.                                                                                                                                    |
| Bench            | `pnpm --dir apps/os bench` (`BENCH_OUT=<file.json>`)            | `apps/os/bench/`                                                                                     | **Manual**                                                                                                                                  | Latency scenarios over the same client and worker, files one at a time.                                                                                                                                               |

The normal Depot **Test** workflow runs `pnpm test` from the repo root. That
recursively runs every workspace's `test` script, including the `iterate` CLI,
Kit's host tests and dummy-petshop's unit suite. OS's `test`, `e2e` and
`bench` scripts run the Vite build first, so every lane tests the built
worker. Live tests belong to preview CI instead: the Preview OS workflow's
`e2e` job runs the OS e2e project and `pnpm spec` side by side against the
PR's preview (`apps/os/scripts/preview.ts` `runE2e`; it calls
`vitest run --project e2e` directly so the preview's built `dist/` stays
intact while Playwright runs), and only once that preview's deploy succeeded.
The OS e2e rows that talk to the petshop dial the deployed fixture; they
cannot silently skip back out of preview CI.

Any suite a CI lane does not run in full is a wiring bug unless the table names
its manual status. A test that genuinely cannot run against a given target
carries an explicit in-code skip with a named guard and a comment saying why,
so exclusion is always visible where the test lives: `deployedOnly`,
`localOnly` and `deployedSubdomainsOnly` in `apps/os/e2e/support/project-host.ts`
are the one gate each ("never copy the regex").

Smoke-testing a deployment: `apps/os/scripts/deploy.ts` probes the deployment
it just made (`/version`), the preview deploy waits for `/version` to name the
new deployment and for every client's `/healthz`, and production deployment
runs only those non-mutating readiness probes. The mutating suites run on the
isolated preview.

## What earns a test

The default is a covering e2e. A **unit test** earns its place in exactly
two ways:

- **Wide case tables.** Fold/reduce logic, parsers, pure functions — and
  above all stream processors: many event-ordering and redelivery cases
  that would be too slow or expensive to run e2e. These get purpose-built
  node harnesses (`apps/os/src/stream/test-support.ts`, driven by
  `processor-rules.test.ts`, `core-processor.test.ts` and
  `subscription-delivery.test.ts`).
- **Tiny kernels.** Zero-maintenance guards for adversarial and security
  invariants: a tampered payload or wrong signature fails HMAC verification,
  only a pinned origin receives a secret, `/secrets/..` never resolves onto a
  secret's own context, a refusal never names the credential. Small, hostile
  inputs, cheap to keep — these stay even though each one is thin.

### Ship-with rules

New work of these shapes ships WITH these tests. Absence is a review
blocker, not a style note:

| You built                                           | It ships with                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stream processor, or a new side-effect arm in one | A `memoryStream` harness suite including a **re-reduce test** (replay the log through a new version ⇒ zero repeated side effects, as `processor-rules.test.ts` "version bump re-reduce" does); if it holds obligations, an **eviction/abort** test in the Workers lane (`context-runs.test.ts` kills a context mid-run) |
| An itx capability or API surface                    | An e2e in `apps/os/e2e/` that exercises it through `/api` exactly like a production client, failure arms included; plus a Workers-lane row when it needs `cloudflare:test` controls                                                                                                                                     |
| A product flow in a first-party app                 | A Playwright spec under `specs/`, readable as a product spec                                                                                                                                                                                                                                                            |
| An incident fix with a log-shaped cause             | A repro of the captured event sequence as a harness case, named for the PR, red before the fix                                                                                                                                                                                                                          |

What we do NOT want:

- **Unit tests that re-assert another test's fixtures.** Example of the
  anti-pattern: a worker-build e2e edits the seeded template with
  exact-string anchors, and template edits kept breaking those anchors — the
  tempting "fix" was a unit test pinning the anchor strings so the breakage
  showed up in the fast lane. That test asserts nothing about behavior, only
  that two files agree, and every template edit now has to update it too.
  The e2e is the real check; the remedy at edit time is grepping for
  verbatim couplings, not a guard test.
- Unit tests for arg parsing of internal scripts, trivial glue, or anything
  a covering e2e already proves by existing.

## Shared preview setup

OS preview CI waits for the deployment to be live before starting either
Playwright or Vitest: the `deploy` job only succeeds once `/version` names the
new deployment and every client answers `/healthz`, and the `e2e` job only
starts after a successful deploy. This shared readiness time belongs to
CI setup, not individual test durations. Both suites run concurrently once
ready; browser installation overlaps the Vitest run. Playwright's worker count
and the case against sharding were measured, not guessed: #2659's study, run
on the legacy 88-test suite, settled on 24 workers and found that six-way
sharding lengthened the full preview run. Neither carried over to today's
smaller suite, which runs 6 workers in CI; measure again before changing it.

Each runner derives the deployed target itself, once, from the deployment's
own `APP_CONFIG` (parsed exactly as the worker parses it) and its `envs.ts`
entry (`apps/os/e2e/support/deployed-target.ts`): the Vitest suite in its
global setup, the specs in `playwright.config.ts`. The prepared values are
inherited by workers, including when running `pnpm spec` locally. Fixtures
read those settings synchronously and mint their own sessions. A missing
credential fails setup before tests start. A failed deploy or readiness probe
prevents both preview suites from starting.

## Test dimensions (DRAFT — under discussion)

Every test sits somewhere on five axes, and the rule mirrors the env-var
doctrine: **one control per dimension, no parallel mechanisms**, and the
vanilla `vitest` / `playwright` CLIs keep working. Dimensions are expressed
through file names, project selection, and environment presence — never a
bespoke runner.

| Dimension    | Values                                            | Controlled by                                                                                                                                                             | Status         |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Surface      | in-process / workerd / itx API / browser          | which lane you invoke (`pnpm test` / `pnpm e2e` / `pnpm spec`) + vitest `--project` (`unit`, `workers`, `e2e`, `bench`)                                                   | works today    |
| Speed        | fast / slow-by-contract                           | per-test `{ timeout }`; the long poles start first (`LONG_POLES` in `apps/os/vitest.config.ts`, hand-maintained from observed seconds)                                    | works today    |
| Determinism  | deterministic / retry-absorbed                    | `retry: CI ? 1 : 0` + retry telemetry — a nondeterministic test that retries is visible, never silent                                                                     | works today    |
| Cost         | free / pays for LLM turns                         | **gap** — implicit today (deployed stories that speak to the real model need `OPENAI_API_KEY` and skip without it; nothing else marks them)                               | proposal below |
| Remote reach | hermetic / hits a deployment / hits a third party | **partial** — `deployedOnly` / `localOnly` gate deployment reach; third-party reach is environment presence (`OPENAI_API_KEY`) or a deployed fixture (`PETSHOP_BASE_URL`) | proposal below |

Draft proposal for the two gaps, keeping vanilla CLIs:

- Put the **cost** dimension in the filename, the same way lanes already
  live there: `*.llm.e2e.test.ts` for tests that pay for model turns.
  Filename dimensions compose with plain vitest filtering
  (`pnpm e2e llm`), grep, and the sequencer — no runner machinery. A
  guard test can then enforce the budget structurally: files
  NOT tagged `.llm.` must not import the agent-turn helpers.
- Keep **third-party reach** on environment presence (the doppler-native
  control we already have); it composes with per-env secrets and skips
  cleanly when a config lacks the integration.
- Playwright's native tags (`@slow`, `--grep`) are the escape hatch on the
  specs side if a spec ever needs a dimension; don't build it until one
  does.

The free-and-deterministic alternative to paying for turns is shadowing the
AI root: `itx.ai` is Cloudflare's Workers AI binding under the reserved root,
so a test can `provide("itx.ai", fake)` a deterministic stub and the whole
path runs for real above it — the rewrite rules, the call chain, the result —
with the test scripting each response (Misha's test on the real root,
`apps/os/e2e/ai-root-shadow-and-fable.e2e.test.ts`). Locally the real binding
is never called; against a deployed worker the file's last row runs one real
inference. Reach for a paid `.llm.` test only when the point IS real-model
integration. (The `intercepted/*` model lane and its usage guide went with
the legacy platform in #2837.)

Open questions for the next grilling round: is the filename the right home
for cost (vs a lint-enforced import rule alone)? Should third-party reach
be visible in filenames too, or is env-gating enough? Does "slow" deserve
a filename marker so the sequencer stops needing hand-maintained observed
seconds?

## Running a lane against an environment

Every non-unit lane targets a live deployment and is invoked the same way:

```bash
doppler run --project project-worker --config <cfg> -- env WORKER_BASE_URL=<url> pnpm <lane>
```

The Doppler config supplies the deployment's own credentials — `APP_CONFIG`
and `APP_CONFIG_SECRETS__KEY`, parsed the way the worker parses them — and the
URL names the deployment; its routing and MCP origin come from the `envs.ts`
entry the URL falls under, so a per-PR preview inherits its parent's:

```bash
# local: no target — the suite boots the real worker in local workerd
pnpm e2e

# a PR preview (its URL is in the PR body)
doppler run --project project-worker --config preview -- \
  env WORKER_BASE_URL=https://pr<n>-<branch-slug>-os-next-preview.iterate-dev-preview.workers.dev pnpm e2e

# production
doppler run --project project-worker --config prd -- env WORKER_BASE_URL=https://os.iterate.com pnpm e2e
```

Specs take the same shape with `DEMO_BASE_URL`; without it Playwright starts
`pnpm dev` on `DEMO_PORT` (8788) and reuses an existing server locally. To run
both suites against a preview exactly as CI does, run
`pnpm preview e2e --pr <number> --name <branch>` from `apps/os` under the same
Doppler config. To point a lane at any other target, keep the Doppler
environment and set explicit overrides _inside_ it (`ADMIN_API_SECRET`,
`LOGIN_PASSWORD`, `PROJECT_INGRESS_ROUTING`, `MCP_BASE_URL` win over what
`APP_CONFIG` implies).

## Reaching the test runner from a deployed Worker

A deployed Worker cannot reach the runner's loopback: `127.0.0.1` belongs to
the Worker runtime, not the CI runner, and the platform answers 403. A fixture
the deployed worker must call is therefore either deployed itself (the dummy
petshop at `PETSHOP_BASE_URL`) or reached the other way round, over the
test's own WebSocket (a fake the test lends with `provide(...)` is called back
over capnweb). Rows that lend a loopback fixture — the fake git remote
(`apps/os/e2e/support/fake-git-server.ts`) — are `localOnly`. The Iterate
tunnels (`captun`, `withTunnel()`) that published local fixtures at a public
HTTPS URL went with the legacy platform in #2837.

## Environment variables

The rule: **one name per control, and no variable without a real setter**.
The deployment under test is described by its own `APP_CONFIG` from the
Doppler config and its `envs.ts` entry — tests never invent parallel names
for it. The Playwright config additionally honors the Playwright-conventional
`CI` and `VIDEO_MODE`.

| Variable                                            | Set by                                                      | Controls                                                                                                                                          | Default                                     |
| --------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `WORKER_BASE_URL`                                   | You, the preview script, the soak and crash hunt            | THE deployed worker for `pnpm e2e`, the soak and bench                                                                                            | Boot the real worker in local workerd       |
| `DEMO_BASE_URL`                                     | You, the preview script                                     | THE deployment for `pnpm spec` (and the issuer for the `notes` project)                                                                           | Local `pnpm dev` on `DEMO_PORT`             |
| `DEMO_PORT`                                         | You                                                         | Port for the local server Playwright starts                                                                                                       | `8788`                                      |
| `APP_CONFIG`, `APP_CONFIG_SECRETS__KEY`             | Doppler (`project-worker`, `preview` / `prd`)               | The deployed target's credentials and login (`deployed-target.ts`)                                                                                | None — deployed runs throw without them     |
| `ADMIN_API_SECRET`, `LOGIN_PASSWORD`                | You (explicit override)                                     | The admin bearer and sign-in password, instead of reading them out of `APP_CONFIG`                                                                | From `APP_CONFIG`                           |
| `PROJECT_INGRESS_ROUTING`, `MCP_BASE_URL`           | You (explicit override)                                     | Project routing and the MCP origin, instead of the `envs.ts` entry                                                                                | From `envs.ts`                              |
| `E2E_RUN_ID`                                        | Preview CI (`<run id>-<attempt>`), or you                   | The run's id, folded into every identifier a test mints                                                                                           | Minted once per run                         |
| `OPENAI_API_KEY`                                    | You / Doppler                                               | Deployed stories that speak to the real default model                                                                                             | Unset → those stories skip                  |
| `PETSHOP_BASE_URL`, `PETSHOP_BACKDOOR_SECRET`       | You                                                         | Which dummy petshop the secret and connection rows dial, and its backdoor credential                                                              | `https://dummy-petshop.iterate.workers.dev` |
| `NOTES_BASE_URL`                                    | The preview script, or you                                  | The Notes deployment the `notes` project signs in to                                                                                              | Unset → skipped locally, a failure in CI    |
| `DASH_BASE_URL`                                     | The preview script, or you                                  | The Dash deployment the Notes session specs sign in to, to end a Notes session                                                                    | Unset → skipped locally, a failure in CI    |
| `RUN_ISOLATE_CRASH_HUNT`                            | The crash-hunt workflow                                     | `"1"` opts in to the load-dependent isolate-ceiling rows                                                                                          | Unset → those rows skip                     |
| `BENCH_OUT`                                         | You                                                         | Writes the bench's raw samples as JSON                                                                                                            | Unset → no file                             |
| `FLAKE_RECORD_DIR`                                  | CI (Test workflow: `test-results/flake-records`)            | Where flake wrappers and retried plain tests append one JSON line per outcome                                                                     | Unset → nothing recorded                    |
| `TEST_TELEMETRY_ARTIFACT_FILE`                      | You                                                         | Optional named immediate canonical JSON copy                                                                                                      | Unset → no immediate copy                   |
| `TEST_TELEMETRY_ARTIFACT_DIR`                       | CI (Test workflow: `test-results/ci-telemetry/raw`), or you | Durable canonical JSON directory consumed by the always-running finalizer                                                                         | Unset → reporter does not write             |
| `TEST_TELEMETRY_KIND`                               | CI                                                          | Shared `unit`, `integration`, or `e2e` dimension                                                                                                  | Runner-appropriate default                  |
| `TEST_TELEMETRY_LANE`                               | CI                                                          | Shared lane dimension (`unit`, `vitest`, `playwright`, …)                                                                                         | Runner-appropriate default                  |
| `TEST_TELEMETRY_APP`, `TEST_TELEMETRY_PREVIEW_SLOT` | No setter today (the legacy preview orchestrator)           | Deployed application and preview dimensions; the preview e2e telemetry upload is the flake-tooling follow-up's                                    | Unset outside app e2e                       |
| `TEST_TELEMETRY_HEAD_SHA`                           | CI                                                          | Exact tested commit identity, including manually dispatched runs                                                                                  | Ambient `GITHUB_SHA`, then local HEAD       |
| `TEST_TELEMETRY_BRANCH`                             | CI                                                          | Exact tested source branch, including manually dispatched runs                                                                                    | Ambient GitHub head/ref name                |
| `TEST_TELEMETRY_PULL_REQUEST_NUMBER`                | CI                                                          | Exact selected PR identity for manually dispatched runs                                                                                           | Ambient pull-request ref, then unset        |
| `TEST_TELEMETRY_EXPECTED_WORKSPACES`                | CI finalizer                                                | Comma-separated unit workspaces that must each have emitted one runner artifact                                                                   | Unset → require at least one artifact       |
| `CI`                                                | Depot CI                                                    | One retry (Vitest e2e and Playwright), trace on first retry, 16 Vitest e2e workers and 6 Playwright workers, never reuse an existing server       | Unset locally                               |
| `VIDEO_MODE`                                        | You                                                         | `"1"` records spec demo videos — see [Video mode](#video-mode-recorded-spec-demos-for-prs)                                                        | No video                                    |
| `PLAYWRIGHT_SCREENSHOT`                             | You                                                         | Semicolon-separated regexes over `locator.toString()`; each matching successful action saves a full-page PNG (`specs/test-support/screenshot.ts`) | Unset → no screenshots                      |

## Artifacts

- **Every instrumented runner** atomically writes schema-validated JSON under
  `test-results/ci-telemetry/raw`. The finalizer
  (`scripts/ci/upload-test-telemetry.ts`) writes the normalized batch and
  manifest under `test-results/ci-telemetry/normalized`. Both remain in the
  uploaded workflow artifact (`unit-test-telemetry`) even when a test or
  delivery fails, next to `flake-records-unit`. See
  [CI and test telemetry](ci-test-telemetry.md) for replay and query examples.
- **The Vitest e2e suite** streams to the job log; the soak writes one JSON
  report per run under `apps/os/output/soak/` plus `summary.json`.
- **Playwright** writes the repo-level `test-results/`:
  `playwright-output/` per test (traces and screenshots retained on failure,
  videos in video mode or on local failures, `PLAYWRIGHT_SCREENSHOT`
  captures), the HTML report in `playwright-html/`, and
  `playwright-results.json`.
- **Preview CI** writes the deployed preview's summary to
  `apps/os/output/preview.json` and the URLs into the PR body. Its `e2e` job
  uploads `preview-test-telemetry` (the canonical telemetry of both runners)
  and the `flake-records-specs` and `flake-records-preview-e2e` artifacts,
  even when a suite fails.

## Where test helpers live

Four layers. A helper lives at the **lowest layer all its consumers share**,
and imports point **down** only. When both lanes need a helper, it moves down
a layer — never sideways into a copy.

| Layer                     | Home                                                                                                    | Charter                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L0 policy & infra         | `packages/shared/src/test-support/`                                                                     | Runner-agnostic: the retry policy and timeout ladder (`e2e-policy/budgets.ts`) and the retry telemetry reporter (`e2e-policy/`, both exported from `@iterate-com/shared/test-support/e2e-policy`), the CI telemetry contract (`ci-telemetry.ts`), flake records and suite summaries (`flake-record.ts`, `flake-suite-summary.ts`), and the `createFlake` / `createFailing` wrappers. |
| L1 environment & identity | `apps/os/scripts/` and `apps/os/e2e/support/deployed-target.ts`                                         | The deployment under test and who you are against it: dev server, build, deploy and preview lifecycle; the deployed target's credentials, routing and MCP origin out of `APP_CONFIG` and `envs.ts`. Consumed by both lanes' configs (and Notes').                                                                                                                                    |
| L2 surface clients        | `apps/os/e2e/support/` (itx surface) · `specs/test-support/` (browser surface)                          | Lane-specific clients and fixtures: admin itx sessions, fresh projects, principals and fakes on the itx side; signed-in browser sessions and page plugins on the Playwright side.                                                                                                                                                                                                    |
| L3 domain harnesses       | `apps/os/src/stream/test-support.ts`, `apps/os/__workers-tests__/support.ts`, colocated with the domain | Unit- and Workers-lane fakes implementing real interfaces (`memoryStream`, node-SQLite Durable Object storage); never imported by L2 or above.                                                                                                                                                                                                                                       |

Anti-goal: one mega test-support package. That would drag itx clients and
credential machinery into a package that production workers import; the
layers keep the credentialed, lane-specific pieces at the edges that need
them. The "lowest shared layer" rule is also deliberately lazy — e.g.
`until` in `apps/os/e2e/support/client.ts` stays L2 until a Playwright
spec actually needs it: "needed by both lanes" is proven by a consumer, not
predicted.

## Data fixtures with regenerable outputs

A committed output that is computed from source is checked for freshness by
a plain run, and regenerated by one command — never edited by hand. The
reference today is the Agents template bundle: `apps/agents`'s `test` script
starts with `runtime:check`, which rebuilds `configs-next/with-agents/agents.js`
from `apps/agents/runtime/` and fails if the committed file differs; refresh
with:

```bash
pnpm --dir apps/agents runtime:build
```

The generated route trees follow the same rule (`routes:check` runs in each
app's `typecheck`; `routes:generate` refreshes). The pattern reference this
section used to name — `apps/os/src/domains/agents/prompt-scenarios/`, one
markdown file per scenario with input events, output fences computed by the
real prompt fold, and an `annotations.yaml` fence the harness re-wove into
regenerated outputs (`pnpm vitest run prompt-scenarios -u`) — went with the
legacy platform in #2837. Bring that shape back for the next fixture whose
outputs a reviewer should read.

## Video mode: recorded spec demos for PRs

Any Playwright spec re-runs as a watchable demo — pointer highlights on every
action, dead air compressed, the blank startup lead-in trimmed. Design and
plugin by Misha: [middlewright](https://github.com/iterate/middlewright)'s
`videoMode`, wired in `specs/test-support/test.ts`; the auto start-trim
shipped in iterate/middlewright#3 / PR #1788.

```bash
# local dev, one flow (the config auto-starts the dev server)
VIDEO_MODE=1 pnpm spec -g "consent"

# against a deployed preview — note --project project-worker: the repo root
# scopes to _shared, which lacks the APP_CONFIG the specs derive credentials from
doppler run --project project-worker --config preview -- \
  env DEMO_BASE_URL=<preview url> VIDEO_MODE=1 pnpm spec -g "consent"
```

`VIDEO_MODE=1` flips two things:

- **Config** (`playwright.config.ts`): `video: "on"`, recorded at each
  project's own viewport (1280×900 desktop; the phone project at its device
  size). The budgets do not relax: the action budget is one number, video
  mode included, and `e2e-policy/budgets.ts` says why (video mode's runtime
  cost is one screenshot per click; the pointer animation and holds are
  post-production).
- **Plugin** (`videoMode` in `specs/test-support/test.ts`): records each
  action's bounding box during the run, then post-renders with ffmpeg:
  pointer highlights, dead-air spans >300ms sped up, `test.step` captions, a
  final hold (default 1s; `finalHold` is in milliseconds), and the blank
  `about:blank`-to-first-paint lead-in trimmed
  automatically (`trimStart: "auto"`, pixel-based; an explicit
  `page.videoMode.setStartTime()` in a spec still wins).

The post-render needs an `ffmpeg` on `PATH` with the `ass` (libass) filter,
which draws the captions. Homebrew's `ffmpeg` lacks it; install `ffmpeg-full`,
which is keg-only, and put it first on `PATH`:

```bash
brew install ffmpeg-full
export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
```

Output lands under `test-results/playwright-output/<test-title-dir>/`:
`video-rendered.webm` (the demo), `video-raw.webm` (middlewright's copy of
Playwright's own `video.webm`, which sits beside it), a `video-mode.html`
frame-stepper and `video-mode-report.html`, all also attached to the HTML
report.

**Getting the video into a PR description is manual** — the "automatic" part
is only the recording/trimming. GitHub renders an inline video player only
for `user-attachments` URLs, and only its web editors mint those (`<video>`
tags pointing at any other host are sanitised — which is why older PRs fell
back to release-asset GIFs, e.g. PR #1764):

1. Upload `video-rendered.webm` through a github.com editor: drag or paste it
   into the PR-description editor, or attach it in any comment editor and
   clear the comment WITHOUT submitting — the asset is already permanent.
   Agents can point a browser-automation `file_upload` at the editor's file
   input. GitHub accepts `.webm`, `.mp4` and `.mov`;
   `ffmpeg -i video-rendered.webm demo.mp4` gives the widest playback support.
2. GitHub inserts a `https://github.com/user-attachments/assets/…` URL — put
   it on its own line in the body, with blank lines above and below, and it
   renders as an inline player. There is no API or `gh` route for this
   upload. PR #1788's before/after clip is the working example; [Pull
   requests](pull-requests.md#video) has the command that checks the player
   rendered.

## Retries and timeouts

Every number and retry knob in the test system follows five rules. The
constants live in **`packages/shared/src/test-support/e2e-policy/budgets.ts`**
(one file, exported from `@iterate-com/shared/test-support/e2e-policy`; #2881
restored it). The root `playwright.config.ts` imports it; today
`apps/os/vitest.config.ts` still carries its own numbers (the ladder below
shows both), and `scripts/preview/e2e-policy.test.ts`,
which guarded the invariants — including the files that can't import
TypeScript constants (shell) — went with the legacy preview in #2837. The
evidence behind the rules is the 50-consecutive-green-run marathon audit in
[preview-e2e-flake-hunt.md](preview-e2e-flake-hunt.md) (~5,800 test
executions: ~0.5% of tests needed their single retry, none ever needed a
second, and every mechanism above the test layer either never fired or fired
only on genuine infra wedges).

1. **Retries live in exactly one layer: the individual test.** The test is
   the smallest unit that owns its state — every e2e test and every spec
   provisions its own project — so it is the
   cheapest genuinely independent trial. `E2E_CI_RETRIES = 1` in CI, zero
   locally, everywhere: retrying anything larger re-runs minutes of healthy
   work to re-roll one six-second dice.
2. **Everything above a test is a watchdog: it fails, it never retries.**
   A whole Depot job has `timeout-minutes`. Re-running a
   killed run is the outer edge's job (the Depot re-run button, the next
   push) — never automatic.
3. **Watchdogs are sized to ~2× the healthy p99 of what they bound — never
   to accommodate worst-case retry stacks.** A run burning retries against a
   wedged platform _should_ get killed; both historical watchdog kills were
   genuine infra wedges where retrying was hopeless. The per-lane kill-tree
   watchdogs went with `scripts/preview/` in #2837; today's only watchdogs
   above a test are the Depot jobs' `timeout-minutes`, which are looser than
   this rule asks.
4. **Waits are progress-based; static budgets are backstops.** The
   Playwright `actionTimeout` is tight; the
   [middlewright](https://github.com/iterate/middlewright) spinner-waiter
   extends it — up to ~30s — only while the
   app visibly reports progress. An app that goes blank fails fast instead
   of being slept through: this exact tightness caught a real blank-render
   product bug (flake 21). Don't widen budgets to paper over a missing
   loading state. In Vitest, poll for a condition (`expect.poll`, `until`)
   instead of sleeping.
5. **Retries are measured, never silent.** With one retry, a
   5%-probability real race turns a run red about once in 400 runs — but
   shows up in retry telemetry about once in 20. The count is the detector;
   see below.

### The ladder

| What it bounds             | Knob                             | Policy (`budgets.ts`)                             | In force today                                                     | On expiry                 |
| -------------------------- | -------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| One UI action              | `actionTimeout` + spinner-waiter | `SPEC_ACTION_TIMEOUT_MS` 1s (→ ~30s with spinner) | the policy value (root `playwright.config.ts` imports it)          | fail the attempt          |
| One assertion              | `expect.timeout`                 | `SPEC_EXPECT_TIMEOUT_MS` 15s                      | the policy value                                                   | fail the attempt          |
| One Playwright spec        | `timeout`                        | `SPEC_TEST_TIMEOUT_MS` 240s                       | the policy value                                                   | retry once (CI)           |
| One Vitest e2e test/hook   | `testTimeout` / `hookTimeout`    | `E2E_TEST_TIMEOUT_MS` 120s                        | 60s / 120s (`apps/os/vitest.config.ts`, `e2e`)                     | retry once (CI)           |
| A heavy test               | per-test `{ timeout }`           | capped at `E2E_HEAVY_TEST_TIMEOUT_MS` 240s        | per test, with a `// comment`                                      | retry once (CI)           |
| A retry's pause            | vitest `retry.delay`             | `E2E_CI_RETRY_DELAY_MS` 5s                        | `createFailing`'s retries; the e2e project retries without a pause | n/a                       |
| One Workers-lane test/hook | `testTimeout` / `hookTimeout`    | —                                                 | 120s / 120s (the first test pays workerd boot)                     | fail                      |
| One bench file             | `testTimeout` / `hookTimeout`    | —                                                 | 300s                                                               | fail                      |
| Each preview sub-lane      | `timeout N <lane command>`       | `OS_PREVIEW_LANE_TIMEOUT_SECS` 480s               | none: the kill-tree wrapper went with `scripts/preview/`           | **fail — never retry**    |
| One whole preview run      | run watchdog                     | `PREVIEW_RUN_WATCHDOG_SECS` 600s                  | none                                                               | **cancel — never retry**  |
| The Depot CI job           | `timeout-minutes`                | —                                                 | Test 20, preview deploy 40, preview e2e 30 minutes                 | outer edge: re-run button |

`budgets.ts` also still carries `OS_AGENT_SMOKE_TIMEOUT_SECS`,
`OS_TUI_LANE_TIMEOUT_SECS`, `TUI_TEST_TIMEOUT_MS` and
`PREVIEW_RUN_PROOF_BUDGET_SECS` for lanes that went with the legacy platform.

The ladder is strictly ordered, and a new knob keeps it that way. Note the
deliberate rule-3 consequence: no watchdog budgets for a test double-burning
its timeout.

### Retry telemetry

An attempt that fails and then passes on its one permitted retry does **not**
make the ordinary PR run fail or block an unrelated PR. It remains useful
reliability telemetry and must stay visible. A stability marathon has a
different acceptance contract: any absorbed retry stops the streak so it can
be diagnosed, even though the same test outcome remains green in normal CI.

- **Run log**: every workspace's `test` script loads the Vitest
  `RetryTelemetryReporter` (`packages/shared/src/test-support/e2e-policy/`),
  which prints `[retry-telemetry] N test(s) needed retries: ...`. Vitest
  records retain the first failed attempt's compact error even when the retry
  passes. Grep any run log for `retry-telemetry`. The OS `e2e` script does not
  load the reporter yet; Playwright's `list` reporter marks retried specs.
- **CI**: the Test workflow's runners write canonical telemetry to the
  durable directory, and the finalizer keeps it as the `unit-test-telemetry`
  artifact. A plain test that failed and then passed on its CI retry also gets
  a `kind: "unknown"` flake record (below). Folding preview retries into the
  PR body and a `::notice::` / `::warning::` annotation (at four or more
  retries in one run, which may indicate a deployment-wide incident rather
  than independent flakes) was the legacy preview orchestrator's; it returns
  with the preview e2e telemetry upload.
- **Volume**: probabilistic regressions need run volume to detect — that is
  what the on-demand soak is for (`os-next-e2e-soak.yml`, or
  `pnpm --dir apps/os e2e:soak --runs N` with `WORKER_BASE_URL`: N sequential
  runs of the e2e suite against one deployed worker). It names every row that
  did not pass every time: a row that fails once in a hundred is a flake; a
  row that fails every time is a bug.

When telemetry trends up without failures, investigate it. If the test is
repeatedly flaky or adds disproportionate tail latency, use the quarantine
protocol below instead of repeatedly making unrelated PRs pay for it.

### Flaky-test quarantine protocol

A flaky or pathologically slow test may be quarantined only after the current
change is shown not to cause its failure. Failures on behavior changed by the
PR remain ordinary blockers. For an unrelated test, the protocol is:

1. Record the test name, first-attempt error, run link or artifact, and timing.
2. Wrap it with `createFlake` (next section), passing the one error pattern the
   flake produces. The test stays green, keeps running on every branch, and
   keeps reporting its outcomes — the flake rate stays measured, and the
   recorded data is what later proves the test deserves unwrapping.
3. State in the PR description that an unrelated flake was found and wrapped.

Skipping is the exception, not the protocol. Fall back to an explicit skip
only when the test cannot safely or affordably keep executing:

- running it harms the rest of the suite (side effects — e.g. the
  live-capability mesh e2e that cancelled the shared OS isolate and severed
  19 unrelated sessions);
- the flake manifests as a genuine hang, which has no error to pattern-match
  (`createFlake` deliberately treats a hang as red);
- the cost is the runtime itself (pathological tail latency), or the whole
  lane is broken.

The skip path carries extra obligations precisely because it produces no
data: the narrowest explicit `test.skip`/`fixme` (or a clearly logged no-op
for an entire broken lane) — never a title filter, deleted discovery entry,
extra retry, or swallowed error — plus a `parked:` comment with the evidence
and a `revisit by` date ([below](#parked-tests-expire)), a tracking issue
with the evidence, impact, investigation work, and concrete exit criteria,
and a prominent call-out in the PR description and at the top of this doc.

Once the remaining CI is green, either form of quarantine is explicit
coverage debt, not a reason to keep the unrelated PR open indefinitely.

### Flakes and pinned failures

Two wrappers in `packages/shared/src/test-support` register through the runner's own expected-fail variant (Vitest `test.fails`, Playwright `test.fail`) and let exactly one error pattern through:

- `createFlake(test, /pattern/)` ([flake-test.ts](../packages/shared/src/test-support/flake-test.ts)) marks a known flake. The body asserts real behavior. A pass or a failure matching the pattern is green, any other failure or a hang is red, and the test is never retried: one sample per run.
- `createFailing(test, /pattern/)` ([failing-test.ts](../packages/shared/src/test-support/failing-test.ts)) pins a known bug. The body asserts the desired behavior and must fail with the pattern. A pass (the bug looks fixed) or a different failure is red. A bare `test.fails` behind a guard that returns early on the wrong failure does the same job.

Every outcome of either wrapper, and every plain test that failed and then passed on its CI retry (an unknown flake, with the first attempt's error), is one JSON line in `FLAKE_RECORD_DIR`. The CI finalizer (`scripts/ci/upload-test-telemetry.ts --flake-suites <unit|preview>`) adds each suite's `suite-summary.json`, and the job uploads `flake-records-<suite>` artifacts. The [flake dashboard](https://github.com/iterate/iterate/issues/2580) folds them every 15 minutes (`.depot/workflows/flake-dashboard.yml`), writing the issue as the iterate GitHub App. Local runs without the variable record nothing.

Each suite carries a monthly `flake sentinel`: a `createFlake` test that throws its allowed error about 10% of the time until its month ends. A sentinel that reads 0% or goes red means the pipeline is broken. When its month ends, roll the date forward instead of unwrapping it.

The two subsections below are the full contract.

### Pinned bugs: `createFailing(test, …)`, not bare `test.fails`

For a KNOWN bug held open on purpose, wrap the runner's own test function
with `createFailing` from `@iterate-com/shared/test-support/failing-test` — it
works for vitest and playwright alike, passing fixtures and options through:

```ts
const fail = createFailing(test, /SAME-BOOT STALENESS/);
fail("a userspace facet rebuilds on a source commit", { timeout: 240_000 }, async () => {
  // asserts the DESIRED behavior; today it throws the matched error
});
```

`createFailing` registers through the runner's own expected-fail variant
(vitest `test.fails`, playwright `test.fail`), so pins report natively —
the "expected fail" summary count and telemetry's expected state need no
extra plumbing. The wrapper filters WHICH failure satisfies that machinery:
the body must fail matching the pattern. A different failure, a success, or
a body still running after the wrapper's 30s deadline all come back as
"success", which the expected-fail machinery rejects — red, with the actual
reason in the adjacent `[failing-test]` log line. (A bare `test.fails`
stays silently green in all three cases.) A pin that legitimately runs
longer raises the deadline via `options.timeoutMs`, kept below the runner's
test timeout. Write the body so the bug throws a distinctive message, and
so conditions that prove nothing (a coincidental restart masking the bug
for one observation) retry instead of succeeding — the legacy
`userspace-facet-source-version.e2e.test.ts` was the worked example; its
`test.fails` predecessor false-alarmed 7+ times.

### Known-flaky tests: `createFlake(test, …)`

For a test that is genuinely flaky — sometimes passes, sometimes fails, and
always with the SAME error — wrap it with `createFlake` from
`@iterate-com/shared/test-support/flake-test` instead of skipping it:

```ts
const flake = createFlake(test, /CPU startup time exceeded \d+ms/);
flake("Worker can be deployed", async () => {
  const deployment = await system.deploy();
  await expect.poll(() => fetch(deployment.url)).toMatchObject({ status: 200 });
});
```

Like `createFailing`, it registers through the runner's expected-fail variant, but
the contract differs: a pass and a failure matching the one allowed pattern
are both green; anything else — a different error, or a body still running at
the wrapper's deadline — is red. The test keeps running on every branch and,
when `FLAKE_RECORD_DIR` is set (CI), appends each outcome as a JSON line for
the flake dashboard, so the flake rate stays measured instead of hidden.

The lifecycle is wrapper-switching, driven by that data: a test that seems
flaky moves to `createFlake`; if it stops passing entirely, switch it to
`createFailing`; once it passes consistently, unwrap it back to a plain test.
`packages/shared/src/test-support/flake-sentinel.test.ts` is a deliberately
~10%-flaky sentinel that proves the pipeline works — if its flake rate reads
0%, distrust the dashboard, not the sentinel.

Every suite carries its own sentinel (the unit sentinel above,
`flake sentinel (specs)` in `specs/flake-sentinel.spec.ts`, and
`flake sentinel (e2e)` in `apps/os/e2e/flake-sentinel.e2e.test.ts`) — distinct names, so each
gets its own dashboard row and a suite whose row reads 0% has broken
recording/ingestion plumbing, not a healthy month.

The dashboard also surfaces flakes nobody has classified: a PLAIN test that
failed and then passed on a CI retry gets a `kind: "unknown"` record from the
telemetry reporters (see `packages/shared/src/test-support/flake-record.ts`),
error text included. Those rows are the adoption funnel — the "Unknown
flakes" section of the dashboard shows the error samples to turn into a
`createFlake` pattern, and once wrapped, the same test name migrates into the
Flakes section. `createFailing` pins record too (`pinned-fail` /
`unexpected-pass`), so the Failures section shows how long each pin has stood
and proposes deleting wrappers whose bugs look fixed. The Test workflow
uploads the records as `flake-records-unit`; the dashboard that folded them
was a starter app on the legacy platform, and re-homing it is tracked
separately.

For playwright specs, `createFlake` REPLACES retries — but only for tests
that opted in by being wrapped. A matched flake is green on the first
attempt (no retry consumed, no retry-until-pass shrinking the measured
rate); unwrapped specs keep the suite's ordinary retry policy.

This IS the quarantine protocol (previous section): a skipped test produces
no data, so nothing can ever prove it deserves to come back. Skips remain
only for tests that cannot keep executing at all.

### Parked tests expire

A skip/fixme/todo marker that parks a KNOWN issue is a loan against the
suite, and it carries its terms in a comment on (or right above) the marker:

```ts
// parked: <what is broken, with evidence> — revisit by 2026-11-15
test.skip("…", () => {});
```

Markers without a date are for **structural** reasons only:
platform- or env-gated suites that cannot run in a given context (the
mini-app spec skips on a deployment that routes projects by paths, because it
dials a subdomain — that is a property of the target, not a parked bug).

[`lint/dated-skips.test.ts`](../lint/dated-skips.test.ts) enforces this in the
unit lane (`pnpm test`): it scans the test corpus for skip/fixme/todo markers
and **fails on any `revisit by` date in the past**, printing the file and the
parked reason. An expired date is a decision point, not a nag to bump: fix and
un-park the test, or renew the date with the reason re-argued. Undated markers
must be allowlisted in that guard with a note; the allowlist holds structural
gates only and never grows to excuse a parked bug. `test.fails` is not a
marker: it runs, and turns red once the bug it pins is fixed.

The Depot Test workflow runs workspace tests and keeps their normalized
telemetry as a job artifact. Production deployment runs only its deploy
script's readiness probes. The Preview OS workflow deploys a per-PR platform
and all five hosted clients, then runs integration and browser tests.
Operational changes require coherent preview state and telemetry as well as
passing tests; see the [engineering invariant](engineering-invariants.md).
