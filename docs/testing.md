# Testing: Unit, E2E, And Playwright Specs

How the test suites are organized, how to run each against any environment,
the canonical environment variables, and [the retry/timeout
policy](#retries-and-timeouts) every suite follows. For unit-test style (fake
timers, `test.for` tables with hand-written literal expectations), see
[Vitest patterns](vitest-patterns.md).

For the test telemetry artifact contract, see
[CI and test telemetry](ci-test-telemetry.md). Every runner writes the same raw
artifact (not only retries); one always-running CI finalizer checks that every
expected runner left one, and the job retains them, with Vitest hook, body,
module and import timing and Playwright attempts, as a workflow artifact.
Nothing per test goes to PostHog (#2494): the artifacts are the record.

Run commands from the repository root unless stated otherwise.

| Command                                  | Coverage                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm typecheck`                         | Every tracked TypeScript file but the config templates in `configs` (JavaScript) |
| `pnpm lint`                              | Source lint and applicable repository rules                                      |
| `pnpm format:check`                      | Formatting                                                                       |
| `pnpm knip`                              | Unused files, exports and dependencies in every workspace                        |
| `pnpm test`                              | Workspace unit tests, including OS unit and Workers projects                     |
| `pnpm e2e`                               | OS integration suite; local Worker unless a deployed target is configured        |
| `pnpm spec`                              | Root browser specs: one project per app host, plus the issuer at phone width     |
| `pnpm --dir apps/kit firmware:test:host` | Kit firmware host tests (needs cmake; not part of `pnpm test`)                   |

`pnpm lint` and `pnpm lint:fix` run oxlint on one thread: at one per core every JS worker starts its
own type-aware service, and a 16-core machine hits spawn ENOMEM. At 4, 8 and 12 threads it was no
faster.

> [!NOTE]
> A quarantined suite is called out here, in a CAUTION box naming the skip,
> its evidence and its restoration criteria, so nobody mistakes a hidden hole
> for coverage. No suite is quarantined today.

## Philosophy

Six principles carry this system. They are conscious design — most trace
to specific people and incidents — and should be argued with, not drifted
away from.

1. **Prove the behavior users actually get.** The default test is e2e from
   very far away: through the itx surface (capnweb at `/api`, exactly like a
   production client) or a real browser, against a live deployment, with no
   test-only hooks. The local e2e run already boots the real worker in
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
   `packages/iterate/src/stream/test-support.ts` mirrors the Stream's commit
   semantics, idempotency at append and the scanned-range proof; the fake
   git remote speaks real protocol v2 through the repo facet's own codecs),
   every processor with side effects has a re-reduce test (replaying the log
   runs no side effect twice), and a harness that structurally cannot catch
   a bug class says so in its file header — and names the test that can (the
   `cfartifacts.e2e.test.ts` header lists what the fake remote cannot prove).

6. **A test runtime earns its place.** Unit tests run in plain node; real
   runtime coverage comes from the e2e suite against the real worker (local
   workerd, or a live deployment — production-shaped by construction). The
   one extra runtime, the `workers` project (`@cloudflare/vitest-plugin`,
   `apps/os/__workers-tests__/`), exists for the proven gap: hibernation,
   eviction and alarm cases that need `cloudflare:test` controls no client
   can reach. Adding another runtime needs a proven coverage gap, not a
   preference.

## Suites

The geography rule: `specs/` tests the product through a browser;
`<app>/e2e/` tests that deployable's own contract. Every e2e suite must be
wired to a CI job or explicitly documented as manual — a tag filter or
unset env var that silently skips tests is the failure mode this table
exists to prevent (a `@preview` title filter once quietly reduced the
streams example app's CI coverage to 3 of ~37 tests while the rest rotted).

| Suite            | Command (repo root unless noted)                                   | Lives in                                                                                                      | In CI                                                                                                                                        | Proves                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit             | `pnpm test`                                                        | `apps/os/src/**/*.test.ts` (colocated), `apps/os/scripts/*.test.ts`, every workspace's own suite              | Depot **Test** workflow, every PR — full suite                                                                                               | In-process logic; no deployment needed.                                                                                                                                                                                                          |
| Workers          | `pnpm test` (`--project workers` in `apps/os`)                     | `apps/os/__workers-tests__/`, `apps/agents/__workers-tests__/`                                                | Depot **Test** workflow, every PR — full suite                                                                                               | Inside workerd next to the worker (Vite's built `dist/server/index.js` through `exports.default.fetch`, never a source import): hibernation, eviction, alarms and pins that need `cloudflare:test` controls.                                     |
| OS e2e           | `pnpm e2e`                                                         | `apps/os/e2e/*.e2e.test.ts`, `apps/agents/e2e/`                                                               | Preview OS **e2e** job, every preview deploy, against the PR's preview; rows tagged `slow` only when it turns them on or edits one           | One real worker (local workerd by default, the deployed worker with `WORKER_BASE_URL`), every file a capnweb client at `/api` exactly like a production client; files in parallel and tests within a file concurrent.                            |
| Playwright specs | `pnpm spec`                                                        | `specs/` (root `playwright.config.ts`, one project per app host: `os`, `os-phone`, `notes`, `voice`, `suite`) | Preview OS **e2e** job, every project, side by side with OS e2e; `notes` and `voice` against the preview's Notes and Voice apps              | Browser-level product flows: issuer sign-in and consent (plus a phone-width project), the issuer's server functions, the project mini-app, and the Notes and Voice flows.                                                                        |
| Notes specs      | `pnpm spec --project notes` (`NOTES_BASE_URL`, `DEMO_BASE_URL`)    | `specs/notes/`                                                                                                | Preview OS **e2e** job, in the same `pnpm spec` run, against the preview's Notes app; a missing `NOTES_BASE_URL` fails in CI, skips locally  | Save a note and read it after reload, signed in by the fixture (`createFixture(…, { app })`); Notes sessions on its own origin, ended in the Dash, against the preview pair.                                                                     |
| Main e2e         | `pnpm preview deploy`, then `e2e`, `--name main` (`apps/os`)       | The OS e2e and Playwright suites above                                                                        | **Main OS e2e** (`main-os-e2e.yml`), every main push to the preview paths, beside Deploy OS; pages #error-pulse when main turns red or green | The same suites, every row, against main's own preview, `main`, the pushed commit redeployed to it in place ([why](depot-ci.md#main-os-e2e-keeps-one-preview)).                                                                                  |
| Slow rows        | `pnpm preview e2e --slow-rows only` (`apps/os`)                    | Rows tagged `slow`, `scripts/ci/main-e2e-alert.ts`                                                            | **Main OS e2e**, every main push, with every other row; pages #error-pulse on their own change of state. On a PR, only when turned on        | The residency rows that wait out real quiet minutes: a careless facet stops a quiet minute after its last call, and after its claim ends ([slow rows](#slow-rows)).                                                                              |
| Kit host         | `pnpm --dir apps/kit firmware:test:host` (needs cmake)             | `apps/kit/firmware/tests/`                                                                                    | Depot **Test** workflow, every PR (its own step after `pnpm test`)                                                                           | Firmware logic compiled for the host and run under CTest.                                                                                                                                                                                        |
| Kit ESP builds   | `node apps/kit/scripts/firmware-release.ts build …`                | `apps/kit/firmware/targets/`, `apps/kit/scripts/firmware-release.ts`                                          | **Kit Firmware** workflow, firmware PRs and main (not required)                                                                              | Builds each changed board with ESP-IDF (active), checks its flash layout, its inputs and an unchanged tree; main publishes the releases.                                                                                                         |
| Dummy petshop    | `pnpm test` (its unit suite)                                       | `apps/dummy-petshop/src/`                                                                                     | Depot **Test** workflow; the fixture itself deploys from `main` (Deploy dummy-petshop)                                                       | The OAuth/API fixture the OS secret and connection e2e rows dial (`PETSHOP_BASE_URL`, default `https://dummy-petshop.iterate.workers.dev`).                                                                                                      |
| Soak             | `pnpm --dir apps/os e2e:soak --runs N` (`WORKER_BASE_URL`)         | `apps/os/scripts/e2e-soak.ts`                                                                                 | **Manual** — dispatch `os-e2e-soak.yml`; a measurement, not a gate                                                                           | The e2e suite N times against one deployed worker, each run followed by the perf budgets, tallying every row that did not pass every time; never a real model.                                                                                   |
| Perf budgets     | `pnpm --dir apps/os perf` (`WORKER_BASE_URL`)                      | `apps/os/perf/*.perf.test.ts`, every metric and budget in `apps/os/perf/latency.ts`                           | The latency guard below; every soak run, after the e2e suite                                                                                 | Latency and throughput budgets over the same client and worker, measured alone: files one at a time, rows in order, each budget on the median of its rounds (p95 where a run has dozens).                                                        |
| Latency guard    | Dispatch `os-latency.yml` (`--input budget-scale=0.01` test-pages) | `.depot/workflows/os-latency.yml`, `scripts/ci/os-latency-guard.ts`                                           | **OS latency**, every 3 hours, beside everything (nothing waits on it); pages #error-pulse                                                   | The perf suite against main's own preview `latency`, in place: every metric to PostHog (`os latency measured`), paged red once when it crossed its budget or a sharp regression on its rolling baseline two runs in a row, green once when back. |
| Real model       | Dispatch `os-real-model.yml`                                       | `REAL:` rows (`realModelOnly`), `.depot/workflows/os-real-model.yml`, `scripts/ci/main-e2e-alert.ts`          | **OS real model**, daily and every main push to the agents runtime, on its own preview; pages #error-pulse                                   | The turns every other run gives a fake provider, against real models: OpenAI's astra (the default) and Workers AI accept the request and answer. [Real-model rows](#real-model-rows).                                                            |
| Crash hunt       | `RUN_ISOLATE_CRASH_HUNT=1 pnpm e2e isolate-ceilings`               | `apps/os/e2e/isolate-ceilings-deployed.e2e.test.ts`                                                           | Nightly against prd (`os-crash-hunt.yml`); opt-in rows, so the preview run stays deterministic                                               | Drives one context's Durable Object up to and past its isolate ceiling on purpose.                                                                                                                                                               |
| Bench            | `pnpm --dir apps/os bench` (`BENCH_OUT=<file.json>`)               | `apps/os/bench/`                                                                                              | **Manual**                                                                                                                                   | Latency scenarios over the same client and worker, files one at a time.                                                                                                                                                                          |

The normal Depot **Test** workflow runs `pnpm test` from the repo root. That
recursively runs every workspace's `test` script, including the `iterate` CLI,
Kit's and dummy-petshop's unit suites. Kit's firmware host tests are a separate
step of the same job (`pnpm --dir apps/kit firmware:test:host`), so `pnpm test`
runs on machines without cmake; that step runs even when `pnpm test` fails.
OS's `test`, `e2e` and `bench` scripts run the Vite build first, so every suite
tests the built worker. Live tests belong to preview CI instead: the Preview OS workflow's
E2E tests job runs the OS e2e project and its Browser specs job `pnpm spec`, side by side against
the PR's preview (`apps/os/scripts/preview.ts` `runSuite`; E2E tests runs `pnpm e2e:run`, which
skips the build), and both fail rather than skip when that preview's deploy did not succeed.
The OS e2e rows that talk to the petshop dial the deployed fixture; they
cannot silently skip back out of preview CI.

Any suite a CI job does not run in full is a wiring bug unless the table names
its manual status. A test that genuinely cannot run against a given target
carries an explicit in-code skip with a named guard and a comment saying why,
so exclusion is always visible where the test lives: `deployedOnly`,
`localOnly`, `deployedSubdomainsOnly` and `realModelOnly` in
`apps/os/e2e/support/project-host.ts` are the one gate each ("never copy the regex").

Smoke-testing a deployment: `apps/os/scripts/deploy.ts` probes the deployment
it just made (`/version`), the preview deploy waits for `/version` to name the
new deployment and for every client's `/healthz`, and production's deploy runs
only those non-mutating readiness probes plus a read-only check of the project
hosts (`scripts/ci/prd-post-deploy-check.ts`). The mutating suites run on
isolated previews: the PR's, and Main OS e2e's own preview, redeployed with
each main push.

## What earns a test

The default is a covering e2e. A **unit test** earns its place in exactly
two ways:

- **Wide case tables.** Fold/reduce logic, parsers, pure functions — and
  above all stream processors: many event-ordering and redelivery cases
  that would be too slow or expensive to run e2e. These get purpose-built
  node harnesses (`iterate/stream/test-support`, driven by the SDK's
  `processor-rules.test.ts`; `apps/os/src/stream/test-support.ts` adds the
  real Stream for `core-processor.test.ts` and `subscription-delivery.test.ts`).
- **Tiny kernels.** Zero-maintenance guards for adversarial and security
  invariants: a tampered payload or wrong signature fails HMAC verification,
  only a pinned origin receives a secret, `/secrets/..` never resolves onto a
  secret's own context, a refusal never names the credential. Small, hostile
  inputs, cheap to keep — these stay even though each one is thin.

### Ship-with rules

New work of these shapes ships WITH these tests. Absence is a review
blocker, not a style note:

| You built                                           | It ships with                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A stream processor, or a new side-effect arm in one | A `memoryStream` harness suite including a **re-reduce test** (replay the log through a new version ⇒ zero repeated side effects, as `processor-rules.test.ts` "version bump re-reduce" does); if it holds obligations, an **eviction/abort** test in the Workers suite (`context-runs.test.ts` kills a context mid-run) |
| An itx capability or API surface                    | An e2e in `apps/os/e2e/` that exercises it through `/api` exactly like a production client, failure arms included; plus a Workers-suite row when it needs `cloudflare:test` controls                                                                                                                                     |
| A product flow in a first-party app                 | A Playwright spec under `specs/`, readable as a product spec                                                                                                                                                                                                                                                             |
| An incident fix with a log-shaped cause             | A repro of the captured event sequence as a harness case, named for the PR, red before the fix                                                                                                                                                                                                                           |

What we do NOT want:

- **Unit tests that re-assert another test's fixtures.** Example of the
  anti-pattern: a worker-build e2e edits the seeded template with
  exact-string anchors, and template edits kept breaking those anchors — the
  tempting "fix" was a unit test pinning the anchor strings so the breakage
  showed up in the fast suite. That test asserts nothing about behavior, only
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
on an earlier 88-test suite, settled on 24 workers and found that six-way
sharding lengthened the full preview run. Neither carried over to today's
smaller suite, which runs 6 workers in CI; measure again before changing it.

Each runner derives the deployed target itself, once, from the deployment's
own `APP_CONFIG` (parsed exactly as the worker parses it) and its `envs.ts`
entry (`apps/os/e2e/support/deployed-target.ts`): the Vitest suite in its
global setup, the specs in `specs/setup.ts`. The prepared values are
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

| Dimension    | Values                                            | Controlled by                                                                                                                          | Status         |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Surface      | in-process / workerd / itx API / browser          | which suite you invoke (`pnpm test` / `pnpm e2e` / `pnpm spec`) + vitest `--project` (`unit`, `workers`, `e2e`, `bench`)               | works today    |
| Speed        | fast / slow-by-contract                           | per-test `{ timeout }`; the long poles start first (`LONG_POLES` in `apps/os/vitest.config.ts`, hand-maintained from observed seconds) | works today    |
| Determinism  | deterministic / retry-absorbed                    | `retry: CI ? 1 : 0` + retry telemetry — a nondeterministic test that retries is visible, never silent                                  | works today    |
| Cost         | free / pays for model inference                   | `realModelOnly` (opt-in `E2E_REAL_MODELS=1`, `REAL:` titles); other runs fake the provider ([real-model rows](#real-model-rows))       | works today    |
| Remote reach | hermetic / hits a deployment / hits a third party | **partial** — `deployedOnly` / `localOnly` gate deployment reach; third-party reach is a deployed fixture (`PETSHOP_BASE_URL`)         | proposal below |

Draft proposal for the remaining gap, keeping vanilla CLIs:

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
inference. Reach for a `realModelOnly` row only when the point IS real-model
integration.

Open questions for the next grilling round: should third-party reach
be visible in filenames too, or is env-gating enough? Does "slow" deserve
a filename marker so the sequencer stops needing hand-maintained observed
seconds?

## Real-model rows

An agent's turn goes to a real model only in the daily real-model suite. Every
other run (PR previews, Main OS e2e, local runs, the soak) plays the provider
with a fake: the test shadows the agent's `itx.ai`
(`support.provide("itx.ai", fake)`), so the whole deployed runtime still runs
above it (the turn loop, the attachment turned into a vision input, the byte
transport, the chunk windows, the settlement and the context report), the fake
asserts what the runtime asked for (the model, the Responses API request, the
image part, the AI Gateway options), and nothing is spent.

- **Why.** Every model call on the preview account goes through one AI Gateway,
  `default`, whose spend limit rules include a gateway-wide daily cap
  (`iterate-gateway-daily`, a sliding 24 hours). A request past it answers
  HTTP 429 with code 2045, "Spend limit exceeded". On 2026-09-24 a day of
  100-run soaks spent the cap (1,164 astra turns, about $30), and from then on
  every PR's preview e2e timed out on the two default-model rows.
- **What runs where.** `apps/agents/e2e/agents-default-model.e2e.test.ts` runs
  the default model's turn and its vision turn against the fake in every run.
  Its `REAL:` rows (the same two turns on OpenAI's astra, and a pinned Workers
  AI model seeing the image) and the `REAL:` row of
  `apps/os/e2e/ai-root-shadow-and-fable.e2e.test.ts` are `realModelOnly`: they
  run only with `E2E_REAL_MODELS=1`, which only `os-real-model.yml` sets, once a
  day and on main pushes to `configs/with-agents/agents/**`. The soak strips the
  variable.
- **What it costs.** An astra turn is about $0.026 (about 2,100 input tokens,
  most of them the system prompt), so a real-model run is about $0.06: about
  $0.06 a day, plus about $0.06 per main push to the agents runtime. The Workers
  AI rows cost fractions of a cent and do not pass the gateway.
- **When the cap is spent anyway.** A real-model row fails at once, naming the
  cap and the gateway's message (`answeredLog` in `apps/agents/e2e/fixtures.ts`),
  instead of timing out: exhaustion is not a flake, and no retry inside a row
  outlasts the window. The gateway's logs
  (`GET /accounts/<id>/ai-gateway/gateways/default/logs`) show what spent it.

## Running a suite against an environment

Every non-unit suite targets a live deployment and is invoked the same way:

```bash
doppler run --project os --config <cfg> -- env WORKER_BASE_URL=<url> pnpm <suite>
```

The Doppler config supplies the deployment's own credentials — `APP_CONFIG`
and `APP_CONFIG_SECRETS__KEY`, parsed the way the worker parses them — and the
URL names the deployment; its routing and MCP origin come from the `envs.ts`
entry the URL falls under, so a per-PR preview inherits its parent's:

```bash
# local: no target — the suite boots the real worker in local workerd
pnpm e2e

# a PR preview (its URL is in the PR body)
doppler run --project os --config preview -- \
  env WORKER_BASE_URL=https://pr<n>-os.iterate-dev-preview.workers.dev pnpm e2e

# production
doppler run --project os --config prd -- env WORKER_BASE_URL=https://os.iterate.com pnpm e2e
```

Specs take the same shape with `DEMO_BASE_URL`; without it Playwright starts
`pnpm dev` on `DEMO_PORT` (8788) and reuses an existing server locally. To run
both suites against a preview exactly as CI does, run
`pnpm preview e2e --pr <number> --name <branch>` and `pnpm preview specs` with
the same flags from `apps/os` under the same Doppler config; `--slow-rows run|skip|only` picks the
e2e rows tagged `slow` ([slow rows](#slow-rows)). A deployed target is always described by its own `APP_CONFIG`
and its `envs.ts` entry; there are no per-run credential overrides.

## Reaching the test runner from a deployed Worker

A deployed Worker cannot reach the runner's loopback: `127.0.0.1` belongs to
the Worker runtime, not the CI runner, and the platform answers 403. A fixture
the deployed worker must call is therefore either deployed itself (the dummy
petshop at `PETSHOP_BASE_URL`) or reached the other way round, over the
test's own WebSocket (a fake the test lends with `provide(...)` is called back
over capnweb). Rows that lend a loopback fixture — the fake git remote
(`apps/os/e2e/support/fake-git-server.ts`) — are `localOnly`.

## Environment variables

The rule: **one name per control, and no variable without a real setter**.
The deployment under test is described by its own `APP_CONFIG` from the
Doppler config and its `envs.ts` entry — tests never invent parallel names
for it. The Playwright config additionally honors the Playwright-conventional
`CI` and `VIDEO_MODE`.

| Variable                                      | Set by                                                      | Controls                                                                                                                                          | Default                                     |
| --------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `WORKER_BASE_URL`                             | You, the preview script, the soak and crash hunt            | THE deployed worker for `pnpm e2e`, the soak and bench                                                                                            | Boot the real worker in local workerd       |
| `DEMO_BASE_URL`                               | You, the preview script                                     | THE deployment for `pnpm spec` (and the issuer for the `notes` project)                                                                           | Local `pnpm dev` on `DEMO_PORT`             |
| `DEMO_PORT`                                   | You                                                         | Port for the local server Playwright starts                                                                                                       | `8788`                                      |
| `APP_CONFIG`, `APP_CONFIG_SECRETS__KEY`       | Doppler (`os`, `preview` / `prd`)                           | The deployed target's credentials and login (`deployed-target.ts`)                                                                                | None — deployed runs throw without them     |
| `E2E_RUN_ID`                                  | Preview CI (`<run id>-<attempt>`), or you                   | The run's id, folded into every identifier a test mints                                                                                           | Minted once per run                         |
| `PETSHOP_BASE_URL`, `PETSHOP_BACKDOOR_SECRET` | You                                                         | Which dummy petshop the secret and connection rows dial, and its backdoor credential                                                              | `https://dummy-petshop.iterate.workers.dev` |
| `NOTES_BASE_URL`                              | The preview script, or you                                  | The Notes deployment the `notes` project signs in to                                                                                              | Unset → skipped locally, a failure in CI    |
| `VOICE_BASE_URL`                              | The preview script, or you                                  | The Voice deployment the `voice` project signs in to                                                                                              | Unset → skipped locally, a failure in CI    |
| `DASH_BASE_URL`                               | The preview script, or you                                  | The Dash deployment the Notes session specs sign in to, to end a Notes session                                                                    | Unset → skipped locally, a failure in CI    |
| `RUN_ISOLATE_CRASH_HUNT`                      | The crash-hunt workflow                                     | `"1"` opts in to the load-dependent isolate-ceiling rows                                                                                          | Unset → those rows skip                     |
| `E2E_REAL_MODELS`                             | The real-model suite (`os-real-model.yml`)                  | `"1"` opts in to the `realModelOnly` rows, which pay for a real inference; the soak strips it                                                     | Unset → those rows skip                     |
| `E2E_SLOW_ROWS`                               | Main OS e2e (`run`), a Preview OS dispatch, you             | Which rows tagged `slow` `pnpm preview e2e` runs: `run`, `skip`, `only` (alone); vitest then holds each row to its timeout ceiling                | Unset → the PR's paths and label            |
| `BENCH_OUT`                                   | You                                                         | Writes the bench's raw samples as JSON                                                                                                            | Unset → no file                             |
| `FLAKE_RECORD_DIR`                            | CI (the Test workflow; the preview script, per suite)       | Where flake wrappers and retried plain tests append one JSON line per outcome                                                                     | Unset → nothing recorded                    |
| `TEST_TELEMETRY_ARTIFACT_FILE`                | You                                                         | Optional named immediate canonical JSON copy                                                                                                      | Unset → no immediate copy                   |
| `TEST_TELEMETRY_ARTIFACT_DIR`                 | CI (Test workflow: `test-results/ci-telemetry/raw`), or you | Durable canonical JSON directory consumed by the always-running finalizer                                                                         | Unset → reporter does not write             |
| `TEST_TELEMETRY_KIND`                         | CI                                                          | Shared `unit`, `integration`, or `e2e` dimension                                                                                                  | Runner-appropriate default                  |
| `TEST_TELEMETRY_SUITE`                        | CI                                                          | Shared suite dimension (`unit`, `vitest`, `playwright`, …)                                                                                        | Runner-appropriate default                  |
| `TEST_TELEMETRY_APP`                          | No setter today                                             | The deployed application dimension                                                                                                                | Unset                                       |
| `TEST_TELEMETRY_HEAD_SHA`                     | CI                                                          | Exact tested commit identity, including manually dispatched runs                                                                                  | Ambient `GITHUB_SHA`, then local HEAD       |
| `TEST_TELEMETRY_BRANCH`                       | CI                                                          | Exact tested source branch, including manually dispatched runs                                                                                    | Ambient GitHub head/ref name                |
| `TEST_TELEMETRY_PULL_REQUEST_NUMBER`          | CI                                                          | Exact selected PR identity for manually dispatched runs                                                                                           | Ambient pull-request ref, then unset        |
| `TEST_TELEMETRY_EXPECTED_WORKSPACES`          | CI finalizer                                                | Comma-separated workspaces that must each leave a runner artifact (preview jobs; Test uses `--expect-unit-workspaces`)                            | Unset → require at least one artifact       |
| `CI`                                          | Depot CI                                                    | One retry (Vitest e2e and Playwright), trace on first retry, 16 Vitest e2e workers and 6 Playwright workers, never reuse an existing server       | Unset locally                               |
| `VIDEO_MODE`                                  | You                                                         | `"1"` records spec demo videos — see [Video mode](#video-mode-recorded-spec-demos-for-prs)                                                        | No video                                    |
| `PLAYWRIGHT_SCREENSHOT`                       | You                                                         | Semicolon-separated regexes over `locator.toString()`; each matching successful action saves a full-page PNG (`specs/test-support/screenshot.ts`) | Unset → no screenshots                      |

## Artifacts

- **Every instrumented runner** atomically writes schema-validated JSON under
  `test-results/ci-telemetry/raw`. The finalizer
  (`scripts/ci/upload-test-telemetry.ts`) writes `manifest.json` beside them.
  Both remain in the uploaded workflow artifact (`unit-test-telemetry-attempt-<id>`,
  one per job attempt) even when a test fails, next to
  `flake-records-unit-attempt-<id>`. See
  [CI and test telemetry](ci-test-telemetry.md) for downloading and checking one.
- **The test evidence folder**: `test-results/` is one test run's evidence.
  After the finalizer, `scripts/ci/test-evidence.ts write` adds one row per
  test (`tables/tests.parquet`) and `manifest.json` (the run's result, the
  tested commit and tree, the job attempt, the deployed target in the e2e
  jobs, and every file's sha256). Kit's CTest writes its JUnit XML there too.
  Then `upload` puts the folder in the `iterate-ci` R2 bucket; the step's
  log and the job's summary give its prefix. [Test evidence](test-evidence.md).
- **The Vitest e2e suite** streams to the job log; the soak writes one JSON
  report per run under `apps/os/output/soak/` plus `summary.json`.
- **Playwright** writes the repo-level `test-results/`:
  `playwright-output/` per test (traces and screenshots retained on failure,
  videos in video mode or on local failures, `PLAYWRIGHT_SCREENSHOT`
  captures), the HTML report in `playwright-html/`, and
  `playwright-results.json`.
- **Preview CI** writes the deployed preview's summary to
  `apps/os/output/preview.json` and the URLs into the PR body. Its `e2e` job
  uploads `preview-test-telemetry` (the canonical telemetry of both runners),
  the `flake-records-specs` and `flake-records-preview-e2e` artifacts, the
  Playwright HTML report (`public-playwright-report`) and all of
  `test-results/` (`preview-os-test-artifacts`: failed specs' traces,
  screenshots and error context), even when a suite fails. All but the HTML
  report end in `-attempt-<id>`, so a retried job keeps the failed attempt's
  ([per job attempt](depot-ci.md#artifacts-per-job-attempt)). Fetch them with
  `depot ci artifacts` ([Depot CI](depot-ci.md#browser-reports-from-artifacts)).

## Where test helpers live

Four layers. A helper lives at the **lowest layer all its consumers share**,
and imports point **down** only. When both suites need a helper, it moves down
a layer — never sideways into a copy.

| Layer                     | Home                                                                                                                                                   | Charter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0 policy & infra         | `packages/shared/src/test-support/`                                                                                                                    | Runner-agnostic: the retry policy and timeout ladder (`e2e-policy/budgets.ts`, exported as `@iterate-com/shared/test-support/e2e-policy`) and the retry telemetry reporter (`e2e-policy/retry-telemetry-reporter.ts`), the CI telemetry contract (`ci-telemetry.ts`), flake records and suite summaries (`flake-record.ts`, `flake-suite-summary.ts`), the `createFlake` / `createFailing` wrappers, and `listenOnFetchSafePort` (`fetch-safe-port.ts`), a loopback listener fetch and browsers will connect to. |
| L1 environment & identity | `apps/os/scripts/` and `apps/os/e2e/support/deployed-target.ts`                                                                                        | The deployment under test and who you are against it: dev server, build, deploy and preview lifecycle; the deployed target's credentials, routing and MCP origin out of `APP_CONFIG` and `envs.ts`. Consumed by both suites' configs.                                                                                                                                                                                                                                                                            |
| L2 surface clients        | `apps/os/e2e/support/` (itx surface) · `specs/test-support/` (browser surface)                                                                         | Suite-specific clients and fixtures: admin itx sessions, fresh projects, principals and fakes on the itx side; signed-in browser sessions and page plugins on the Playwright side.                                                                                                                                                                                                                                                                                                                               |
| L3 domain harnesses       | `packages/iterate/src/stream/test-support.ts`, `apps/os/src/stream/test-support.ts`, `apps/os/__workers-tests__/support.ts`, colocated with the domain | Unit- and Workers-suite fakes implementing real interfaces (`memoryStream`, node-SQLite Durable Object storage); never imported by L2 or above.                                                                                                                                                                                                                                                                                                                                                                  |

Anti-goal: one mega test-support package. That would drag itx clients and
credential machinery into a package that production workers import; the
layers keep the credentialed, suite-specific pieces at the edges that need
them. The "lowest shared layer" rule is also deliberately lazy — e.g.
`until` in `apps/os/e2e/support/client.ts` stays L2 until a Playwright
spec actually needs it: "needed by both suites" is proven by a consumer, not
predicted.

## Data fixtures with regenerable outputs

A committed output that is computed from source is checked for freshness by
a plain run, and regenerated by one command — never edited by hand. The
generated route trees follow this rule (`routes:check` runs in each
app's `typecheck`; `routes:generate` refreshes). For a fixture whose outputs a
reviewer should read, use one markdown file per scenario: the inputs, fences
of generated output, and an annotations fence the harness weaves back in when
it regenerates on `-u`.

## Video mode: recorded spec demos for PRs

Any Playwright spec re-runs as a watchable demo — pointer highlights on every
action, dead air compressed, the blank startup lead-in trimmed. Design and
plugin by Misha: [middlewright](https://github.com/iterate/middlewright)'s
`videoMode`, wired in `specs/test-support/test.ts`; the auto start-trim
shipped in iterate/middlewright#3 / PR #1788. middlewright is experimental and
maintained by us, so fix its issues upstream; until a release is published to
npm by hand, the root `package.json` pins a pkg.pr.new build of it.

```bash
# local dev, one flow (the config auto-starts the dev server)
VIDEO_MODE=1 pnpm spec -g "consent"

# against a deployed preview — note --project os: the repo root
# scopes to _shared, which lacks the APP_CONFIG the specs derive credentials from
doppler run --project os --config preview -- \
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
is only the recording/trimming. Ship `video-rendered.webm` through a github.com
editor, as [Pull requests](pull-requests.md#video) describes, with the command
that checks the player rendered. PR #1788's before/after clip is the working
example.

## Retries and timeouts

Every number and retry knob in the test system follows five rules. The shared
constants live in **`packages/shared/src/test-support/e2e-policy/budgets.ts`**
(exported from `@iterate-com/shared/test-support/e2e-policy`): the root
`playwright.config.ts` imports its spec budgets and CI retry count, and
`apps/os/vitest.config.ts` its CI retry count; the Vitest timeouts are set in
that config (the ladder below). The
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
   genuine infra wedges where retrying was hopeless. Today the only watchdogs
   above a test are the Depot jobs' `timeout-minutes`, which are looser than
   this rule asks.
4. **Waits are progress-based; static budgets are backstops.** The
   Playwright `actionTimeout` is tight; the
   [middlewright](https://github.com/iterate/middlewright) spinner-waiter
   extends it — up to ~30s — only while the
   app visibly reports progress. An app that goes blank fails fast instead
   of being slept through: this exact tightness caught a real blank-render
   product bug (flake 21, [flake hunt](preview-e2e-flake-hunt.md)). Don't widen budgets to paper over a missing
   loading state. In Vitest, poll for a condition (`expect.poll`, `until`)
   instead of sleeping.
5. **Retries are measured, never silent.** With one retry, a
   5%-probability real race turns a run red about once in 400 runs — but
   shows up in retry telemetry about once in 20. The count is the detector;
   see below.

### The ladder

| What it bounds              | Knob                             | Value                                                                                              | On expiry                 |
| --------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------- |
| One UI action               | `actionTimeout` + spinner-waiter | `SPEC_ACTION_TIMEOUT_MS` 1s (→ ~30s with spinner)                                                  | fail the attempt          |
| One assertion               | `expect.timeout`                 | `SPEC_EXPECT_TIMEOUT_MS` 15s                                                                       | fail the attempt          |
| One Playwright spec         | `timeout`                        | `SPEC_TEST_TIMEOUT_MS` 240s                                                                        | retry once (CI)           |
| One Vitest e2e test/hook    | `testTimeout` / `hookTimeout`    | 60s / 120s (`apps/os/vitest.config.ts`, `e2e`)                                                     | retry once (CI)           |
| A heavy test                | per-test `{ timeout }`           | per test, with a `// comment`; in the e2e project at most 90s ([the row budget](#the-row-budget))  | retry once (CI)           |
| A retry's pause             | vitest `retry.delay`             | `E2E_CI_RETRY_DELAY_MS` 5s, for `createFailing`'s retries; the e2e project retries without a pause | n/a                       |
| One Workers-suite test/hook | `testTimeout` / `hookTimeout`    | 120s / 120s (the first test pays workerd boot)                                                     | fail                      |
| One perf test               | `testTimeout` / `hookTimeout`    | 240s / 120s (`apps/os/vitest.config.ts`, `perf`); concurrent project creation 420s                 | fail (no retry)           |
| One bench file              | `testTimeout` / `hookTimeout`    | 300s                                                                                               | fail                      |
| The Depot CI job            | `timeout-minutes`                | Test 20, Deploy preview 40, E2E tests and Browser specs 30 each, latency guard 45 minutes          | outer edge: re-run button |

The ladder is strictly ordered, and a new knob keeps it that way. Note the
deliberate rule-3 consequence: no watchdog budgets for a test double-burning
its timeout.

### The row budget

The e2e run starts every file at once and every row within a file
concurrently, so it lasts its startup plus its slowest row: one slow row makes
every PR wait for it. The numbers live in `e2e-policy/budgets.ts`.

| Number                       | Value | What it does                                                                                                                                                                       |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_ROW_BUDGET_MS`          | 60s   | An e2e row that runs on every PR finishes within it at its p95.                                                                                                                    |
| `E2E_ROW_WARN_MS`            | 45s   | `RetryTelemetryReporter` prints each e2e row that ran longer, `[row-budget]` in the e2e step's log.                                                                                |
| `E2E_ROW_TIMEOUT_CEILING_MS` | 90s   | The longest timeout such a row may declare. A `createFlake` / `createFailing` deadline counts, plus the second the wrapper adds.                                                   |
| `E2E_SLEEP_CEILING_MS`       | 30s   | The longest fixed wait (`sleep`, a `setTimeout` that does not reject) such a row may make. Poll for the condition instead.                                                         |
| `E2E_SLOW_ROW_TIMEOUT_MS`    | 300s  | The timeout of a row tagged `slow`.                                                                                                                                                |
| `UNIT_ROW_WARN_MS`           | 10s   | The Test job's telemetry finalizer prints each unit or Workers row that ran longer and is not in `UNIT_ROW_WARN_EXEMPTIONS`, and each entry no row needs any more. A warning only. |

A run the preview script starts holds every row to its timeout ceiling
(`e2e/support/setup.ts`): a row whose resolved timeout is over it fails before
it starts, in the E2E tests job. A row gated on an opt-in variable (`RUN_*`,
`E2E_REAL_MODELS`) or on a local worker (`localOnly`) never starts there, so
the ceiling does not apply to it. `scripts/ci/e2e-policy.test.ts`, in the Test
job, regex-matches the e2e files for a `sleep`, `delay` or `setTimeout` whose
literal is over 30s, and fails unless the wait is listed in its
`ALLOWED_WAITS` (the slow rows' waits). A wait written with a named constant
passes unseen. The same file keeps `E2E_CI_RETRIES` as the only retry setting.

A row over the budget has two ways out:

- **Make it faster.** Poll for the condition instead of sleeping through it.
- **Tag it `slow`** when it waits out real platform time (a quiet minute, a
  sweep, an alarm). It then runs only where that costs no PR
  ([slow rows](#slow-rows)), with a timeout up to `E2E_SLOW_ROW_TIMEOUT_MS`,
  and its file joins `SLOW_ROW_PATHS`, which the guard checks.

The [flake dashboard](https://github.com/iterate/iterate/issues/2580) prices
the rows too. Its **Cost** section reads the per-row durations of each suite's
last 100 complete `preview-e2e` and `unit` runs: each row's p50 and p95, its marginal wall (how much sooner the run would have ended
without it), its retries and PR failures, and a proposal for a row past its
budget or with 10s of marginal wall: make it faster, or tag it `slow`. A
failed attempt 8 or more rows of one run share, retried or not, counts once,
as an incident, and as no row's retry or failure. A proposal to delete a row
must name the coverage that replaces it.

### Slow rows

A row that waits out real platform time is tagged `slow`
(`test(title, { tags: ["slow"], timeout }, …)`). The e2e project declares the
tag, with `E2E_SLOW_ROW_TIMEOUT_MS` as its timeout, and sets `strictTags`, so
a misspelled tag fails its row. Today these are the three residency rows in
`context-residency.e2e.test.ts` that prove a careless facet stops, each
sleeping 110–180 s, and the pin in `facet-abort-storage-reset.e2e.test.ts` of a
Cloudflare fault that resets the context it runs on. Every PR used to wait for
the longest residency row. The claimed-work row in
`context-residency.e2e.test.ts` is not `slow`: it waits 30 s, so the claim's
alarm lands mid-attempt, and runs on every PR.

`pnpm preview e2e` chooses whether they run (`apps/os/scripts/slow-rows.ts`)
and prints its choice as `[slow-rows] <run|skip|only>: <reason>`:

| Run                          | The slow rows                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A PR push (Preview OS)       | Skipped, unless the PR carries the `slow-e2e` label or edits a slow row's file (`SLOW_ROW_PATHS`). When GitHub does not answer, every row runs.         |
| A Preview OS dispatch        | As its `slow-rows` input says (`run` or `skip`); empty, as a push. `--input action=e2e --input slow-rows=run` runs them against the live preview.       |
| Main OS e2e, every main push | Run, with every other row (`E2E_SLOW_ROWS: run`); pages #error-pulse on their own change of state, as "slow e2e rows" (`scripts/ci/main-e2e-alert.ts`). |
| You                          | `--slow-rows run`, `skip` or `only` (alone): `pnpm preview e2e --pr <n> --name <branch> --slow-rows only` from `apps/os` under Doppler `os/preview`.    |

Turn them on for a PR that can change how long a context or facet stays
running, what wakes it, its alarms, its claims or what its birth resets: the
facet host, residency, RPC stubs and built-ins (`apps/os/src/context/`), the
context Durable Object, the alarm coordinator, the processors or
`apps/os/wrangler.base.jsonc`. Add the `slow-e2e` label
(`gh api -X POST repos/iterate/iterate/issues/<n>/labels -f 'labels[]=slow-e2e'`),
or run them against the PR's preview as the table says. The label is read
when the e2e job starts, so add it before the push, or dispatch the run
afterwards. Main OS e2e pages when main changes state, and pages the slow rows
of the same run under their own name, "slow e2e rows", on their own change of
state, so a slow row broken while main is already red still pages. A PR that
breaks a slow row without turning them on reaches production first, and its
main push finds it. The preview e2e suite summary records
whether they ran (`slowRows`), and the PR time-to-green guard splits pushes on
it ([Depot CI](depot-ci.md#pr-time-to-green)).

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
  passes. Grep any run log for `retry-telemetry`. Playwright's `list` reporter
  marks retried specs.
- **CI**: the Test workflow's runners write canonical telemetry to the
  durable directory, and the finalizer keeps it as the
  `unit-test-telemetry-attempt-<id>` artifact. A plain test that failed and
  then passed on its CI retry also gets a `kind: "unknown"` flake record
  (below), and so does one that failed every attempt. Preview jobs upload their
  telemetry as the `preview-test-telemetry-attempt-<id>` artifact. Every
  artifact carries its job attempt's id, so a retried job keeps the failed
  attempt's evidence ([per job attempt](depot-ci.md#artifacts-per-job-attempt)). Nothing folds preview
  retries into the PR body or annotates a run with four or more retries (which
  may indicate a deployment-wide incident rather than independent flakes).
- **Volume**: probabilistic regressions need run volume to detect — that is
  what the on-demand soak is for (`os-e2e-soak.yml`, or
  `pnpm --dir apps/os e2e:soak --runs N` with `WORKER_BASE_URL`: N sequential
  runs of the e2e suite against one deployed worker, each followed by the perf
  budgets). It names every row that did not pass every time: a row that fails
  once in a hundred is a flake; a row that fails every time is a bug.
- **Latency is not an e2e assertion**: the e2e run puts 16 files, their rows
  concurrent, on one worker, so a wall-clock number measured there is the
  suite's contention as much as the platform's. A latency or throughput
  budget belongs in `apps/os/perf/` (the `perf` project), which runs alone and
  asserts the median of several rounds; an e2e row may print its numbers. The
  latency guard (`os-latency.yml`) runs that suite every 3 hours, alone on a
  preview of its own, and pages when a metric crosses its
  budget or regresses sharply two runs in a row; a new perf row records its
  metrics with `recordLatency` (`apps/os/perf/record.ts`) and names them, with
  a calibrated budget, in `apps/os/perf/latency.ts`.
- **Neither is how long Cloudflare keeps an actor**: when the platform evicts
  a context or stops a facet is its decision, not the product's. An e2e row
  asserts what the platform code decided (a wake, a reset named on a wake
  record, a facet no longer running once its window is up) and may print how
  long the actor lived. The timing itself is an opt-in perf file
  (`apps/os/perf/context-residency.perf.test.ts`, `RUN_RESIDENCY_TIMING=1`,
  or the soak's `residency-timing` input), which the latency guard never runs.

When telemetry trends up without failures, investigate it. If the test is
repeatedly flaky or adds disproportionate tail latency, use the quarantine
protocol below instead of repeatedly making unrelated PRs pay for it.

### Flaky-test quarantine protocol

A row leaves the PR's way in one of three forms, each with a way back:

| Cause                                                      | Form                                                 | Where it runs                                                                                  | Way back                                               |
| ---------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Flaky, always with the same error                          | `createFlake` ([below](#flakes-and-pinned-failures)) | Every PR, where it cannot fail the run                                                         | Unwrapped once its records show it passes consistently |
| Slow: waits out real platform time, or its p95 is over 60s | The `slow` tag ([slow rows](#slow-rows))             | PRs that carry `slow-e2e` or edit its file, every main push (pages on its own change of state) | Rewritten to a p95 of 45s or less, then untagged       |
| Hangs, or harms the rest of the suite                      | A dated skip ([parked](#parked-tests-expire))        | Nowhere; it needs an issue                                                                     | The date forces a decision                             |

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
  suite is broken.

The skip path carries extra obligations precisely because it produces no
data: the narrowest explicit `test.skip`/`fixme` (or a clearly logged no-op
for an entire broken suite) — never a title filter, deleted discovery entry,
extra retry, or swallowed error — plus a `parked:` comment with the evidence
and a `revisit by` date ([below](#parked-tests-expire)), a tracking issue
with the evidence, impact, investigation work, and concrete exit criteria,
and a prominent call-out in the PR description and at the top of this doc.

Once the remaining CI is green, either form of quarantine is explicit
coverage debt, not a reason to keep the unrelated PR open indefinitely.

### Flakes and pinned failures

Two wrappers in `packages/shared/src/test-support` register through the runner's own expected-fail variant (Vitest `test.fails`, Playwright `test.fail`) and let exactly one error pattern through:

- `createFlake(test, /pattern/)` ([flake-test.ts](../packages/shared/src/test-support/flake-test.ts)) marks a known flake. The body asserts real behavior. A pass or a failure matching the pattern is green, any other failure or a hang is red, and the test is never retried: one sample per run.
- `createFailing(test, /pattern/)` ([failing-test.ts](../packages/shared/src/test-support/failing-test.ts)) pins a known bug. The body asserts the desired behavior and must fail with the pattern. A pass (the bug looks fixed) or a different failure is red.

Every outcome of either wrapper, and every plain test that failed, whether its CI retry then passed or not (an unknown flake, with the first attempt's error), is one JSON line in `FLAKE_RECORD_DIR`. The CI finalizer (`scripts/ci/upload-test-telemetry.ts --flake-suites <unit|specs|preview-e2e>`, one suite per job) adds the suite's `suite-summary.json`, and the job keeps both in its [test evidence](test-evidence.md) folder in R2, as well as in `flake-records-<suite>-attempt-<id>` artifacts, one per job attempt. Every hour the [flake dashboard](https://github.com/iterate/iterate/issues/2580) (`.depot/workflows/flake-dashboard.yml`, `scripts/ci/flake-dashboard/`) reads the recent runs' records and summaries back from R2 and recomputes the whole issue, writing it as the iterate GitHub App. It keeps nothing between runs: main's runs of the last seven days give the wrapped tests' stats and lifecycle streaks, and each suite's newest 150 runs on any branch give the squares, the last three complete runs a row must appear in to stay listed, and the Cost section. Local runs without the variable record nothing.

Each suite carries a monthly `flake sentinel` (`flakeSentinel` in flake-test.ts): a `createFlake` test that throws its allowed error about 10% of the time until its month ends. The three have distinct names, so each gets its own dashboard row: `flake sentinel` (`packages/shared/src/test-support/flake-sentinel.test.ts`), `flake sentinel (specs)` (`specs/flake-sentinel.spec.ts`) and `flake sentinel (e2e)` (`apps/os/e2e/flake-sentinel.e2e.test.ts`). A sentinel that reads 0% or goes red means the recording or ingestion pipeline is broken; distrust the dashboard, not the sentinel. Rolling all three forward is one constant, `SENTINEL_MONTH_END` in flake-test.ts.

### Pinned bugs: `createFailing(test, …)`, not bare `test.fails`

For a KNOWN bug held open on purpose, wrap the runner's own test function
with `createFailing` from `@iterate-com/shared/test-support/failing-test` — it
works for vitest and playwright alike, passing fixtures and options through:

```ts
const fail = createFailing(test, /SAME-BOOT STALENESS/, { timeoutMs: 240_000 });
fail("a userspace facet rebuilds on a source commit", async () => {
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
stays silently green in all three cases.) The wrapper sets the runner's own
test timeout to that deadline plus a second, so the runner never fires first;
a pin that legitimately runs longer raises the deadline via
`options.timeoutMs`. Write the body so the bug throws a distinctive message,
and so conditions that prove nothing (a coincidental restart masking the bug
for one observation) retry instead of succeeding: a bare `test.fails` pin
without that false-alarmed 7+ times.

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

The dashboard also surfaces flakes nobody has classified: a PLAIN test that
failed gets a `kind: "unknown"` record from the telemetry reporters (see
`packages/shared/src/test-support/flake-record.ts`), error text included:
`retried-pass` when its CI retry passed, `unexpected-error` when every attempt
failed. On main either one opens or resets the test's "Unknown flakes" row, so
a test that fails outright once and passes on the next push is still counted. Those rows are the adoption funnel — the "Unknown
flakes" section of the dashboard shows the error samples to turn into a
`createFlake` pattern, and once wrapped, the same test name migrates into the
Flakes section. `createFailing` pins record too (`pinned-fail` /
`unexpected-pass`), so the Failures section shows how long each pin has stood
within the last seven days, and proposes deleting wrappers whose bugs look
fixed. A proposal shows while the streak behind it holds. Each test run keeps
its records in its evidence folder in R2, where
`.depot/workflows/flake-dashboard.yml` reads them for
[#2580](https://github.com/iterate/iterate/issues/2580).

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
unit suite (`pnpm test`): it scans the test corpus for skip/fixme/todo markers
and **fails on any `revisit by` date in the past**, printing the file and the
parked reason. An expired date is a decision point, not a nag to bump: fix and
un-park the test, or renew the date with the reason re-argued. Undated markers
must be allowlisted in that guard with a note; the allowlist holds structural
gates only and never grows to excuse a parked bug. A `createFailing` pin is
not a marker: it runs, and turns red once the bug it pins is fixed.

The Depot Test workflow runs workspace tests and keeps their raw
telemetry as a job artifact. Production's deploy runs only its readiness
probes and the read-only host check. The Preview OS workflow deploys a per-PR
platform and all five hosted clients, then runs integration and browser tests;
Main OS e2e does the same for each main push on its own preview, redeployed in place.
Operational changes require coherent preview state and telemetry as well as
passing tests; see the [engineering invariant](engineering-invariants.md).
