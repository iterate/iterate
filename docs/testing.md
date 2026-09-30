# Testing: Unit, E2E, And Playwright Specs

The suites, how to run each against any environment, the environment variables, and the
[retry and timeout policy](#retries-and-timeouts). Test style: [Vitest patterns](vitest-patterns.md).
Telemetry: [CI and test telemetry](ci-test-telemetry.md). Run commands from the repository root.

| Command                                  | Coverage                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm typecheck`                         | Every tracked TypeScript file but the config templates in `configs` (JavaScript) |
| `pnpm lint`                              | Source lint and applicable repository rules                                      |
| `pnpm format:check`                      | Formatting                                                                       |
| `pnpm knip`                              | Unused files, exports and dependencies in every workspace                        |
| `pnpm test`                              | Workspace unit tests, including OS unit and Workers projects                     |
| `pnpm --dir apps/os e2e`                 | OS integration suite; local Worker unless a deployed target is configured        |
| `pnpm spec`                              | Root browser specs: one project per app host, plus the issuer at phone width     |
| `pnpm --dir apps/kit firmware:test:host` | Kit firmware host tests (needs cmake; not part of `pnpm test`)                   |

`pnpm lint` runs oxlint on one thread: one per core starts a type-aware service per worker and
hits spawn ENOMEM on a 16-core machine, and 4 to 12 threads were no faster.

> [!NOTE]
> A quarantined suite is called out here, in a CAUTION box naming the skip,
> its evidence and its restoration criteria, so nobody mistakes a hidden hole
> for coverage. No suite is quarantined today.

## Philosophy

1. **Prove the behavior users actually get.** The default test is e2e from very far away: through
   the itx surface (capnweb at `/api`, exactly like a production client) or a real browser, against
   a live deployment, with no test-only hooks. The local e2e run boots the real worker in workerd.
2. **Fail fast; fix the product, not the timeout.** (Misha Kaletsky's design, the
   [middlewright](https://github.com/iterate/middlewright) plugin family.) Playwright actions get a
   ~1s budget that extends, up to ~30s, only while the app visibly reports progress
   (`data-spinner`). A slow flow that makes a test flaky is a product bug: add the loading state
   users wanted anyway. In his words: "it makes your test pass fast, fail fast, and it incentivises
   agents to improve the product when tests fail, instead of bumping timeouts which makes tests
   worse and lets your product get away with bad UX." An explicit timeout override carries a
   `// comment` saying why (`middlewright/require-timeout-comment`).
3. **Every test owns its state.** Each e2e test mints its own project (`freshCtx` in
   `apps/os/e2e/support/client.ts`) and each spec stamps its own identities (`stamp()`): no shared
   fixtures, no ordering, no cleanup coupling. That is what makes parallel workers sound.
4. **One retry, watchdogs above, telemetry always** ([Retries and timeouts](#retries-and-timeouts)).
   A recurring or pathologically slow unrelated flake is quarantined and tracked, not paid for by
   every PR.
5. **Harnesses are honest about fidelity.** Fakes implement the real interfaces (`memoryStream`
   mirrors the Stream's commit semantics; the fake git remote speaks protocol v2 through the repo
   facet's own codecs), every processor with side effects has a re-reduce test, and a harness that
   cannot catch a bug class says so in its file header and names the test that can.
6. **A test runtime earns its place.** Unit tests run in plain node; real runtime coverage comes
   from e2e against the real worker. The one extra runtime, the `workers` project
   (`@cloudflare/vitest-plugin`, `apps/os/__workers-tests__/`), covers hibernation, eviction and
   alarm cases that need `cloudflare:test` controls. Another runtime needs a proven coverage gap.

## Suites

The geography rule: `specs/` tests the product through a browser;
`<app>/e2e/` tests that deployable's own contract. Every e2e suite must be
wired to a CI job or explicitly documented as manual — a tag filter or
unset env var that silently skips tests is the failure mode this table
exists to prevent (a `@preview` title filter once quietly reduced the
streams example app's CI coverage to 3 of ~37 tests while the rest rotted).

| Suite            | Command (repo root unless noted)                                  | Lives in                                                                                                              | In CI                                                                                                                                                      | Proves                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit             | `pnpm test`                                                       | `apps/os/src/**/*.test.ts` (colocated), `apps/os/scripts/*.test.ts`, every workspace's own suite                      | Depot **Test** workflow, every PR — full suite                                                                                                             | In-process logic; no deployment needed.                                                                                                                                                                                                                                                                                                                                                           |
| Workers          | `pnpm test` (`--project workers` in `apps/os`)                    | `apps/os/__workers-tests__/`, `apps/agents/__workers-tests__/`                                                        | Depot **Test** workflow, every PR — full suite                                                                                                             | Inside workerd next to the worker (Vite's built `dist/server/index.js` through `exports.default.fetch`, never a source import): hibernation, eviction, alarms and pins that need `cloudflare:test` controls. Consecutive files share a runtime, and each starts as a runtime of its own would (`__workers-tests__/fresh-file.ts`); `--sequence.seed=<n>` runs the files in an order drawn from n. |
| OS e2e           | `pnpm e2e`                                                        | `apps/os/e2e/*.e2e.test.ts`, `apps/agents/e2e/`                                                                       | Preview OS **e2e** job, every preview deploy, against the PR's preview; rows tagged `slow` only when it turns them on or edits one                         | One real worker (local workerd by default, the deployed worker with `WORKER_BASE_URL`), every file a capnweb client at `/api` exactly like a production client; files in parallel and tests within a file concurrent.                                                                                                                                                                             |
| Playwright specs | `pnpm spec`                                                       | `specs/` (root `playwright.config.ts`, one project per app host: `os`, `os-phone`, `notes`, `docs`, `voice`, `suite`) | Preview OS **e2e** job, every project, side by side with OS e2e; `notes` and `voice` against the preview's Notes and Voice apps                            | Browser-level product flows: issuer sign-in and consent (plus a phone-width project), the issuer's server functions, the project mini-app, and the Notes and Voice flows.                                                                                                                                                                                                                         |
| Notes specs      | `pnpm spec --project notes` (`NOTES_BASE_URL`, `WORKER_BASE_URL`) | `specs/notes/`                                                                                                        | Preview OS **e2e** job, in the same `pnpm spec` run, against the preview's Notes app; a missing `NOTES_BASE_URL` fails in CI, skips locally                | Notes through a project's config worker (the preview's Notes Worker behind it): save a note, read it after reload, and end its session in the Dash; and the PR body's Notes link, an admin opening it as themselves.                                                                                                                                                                              |
| Docs specs       | `pnpm spec --project docs` (`DOCS_BASE_URL`, `WORKER_BASE_URL`)   | `specs/docs/`                                                                                                         | Preview OS **e2e** job, in the same `pnpm spec` run, against the preview's Docs app; a missing `DOCS_BASE_URL` fails in CI, skips locally                  | Docs through a project's config worker: a new doc, the editor's shortcuts, autosave, and a commit made elsewhere merged in.                                                                                                                                                                                                                                                                       |
| Main e2e         | `pnpm preview deploy`, then `e2e`, `--name main` (`apps/os`)      | The OS e2e and Playwright suites above                                                                                | **Main OS e2e** (`main-os-e2e.yml`), every main push to the preview paths, beside Deploy OS; it pages when main turns red or green                         | The same suites, every row, against the pushed commit's own deployment, `main-<sha7>` ([why](depot-ci.md#main-os-e2e-deploys-each-commit-fresh)).                                                                                                                                                                                                                                                 |
| Slow rows        | `pnpm preview e2e --slow-rows only` (`apps/os`)                   | Rows tagged `slow`, `scripts/monitors/e2e.ts`                                                                         | **Main OS e2e**, every main push, with every other row; its page job pages their own change of state as soon as the run ends. On a PR, only when turned on | The residency rows that wait out real quiet minutes: a careless facet stops a quiet minute after its last call, and after its claim ends ([slow rows](#slow-rows)).                                                                                                                                                                                                                               |
| Kit host         | `pnpm --dir apps/kit firmware:test:host` (needs cmake)            | `apps/kit/firmware/tests/`                                                                                            | Depot **Test** workflow, every PR (its own step after `pnpm test`)                                                                                         | Firmware logic compiled for the host and run under CTest.                                                                                                                                                                                                                                                                                                                                         |
| Kit ESP builds   | `node apps/kit/scripts/firmware-release.ts build …`               | `apps/kit/firmware/targets/`, `apps/kit/scripts/firmware-release.ts`                                                  | **Kit Firmware** workflow, firmware PRs and main (not required)                                                                                            | Builds each changed board with ESP-IDF (active), checks its flash layout, its inputs and an unchanged tree; main publishes the releases.                                                                                                                                                                                                                                                          |
| Dummy petshop    | `pnpm test` (its sealing and state units)                         | `apps/dummy-petshop/src/`                                                                                             | Depot **Test** workflow; the fixture itself deploys from `main` (Deploy dummy-petshop)                                                                     | The OAuth/API fixture the OS secret and connection e2e rows dial (`PETSHOP_BASE_URL`, default `https://dummy-petshop.iterate.workers.dev`).                                                                                                                                                                                                                                                       |
| Soak             | `pnpm os:e2e-soak --runs N` (`WORKER_BASE_URL`)                   | `scripts/os/e2e-soak.ts`                                                                                              | **Manual** — dispatch `os-e2e-soak.yml`; a measurement, not a gate                                                                                         | The e2e suite N times against one deployed worker, each run followed by the perf budgets, tallying every row that did not pass every time; never a real model.                                                                                                                                                                                                                                    |
| Perf budgets     | `pnpm --dir apps/os perf` (`WORKER_BASE_URL`)                     | `apps/os/perf/*.perf.test.ts`, every metric and budget in `apps/os/perf/latency.ts`                                   | The latency guard below; every soak run, after the e2e suite                                                                                               | Latency and throughput budgets over the same client and worker, measured alone: files one at a time, rows in order, each budget on the median of its rounds (p95 where a run has dozens).                                                                                                                                                                                                         |
| Latency guard    | Dispatch `os-latency.yml`                                         | `.depot/workflows/os-latency.yml`, `scripts/monitors/latency.ts`                                                      | **OS latency**, every 3 hours, beside everything (nothing waits on it); Health judges each report and pages #error-pulse                                   | The perf suite against main's commit deployed as `latency-<sha7>`: every metric to PostHog (`os latency measured`), paged red once when it crossed its budget or a sharp regression on its rolling baseline two runs in a row, green once when back.                                                                                                                                              |
| Real model       | Dispatch `os-real-model.yml`                                      | `REAL:` rows (`realModelOnly`), `.depot/workflows/os-real-model.yml`, `scripts/monitors/e2e.ts`                       | **OS real model**, daily and every main push to the agents runtime, on its own preview; Health pages #error-pulse                                          | The turns every other run gives a fake provider, against real models: OpenAI's astra (the default) and Workers AI accept the request and answer. [Real-model rows](#real-model-rows).                                                                                                                                                                                                             |
| Crash hunt       | `RUN_ISOLATE_CRASH_HUNT=1 pnpm e2e isolate-ceilings`              | `apps/os/e2e/isolate-ceilings-deployed.e2e.test.ts`                                                                   | Nightly against prd (`os-crash-hunt.yml`); opt-in rows, so the preview run stays deterministic                                                             | Drives one context's Durable Object up to and past its isolate ceiling on purpose.                                                                                                                                                                                                                                                                                                                |
| Bench            | `pnpm --dir apps/os bench` (`BENCH_OUT=<file.json>`)              | `apps/os/bench/`                                                                                                      | **Manual**                                                                                                                                                 | Latency scenarios over the same client and worker, files one at a time.                                                                                                                                                                                                                                                                                                                           |

The normal Depot **Test** workflow runs `pnpm test` from the repo root. That
recursively runs every workspace's `test` script, including the `iterate` CLI,
Kit's and dummy-petshop's unit suites; Kit's firmware host tests are a separate step of the same job
that runs even when `pnpm test` fails. OS's `test`, `e2e` and `bench` scripts build first, so every
suite tests the built worker. Preview OS's E2E tests and Browser specs jobs run the OS e2e project
and `pnpm spec` against the PR's preview (`scripts/os/preview.ts` `runSuite`), and both fail
rather than skip when the deploy did not succeed.

Any suite a CI job does not run in full is a wiring bug unless the table names
its manual status. A test that genuinely cannot run against a given target
carries an explicit in-code skip with a named guard and a comment saying why,
so exclusion is always visible where the test lives: `deployedOnly`,
`localOnly`, `deployedSubdomainsOnly` and `realModelOnly` in
`apps/os/e2e/support/project-host.ts` are the one gate each ("never copy the regex").

Smoke tests: `scripts/os/deploy.ts` probes the deployment it just made (`/version`), a preview
deploy waits for its readiness gate (`scripts/os/preview-readiness.ts`) and every client's
`/healthz`, and production's deploy runs only non-mutating probes plus a read-only check of the
project hosts (`scripts/ci/prd-post-deploy-check.ts`). The mutating suites run only on previews: the
PR's, and Main OS e2e's.

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

No unit tests that re-assert another test's fixtures (a test pinning a template's anchor strings
proves only that two files agree), and none for internal scripts' argument parsing, trivial glue, or
anything a covering e2e already proves.

## Shared preview setup

OS preview CI waits for the deployment to be live before starting either
Playwright or Vitest: the `deploy` job only succeeds once the readiness gate
has seen the new deployment answer in full (its edge and brand-new contexts on
the new version, `scripts/os/preview-readiness.ts`) and every client
answers `/healthz`, and the `e2e` job only
starts after a successful deploy. This shared readiness time belongs to
CI setup, not individual test durations. Both suites run concurrently once
ready; browser installation overlaps the Vitest run. The specs run in enough
shards that every spec has a worker from the start
([Browser specs in shards](depot-ci.md#browser-specs-in-shards)). Playwright's worker count and
sharding are measured ([reliability defaults](depot-ci.md#reliability-defaults)): measure the
retries as well as the time before changing either.

Each runner derives the deployed target itself, once, from the deployment's
own `APP_CONFIG` (parsed exactly as the worker parses it) and its `envs.ts`
entry (`apps/os/e2e/support/deployed-target.ts`): the Vitest suite in its
global setup, the specs in `specs/setup.ts`. The prepared values are
inherited by workers, including when running `pnpm spec` locally. Fixtures
read those settings synchronously and mint their own sessions. A missing
credential fails setup before tests start.

## Real-model rows

An agent's turn goes to a real model only in the daily real-model suite. Every other run (PR
previews, Main OS e2e, local runs, the soak) shadows the agent's `itx.ai` with `FakeAi`
(`apps/os/e2e/support/fake-ai.ts`): the whole deployed runtime still runs above it, the fake asserts
what the runtime asked for (the model, the Responses API request, the image part, the AI Gateway
options), and nothing is spent.

- **Why.** Every model call on the preview account goes through the AI Gateway `default`, whose
  daily spend cap (`iterate-gateway-daily`) answers HTTP 429, code 2045, once spent. On 2026-09-24
  a day of soaks spent it, and every PR's e2e timed out on the default-model rows.
- **What runs where.** The `REAL:` rows (`realModelOnly`) of
  `apps/agents/e2e/agents-default-model.e2e.test.ts`,
  `apps/agents/e2e/voice-agent.e2e.test.ts` (a voice call's delegation, answered by the agent),
  `apps/os/e2e/ai-root-shadow-and-fable.e2e.test.ts` and the pin of a Cloudflare streaming fault,
  `apps/agents/e2e/ai-stream-hung-request.e2e.test.ts`, run only with `E2E_REAL_MODELS=1`, which only
  `os-real-model.yml` sets, once a day and on main pushes to `packages/agents/**`. The soak strips
  it. A run costs about $0.06.
- **When the cap is spent anyway.** A real-model row fails at once, naming the cap and the
  gateway's message (`answeredLog` in `apps/agents/e2e/fixtures.ts`): exhaustion is not a flake. The
  gateway's logs (`GET /accounts/<id>/ai-gateway/gateways/default/logs`) show what spent it.

## Running a suite against an environment

Every non-unit suite targets a live deployment and is invoked the same way:

```bash
doppler run --project os --config <cfg> -- env WORKER_BASE_URL=<url> pnpm <suite>
```

The Doppler config supplies the deployment's own credentials (`APP_CONFIG` and
`APP_CONFIG_SECRETS__KEY`, parsed the way the worker parses them); the URL's `envs.ts` entry supplies
its routing and MCP origin, so a per-PR preview inherits its parent's. There are no per-run
credential overrides.

```bash
# local: no target — the suite boots the real worker in local workerd
pnpm --dir apps/os e2e

# a PR preview (its URL is in the PR body)
doppler run --project os --config preview -- \
  env WORKER_BASE_URL=https://pr<n>-<sha7>-os.iterate-dev-preview.workers.dev pnpm --dir apps/os e2e

# production
doppler run --project os --config prd -- \
  env WORKER_BASE_URL=https://os.iterate.com pnpm --dir apps/os e2e
```

Specs take the same shape with `pnpm spec`; without `WORKER_BASE_URL` Playwright starts `pnpm dev` on
`WORKER_PORT` (8788), reusing a running server locally. To run a suite against a preview exactly as
CI does: `pnpm preview e2e --pr <number>`, or `pnpm preview specs --pr <number>`, from `apps/os` under
the same Doppler config (`--slow-rows`, [slow rows](#slow-rows)); `--name <name>` in place of
`--pr` for a deployment with no PR.

## Reaching the test runner from a deployed Worker

A deployed Worker cannot reach the runner's loopback (`127.0.0.1` is the Worker runtime's, and the
platform answers 403). A fixture the deployed worker calls is deployed itself (the dummy petshop at
`PETSHOP_BASE_URL`) or reached over the test's own WebSocket (a fake the test lends with
`provide(...)`). Rows that lend a loopback fixture, such as the fake git remote
(`apps/os/e2e/support/fake-git-server.ts`), are `localOnly`.

## Environment variables

The rule: **one name per control, and no variable without a real setter**.
The deployment under test is described by its own `APP_CONFIG` from the
Doppler config and its `envs.ts` entry — tests never invent parallel names
for it. The Playwright config additionally honors the Playwright-conventional
`CI` and `VIDEO_MODE`.

| Variable                                | Set by                                                      | Controls                                                                                                                                          | Default                                     |
| --------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `WORKER_BASE_URL`                       | You, the preview script, the soak and crash hunt            | THE deployed OS for `pnpm --dir apps/os e2e`, `pnpm spec` (and the issuer for the `notes` project), the soak and bench                            | Local workerd (`pnpm dev` for specs)        |
| `WORKER_PORT`                           | You                                                         | Port for the local server Playwright starts                                                                                                       | `8788`                                      |
| `APP_CONFIG`, `APP_CONFIG_SECRETS__KEY` | Doppler (`os`, `preview` / `prd`)                           | The deployed target's credentials and login (`deployed-target.ts`)                                                                                | None — deployed runs throw without them     |
| `E2E_RUN_ID`                            | Preview CI (`<run id>-<attempt>`), or you                   | The run's id, folded into every identifier a test mints                                                                                           | Minted once per run                         |
| `PETSHOP_BASE_URL`                      | You                                                         | Which dummy petshop the secret and connection rows dial                                                                                           | `https://dummy-petshop.iterate.workers.dev` |
| `NOTES_BASE_URL`                        | The preview script, or you                                  | The Notes Worker the `notes` project's config worker fetches through to                                                                           | Unset → skipped locally, a failure in CI    |
| `DOCS_BASE_URL`                         | The preview script, or you                                  | The Docs Worker the `docs` project's config worker fetches through to                                                                             | Unset → skipped locally, a failure in CI    |
| `VOICE_BASE_URL`                        | The preview script, or you                                  | The Voice deployment the `voice` project signs in to                                                                                              | Unset → skipped locally, a failure in CI    |
| `DASH_BASE_URL`                         | The preview script, or you                                  | The Dash deployment the `dash` project and the Notes session spec sign in to, the latter to end a Notes session                                   | Unset → skipped locally, a failure in CI    |
| `ADMIN_BASE_URL`                        | The preview script, or you                                  | The Admin deployment the `admin` project signs in to                                                                                              | Unset → skipped locally, a failure in CI    |
| `RUN_ISOLATE_CRASH_HUNT`                | The crash-hunt workflow                                     | `"1"` opts in to the load-dependent isolate-ceiling rows                                                                                          | Unset → those rows skip                     |
| `E2E_REAL_MODELS`                       | The real-model suite (`os-real-model.yml`)                  | `"1"` opts in to the `realModelOnly` rows, which pay for a real inference; the soak strips it                                                     | Unset → those rows skip                     |
| `RUN_RESIDENCY_TIMING`                  | The soak's `residency-timing` input, or you                 | `"1"` opts in to the residency timing rows (`apps/os/perf/context-residency.perf.test.ts`)                                                        | Unset → those rows skip                     |
| `E2E_SLOW_ROWS`                         | `pnpm preview e2e`: its `--slow-rows`, else its choice      | The slow rows' choice the suite runs under: `run`, `skip`, `only` (alone); set, vitest holds each row to its timeout ceiling                      | Unset → no ceiling (not `pnpm preview e2e`) |
| `BENCH_OUT`                             | You                                                         | Writes the bench's raw samples as JSON                                                                                                            | Unset → no file                             |
| `FLAKE_RECORD_DIR`                      | CI (the Test workflow; the preview script, per suite)       | Where flake wrappers and retried plain tests append one JSON line per outcome                                                                     | Unset → nothing recorded                    |
| `TEST_TELEMETRY_ARTIFACT_DIR`           | CI (Test workflow: `test-results/ci-telemetry/raw`), or you | Durable canonical JSON directory consumed by the always-running finalizer                                                                         | Unset → reporter does not write             |
| `TEST_TELEMETRY_KIND`                   | The preview script, for its vitest e2e suite (`e2e`)        | Shared `unit`, `integration`, or `e2e` dimension                                                                                                  | Runner-appropriate default                  |
| `TEST_TELEMETRY_SUITE`                  | The preview script, for its vitest e2e suite (`vitest`)     | Shared suite dimension (`unit`, `vitest`, `playwright`, …)                                                                                        | Runner-appropriate default                  |
| `TEST_TELEMETRY_WORKSPACE`              | The preview script, per suite                               | Shared workspace dimension (`os`, `iterate-root`)                                                                                                 | The running package's name                  |
| `TEST_TELEMETRY_HEAD_SHA`               | CI                                                          | Exact tested commit identity, including manually dispatched runs                                                                                  | Ambient `GITHUB_SHA`, then local HEAD       |
| `TEST_TELEMETRY_BRANCH`                 | CI                                                          | Exact tested source branch, including manually dispatched runs                                                                                    | Ambient GitHub head/ref name                |
| `TEST_TELEMETRY_PULL_REQUEST_NUMBER`    | CI                                                          | Exact selected PR identity for manually dispatched runs                                                                                           | Ambient pull-request ref, then unset        |
| `TEST_TELEMETRY_EXPECTED_WORKSPACES`    | CI finalizer                                                | Comma-separated workspaces that must each leave a runner artifact (preview jobs; Test uses `--expect-unit-workspaces`)                            | Unset → require at least one artifact       |
| `CI`                                    | Depot CI                                                    | One retry (Vitest e2e and Playwright), trace on first retry, 16 Vitest e2e workers and 6 Playwright workers, never reuse an existing server       | Unset locally                               |
| `CI_TRACE_ENABLED`                      | Preview OS and Main OS e2e                                  | `"1"` prints each test's `@@ci-trace` records for the [CI trace](ci-traces.md)                                                                    | Unset → no trace records                    |
| `VIDEO_MODE`                            | You                                                         | `"1"` records spec demo videos — see [Video mode](#video-mode-recorded-spec-demos-for-prs)                                                        | No video                                    |
| `PLAYWRIGHT_SCREENSHOT`                 | You                                                         | Semicolon-separated regexes over `locator.toString()`; each matching successful action saves a full-page PNG (`specs/test-support/screenshot.ts`) | Unset → no screenshots                      |

## Artifacts

- **Every CI test job** keeps `test-results/`, its [test evidence](test-evidence.md) folder, as a
  Depot artifact per job attempt ([per job attempt](depot-ci.md#artifacts-per-job-attempt)) and in
  R2: each runner's telemetry under `ci-telemetry/raw`, flake records, Kit's CTest JUnit XML, and
  Playwright's output (failed specs' traces, screenshots and error context, `PLAYWRIGHT_SCREENSHOT`
  captures, the HTML report in `playwright-html/`, `playwright-results.json`).
- **The soak** writes one JSON report per run under `apps/os/output/soak/` plus `summary.json`.
- **Preview CI** writes the preview's summary to `apps/os/output/preview.json` and the URLs into
  the PR body. Fetch artifacts with `depot ci artifacts`
  ([browser reports](depot-ci.md#browser-reports-from-artifacts)).

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

Anti-goal: one mega test-support package, which would drag itx clients and credentials into a
package production workers import. "Needed by both suites" is proven by a consumer, not predicted:
`until` in `apps/os/e2e/support/client.ts` stays L2 until a spec needs it.

## Data fixtures with regenerable outputs

A committed output that is computed from source is checked for freshness by
a plain run, and regenerated by one command — never edited by hand. The
generated route trees follow this rule (`routes:check` runs in each
app's `typecheck`; `routes:generate` refreshes). For a fixture whose outputs a
reviewer should read, use one markdown file per scenario: the inputs, fences
of generated output, and an annotations fence the harness weaves back in when
it regenerates on `-u`.

## Video mode: recorded spec demos for PRs

Any Playwright spec re-runs as a watchable demo: pointer highlights on every action, dead air
compressed, the blank startup lead-in trimmed. It is Misha's
[middlewright](https://github.com/iterate/middlewright) `videoMode`, wired in
`specs/test-support/test.ts`; fix its issues upstream. Until a release is published to npm by hand,
the root `package.json` pins a pkg.pr.new build of it.

```bash
# local dev, one flow (the config auto-starts the dev server)
VIDEO_MODE=1 pnpm spec -g "consent"

# against a deployed preview — note --project os: the repo root
# scopes to _shared, which lacks the APP_CONFIG the specs derive credentials from
doppler run --project os --config preview -- \
  env WORKER_BASE_URL=<preview url> VIDEO_MODE=1 pnpm spec -g "consent"
```

`VIDEO_MODE=1` sets `video: "on"` at each project's own viewport (the budgets do not relax;
`e2e-policy/budgets.ts` says why), and the `videoMode` plugin post-renders with ffmpeg: pointer
highlights, dead-air spans >300ms sped up, `test.step` captions, a final hold (`finalHold`, in
milliseconds) and the lead-in trimmed (`trimStart: "auto"`; `page.videoMode.setStartTime()` wins).
The captions need an `ffmpeg` with the `ass` (libass) filter, which Homebrew's `ffmpeg` lacks:

```bash
brew install ffmpeg-full
export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
```

Output lands under `test-results/playwright-output/<test-title-dir>/`: `video-rendered.webm` (the
demo), `video-raw.webm`, a `video-mode.html` frame-stepper and `video-mode-report.html`, all
attached to the HTML report. Getting `video-rendered.webm` into a PR is manual:
[Pull requests](pull-requests.md#video).

## Retries and timeouts

The shared constants live in **`packages/shared/src/test-support/e2e-policy/budgets.ts`**
(`@iterate-com/shared/test-support/e2e-policy`): the root `playwright.config.ts` imports its spec
budgets and CI retry count, `apps/os/vitest.config.ts` its CI retry count and the Vitest timeouts
below. The evidence for these rules is a marathon of 50 consecutive green preview runs in July 2026
(about 5,800 test executions, 0.5% needing their one retry, none a second;
[the full log](https://github.com/iterate/iterate/blob/bf72f92bd76365e85533d4296fb3ddb239379f98/docs/preview-e2e-flake-hunt.md)),
and today the retry telemetry and the [flake dashboard](https://github.com/iterate/iterate/issues/2580).

1. **Retries live in exactly one layer: the individual test**, the smallest unit that owns its
   state. `E2E_CI_RETRIES = 1` in CI, zero locally. Below it, the e2e transport sends again only a
   request that never reached the deployment: Cloudflare's own not-found from a server a brand-new
   hostname has not reached yet, on a fresh connection, on `CI_HTTP`'s schedule, each resend an
   `e2e.platform-failure-retry` warn in the run's log (`apps/os/e2e/support/not-routed.ts`).
2. **Everything above a test is a watchdog: it fails, it never retries.** A Depot job has
   `timeout-minutes`; re-running a killed run is the outer edge's job (the re-run button, the next
   push), never automatic.
3. **Watchdogs are sized to ~2× the healthy p99 of what they bound**, never to accommodate
   worst-case retry stacks: a run burning retries against a wedged platform should be killed.
   Today the only watchdogs above a test are the Depot jobs' `timeout-minutes`, looser than this.
4. **Waits are progress-based; static budgets are backstops.** The Playwright `actionTimeout` is
   tight, and the middlewright spinner-waiter extends it only while the app visibly reports
   progress: this caught a real blank-render bug (an `ssr: false` subtree with no pending
   component, which is why every client router sets `defaultPendingMs: 300`). In Vitest, poll
   (`expect.poll`, `until`) instead of sleeping.
5. **Retries are measured, never silent.** With one retry, a 5%-probability race turns a run red
   about once in 400 runs but shows in retry telemetry about once in 20.

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

The ladder is strictly ordered, and a new knob keeps it that way. No watchdog budgets for a test
double-burning its timeout (rule 3).

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
(`e2e/support/setup.ts`): a row whose resolved timeout is over it fails before it starts. A row
gated on an opt-in variable (`RUN_*`, `E2E_REAL_MODELS`) or on `localOnly` never starts there.
`scripts/ci/e2e-policy.test.ts`, in the Test job, fails an e2e file whose `sleep`, `delay` or
`setTimeout` literal is over 30s unless `ALLOWED_WAITS` lists it (a named constant passes unseen),
and keeps `E2E_CI_RETRIES` the only retry setting.

A row over the budget has two ways out: **make it faster** (poll for the condition instead of
sleeping through it), or **tag it `slow`** when it waits out real platform time
([slow rows](#slow-rows)). The flake dashboard's **Cost** section prices each row from the last 100
complete runs (p50, p95, marginal wall, retries) and proposes one of the two for a row past its
budget; a proposal to delete a row must name the coverage that replaces it.

### Slow rows

A row that waits out real platform time is tagged `slow` (`test(title, { tags: ["slow"], timeout }, …)`,
timeout up to `E2E_SLOW_ROW_TIMEOUT_MS`) and its file joins `SLOW_ROW_PATHS`. The e2e project sets
`strictTags`, so a misspelled tag fails its row. Today: the three residency rows in
`context-residency.e2e.test.ts` that prove a careless facet stops (110–180 s each), the pin in
`facet-abort-storage-reset.e2e.test.ts` of a Cloudflare fault that resets its context, and the
agents' row in `apps/agents/e2e/install.e2e.test.ts` that publishes three commits, each waiting out
the 5 s snapshot TTL, and voice's row in `apps/agents/e2e/voice-install.e2e.test.ts`, which waits for
the commit's pkg.pr.new build and then a new project's first publication. The
claimed-work row in `context-residency.e2e.test.ts` is not `slow`: it waits 30 s and runs on every PR.

`pnpm preview e2e` chooses whether they run (`scripts/os/slow-rows.ts`) and prints
`[slow-rows] <run|skip|only>: <reason>`:

| Run                          | The slow rows                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A PR push (Preview OS)       | Skipped, unless the PR carries the `slow-e2e` label or edits a slow row's file (`SLOW_ROW_PATHS`). When GitHub does not answer, every row runs.                                                |
| A Preview OS dispatch        | As its `slow-rows` input says (`run` or `skip`); empty, as a push. `--input action=e2e --input slow-rows=run` runs them against the live preview.                                              |
| Main OS e2e, every main push | Run, with every other row (`--slow-rows run`); Main OS e2e's page job pages #error-pulse on their own change of state as soon as the run ends, as "slow e2e rows" (`scripts/monitors/e2e.ts`). |
| You                          | `--slow-rows run`, `skip` or `only` (alone): `pnpm preview e2e --pr <n> --slow-rows only` from `apps/os` under Doppler `os/preview`.                                                           |

**Turn them on** for a PR that can change how long a context or facet stays running, what wakes it,
its alarms, its claims or what its birth resets: the facet host, residency, RPC stubs and built-ins
(`apps/os/src/context/`), the context Durable Object, the alarm coordinator, the processors,
`apps/os/wrangler.base.jsonc` or the compatibility date (`COMPATIBILITY_DATE` in
`packages/iterate/src/compatibility-date.ts`). Add the label before the push (the e2e job reads it
when it starts):

```bash
gh api -X POST repos/iterate/iterate/issues/<n>/labels -f 'labels[]=slow-e2e'
```

or dispatch the run afterwards, as the Preview OS dispatch row above says.

A PR that breaks a slow row without turning them on reaches production first, and its main push
finds it. The suite summary records whether they ran (`slowRows`), and PR time to green splits on it
([Depot CI](depot-ci.md#pr-time-to-green)).

### Retry telemetry

A test that fails and then passes on its one retry does **not** fail an ordinary PR run, but stays
visible. (A stability marathon is stricter: any absorbed retry stops the streak.)

- **Run log**: every workspace's `vitest.config.ts` uses `vitestReporters`
  (`packages/shared/src/test-support/e2e-policy/`), whose `RetryTelemetryReporter` prints
  `[retry-telemetry] N test(s) needed retries: ...` with the first failed attempt's error. Grep a
  run log for `retry-telemetry`; Playwright's `list` reporter marks retried specs.
- **CI**: every test job keeps its runners' telemetry in its
  `<unit|preview-os|main-os>-test-artifacts-attempt-<id>` artifact. A plain
  test that failed and then passed on its CI retry also gets a
  `kind: "unknown"` flake record ([below](#flakes-and-pinned-failures)), and so does one that
  failed every attempt.
- **Volume**: probabilistic regressions need run volume: the soak (`os-e2e-soak.yml`, or
  `pnpm os:e2e-soak --runs N` with `WORKER_BASE_URL`) runs the e2e suite N times against
  one deployed worker, each run followed by the perf budgets, and names every row that did not pass
  every time. A row that fails once in a hundred is a flake; one that fails every time is a bug.
- **Latency is not an e2e assertion**: the e2e run puts 16 files, their rows concurrent, on one
  worker, so its wall clock measures contention. A latency or throughput budget belongs in
  `apps/os/perf/` (the `perf` project), which runs alone and asserts the median of several rounds:
  a new perf row records its metrics with `recordLatency` (`apps/os/perf/record.ts`) under a
  calibrated budget in `apps/os/perf/latency.ts`. The latency guard (`os-latency.yml`) runs that
  suite every 3 hours on a preview of its own and pages on a crossed budget or a sharp regression
  two runs in a row.
- **Neither is how long Cloudflare keeps an actor**: eviction is the platform's decision. An e2e row
  asserts what the platform code decided (a wake, a reset named on a wake record, a facet stopped
  once its window is up); the timing itself is the opt-in
  `apps/os/perf/context-residency.perf.test.ts` (`RUN_RESIDENCY_TIMING=1`, or the soak's
  `residency-timing` input).

When telemetry trends up without failures, investigate. A repeatedly flaky or slow test goes
through the quarantine protocol, not through every unrelated PR.

### Flaky-test quarantine protocol

A row leaves the PR's way in one of three forms, each with a way back:

| Cause                                                      | Form                                                 | Where it runs                                                                                  | Way back                                               |
| ---------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Flaky, always with the same error                          | `createFlake` ([below](#flakes-and-pinned-failures)) | Every PR, where it cannot fail the run                                                         | Unwrapped once its records show it passes consistently |
| Slow: waits out real platform time, or its p95 is over 60s | The `slow` tag ([slow rows](#slow-rows))             | PRs that carry `slow-e2e` or edit its file, every main push (pages on its own change of state) | Rewritten to a p95 of 45s or less, then untagged       |
| Hangs, or harms the rest of the suite                      | A dated skip ([parked](#parked-tests-expire))        | Nowhere; it needs an issue                                                                     | The date forces a decision                             |

Quarantine only a test the current change is shown not to break; a failure in behavior the PR
changed is an ordinary blocker. For an unrelated flake: record the test, its first-attempt error,
the run and its timing; wrap it with `createFlake` and the one error pattern it produces (it keeps
running everywhere, and its records later prove it deserves unwrapping); and say so in the PR
description.

Skip only when the test cannot safely or affordably keep running: it harms the rest of the suite,
it hangs (`createFlake` treats a hang as red), or its runtime is the cost. The skip is the narrowest
`test.skip`/`fixme` (never a title filter, deleted discovery entry, extra retry or swallowed error)
with a `parked:` comment and a `revisit by` date ([below](#parked-tests-expire)), a tracking issue
with the evidence and exit criteria, and a call-out in the PR description and at the top of this
doc. Either form is explicit coverage debt, not a reason to hold an unrelated PR open.

### Flakes and pinned failures

Two wrappers in `packages/shared/src/test-support` register through the runner's own expected-fail variant (Vitest `test.fails`, Playwright `test.fail`), so they report natively, and let exactly one error pattern through. Both take the runner's own `test`, and pass fixtures and options through:

- `createFlake(test, /pattern/)` ([flake-test.ts](../packages/shared/src/test-support/flake-test.ts)) marks a known flake, one that always fails with the same error. The body asserts real behavior. A pass or a failure matching the pattern is green, any other failure or a hang is red, and the test is never retried: one sample per run.
- `createFailing(test, /pattern/)` ([failing-test.ts](../packages/shared/src/test-support/failing-test.ts)) pins a known bug. The body asserts the desired behavior and must fail with the pattern. A pass (the bug looks fixed) or a different failure is red.

```ts
const flake = createFlake(test, /CPU startup time exceeded \d+ms/);
flake("Worker can be deployed", async () => {
  const deployment = await system.deploy();
  await expect.poll(() => fetch(deployment.url)).toMatchObject({ status: 200 });
});

const fail = createFailing(test, /SAME-BOOT STALENESS/, { timeoutMs: 240_000 });
fail("a userspace facet rebuilds on a source commit", async () => {
  // asserts the DESIRED behavior; today it throws the matched error
});
```

The records drive the lifecycle: a test that seems flaky moves to `createFlake`; if it stops passing entirely, switch it to `createFailing`; once it passes consistently, unwrap it back to a plain test.

Every outcome of either wrapper (`createFailing`'s are `pinned-fail` and `unexpected-pass`), and every plain test that failed, is one JSON line in `FLAKE_RECORD_DIR`. A failed plain test is an unknown flake with the first attempt's error: `retried-pass` when its CI retry passed, `unexpected-error` when every attempt failed ([flake-record.ts](../packages/shared/src/test-support/flake-record.ts)). The CI finalizer (`scripts/ci/test-evidence.ts finalize --flake-suites <unit|specs|preview-e2e>`, one suite per job) adds the suite's `suite-summary.json`, and the job keeps both under `flake-records/<suite>/` in its [test evidence](test-evidence.md) folder, in R2 and in its `<unit|preview-os|main-os>-test-artifacts-attempt-<id>` artifact, one per job attempt. Local runs without the variable record nothing.

Every hour the [flake dashboard](https://github.com/iterate/iterate/issues/2580) (`.depot/workflows/flake-dashboard.yml`, `scripts/ci/flake-dashboard/`) reads the recent runs' records and summaries back from R2 and recomputes the whole issue, writing it as the iterate GitHub App. It keeps nothing between runs: main's runs of the last seven days give the wrapped tests' stats and lifecycle streaks, and each suite's newest 150 runs on any branch give the squares, the last three complete runs a row must appear in to stay listed, and the Cost section. On main an unknown flake opens or resets the test's "Unknown flakes" row, whose error samples are the patterns to wrap it with; once wrapped, the test moves to the Flakes section. A retry the platform forced is the exception, judged as the latency guard judges a probe ([platform-failures.ts](../scripts/ci/platform-failures.ts)): a first attempt that failed on a WebSocket with no Close frame, a lost Workers RPC connection, a Durable Object Cloudflare shut down or a fetch with no answer, and a retry that passed. Once in a row it is the pass it was, a 🟦 square and a count on its suite's line; forced in the test's next main run too, it is the test's failure, since a crash of our own Worker reads the same from the client. A test that failed every attempt is always its own failure. The Failures section shows how long each pin has stood and proposes deleting wrappers whose bugs look fixed, while the streak behind the proposal holds.

Each suite carries a monthly `flake sentinel` (`flakeSentinel` in flake-test.ts): a `createFlake` test that throws its allowed error about 10% of the time until its month ends. The three have distinct names, so each gets its own dashboard row: `flake sentinel` (`packages/shared/src/test-support/flake-sentinel.test.ts`), `flake sentinel (specs)` (`specs/flake-sentinel.spec.ts`) and `flake sentinel (e2e)` (`apps/os/e2e/flake-sentinel.e2e.test.ts`). A sentinel that reads 0% or goes red means the recording or ingestion pipeline is broken; distrust the dashboard, not the sentinel. Rolling all three forward is one constant, `SENTINEL_MONTH_END` in flake-test.ts.

#### Pinned bugs: `createFailing(test, …)`, not bare `test.fails`

A bare `test.fails` stays green when the body fails with a different error or outlives its timeout. `createFailing` returns a different failure, a success, or a body still running at its deadline as a success, which the expected-fail machinery rejects: red, with the actual reason in the adjacent `[failing-test]` log line. Its deadline is 30 s, and it sets the runner's own test timeout to that plus a second, so the runner never fires first; a pin that legitimately runs longer raises the deadline with `options.timeoutMs`. Write the body so the bug throws a distinctive message, and so conditions that prove nothing (a coincidental restart masking the bug for one observation) retry instead of succeeding: a bare `test.fails` pin without that false-alarmed 7+ times.

### Parked tests expire

A skip/fixme/todo marker that parks a KNOWN issue is a loan against the
suite, and it carries its terms in a comment on (or right above) the marker:

```ts
// parked: <what is broken, with evidence> — revisit by 2026-11-15
test.skip("…", () => {});
```

Markers without a date are for **structural** reasons only:
platform- or env-gated suites that cannot run in a given context (the
issuer-pages spec skips its email-code row where the deployment offers no
email-code sign-in — that is a property of the target, not a parked bug).

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
probes and the read-only host check. The Preview OS workflow deploys the tested
commit's platform and all six hosted clients, then runs integration and browser tests;
Main OS e2e does the same for each main push, as a deployment of its own.
Operational changes require coherent preview state and telemetry as well as
passing tests; see the [engineering invariant](engineering-invariants.md).
