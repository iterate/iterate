# Testing: Unit, E2E, And Playwright Specs

How the test lanes are organized, how to run each against any environment,
the canonical environment variables, and [the retry/timeout
policy](#retries-and-timeouts) every lane follows. For unit-test style (fake
timers, inline snapshots, `test.for` tables), see
[Vitest patterns](vitest-patterns.md).

## Philosophy

Six principles carry this system. They are conscious design — most trace
to specific people and incidents — and should be argued with, not drifted
away from.

1. **Prove the behavior users actually get.** The default test is e2e from
   very far away: through the itx surface or a real browser, against a
   live deployment, with no test-only seams. Local dev already runs the
   real worker inside vite's workerd, so a live target is always one
   command away.

2. **Fail fast; fix the product, not the timeout.** (Misha Kaletsky's
   design — the [middlewright](https://github.com/iterate/middlewright)
   plugin family, extracted from this repo's test infra.) Playwright
   actions get a brutal 750ms budget that extends — up to ~30s — only
   while the app visibly reports progress (`data-spinner`). A slow flow
   that makes a test flaky is a product bug: add the loading state users
   wanted anyway. In his words: "it makes your test pass fast, fail fast,
   and it incentivises agents to improve the product when tests fail,
   instead of bumping timeouts which makes tests worse and lets your
   product get away with bad UX." Any explicit timeout override carries a
   `// comment` saying why.

3. **Every test owns its state.** Each e2e test and spec provisions its
   own project (unique slug; `projects.create` resolves only after the
   bootstrap saga commits). No shared fixtures, no ordering, no cleanup
   coupling — this is what makes parallel workers and rule 4 sound.

4. **One retry, watchdogs above, telemetry always.** Retries live in
   exactly one layer (the individual test, CI only); everything above is
   a fail-never-retry watchdog sized to ~2× healthy p99; every absorbed
   retry surfaces in the PR table. Budgets are evidence, not vibes — see
   [Retries and timeouts](#retries-and-timeouts) and the marathon audit.

5. **Harnesses must be honest about fidelity.** Where we do unit-test,
   fakes implement the real interfaces (`MemoryStream` honors idempotency
   keys and offset gaps; eviction is an operator: `h.crash()`), every
   vendor-touching processor suite has a refold test, and a harness that
   structurally cannot catch a bug class says so in its file header (the
   `stream-subscribers.teardown.test.ts` pattern).

6. **No workerd test runtime.** There is deliberately no
   `@cloudflare/vitest-pool-workers` lane: unit tests run in plain node
   with a thin `cloudflare:workers` shim (plus capnweb's real workers
   build), and real-runtime coverage comes from the e2e lanes against
   live deployments — production-shaped by construction. Adding a third
   runtime needs a proven coverage gap, not a preference.

## Lanes

| Lane             | Command (from `apps/os` unless noted) | Lives in                                | Proves                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit             | `pnpm test`                           | `apps/os/src/**/*.test.ts` (colocated)  | In-process logic; no deployment needed.                                                                                                                                                                                                                                                                                                                                                                            |
| OS e2e           | `pnpm e2e`                            | `apps/os/e2e/` (`e2e/vitest.config.ts`) | One config, one project (`node`) against a live deployment through the itx surface: engine e2e (`e2e/vitest/` — streams, security, ingress, agents, admin, preview smoke) plus the itx catalogue matrix (`e2e/examples/` — every example across the four server-side runtimes: node, cli, run-script, project-worker). Browser coverage for the catalogue is `specs/repl-examples.spec.ts`, through the real REPL. |
| TUI              | `pnpm exec tsx e2e/tui-test/run.ts`   | `apps/os/e2e/tui-test/`                 | The `iterate chat` TUI through a real PTY (Microsoft TUI Test) against a disposable project.                                                                                                                                                                                                                                                                                                                       |
| Playwright specs | `pnpm spec` (repo root)               | `specs/` (`playwright.config.ts`)       | Browser-level product flows: signup, project create, dashboard, REPL, agent chat, reactivity.                                                                                                                                                                                                                                                                                                                      |

Smoke-testing a deployment (what the deploy pipeline probes automatically,
plus manual/agent recipes for production): [Smoke testing](smoke-testing.md).

## What earns a test

The default is a covering e2e. A **unit test** earns its place in exactly
two ways:

- **Wide case tables.** Fold/reduce logic, parsers, pure functions — and
  above all stream processors: many event-ordering and redelivery cases
  that would be too slow or expensive to run e2e. These get purpose-built
  node harnesses (see
  [Writing & testing stream processors](writing-stream-processors.md)) and
  captured-journal incident repros (`stream-repros/iterate-pr-NNNN-*`).
- **Tiny kernels.** Zero-maintenance guards for adversarial and security
  invariants: bad-signature ⇒ 401 before routing, path-escape rejection,
  ciphertext binding, secret redaction in `inspect()`, tenancy-collision
  checks. Small, hostile inputs, cheap to keep — these stay even though
  each one is thin.

### Ship-with rules

New work of these shapes ships WITH these tests. Absence is a review
blocker, not a style note:

| You built                                           | It ships with                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stream processor, or a new side-effect arm in one | A harness suite including a **refold test** (replay the whole journal ⇒ zero side effects, zero appends); if it holds obligations, an **eviction-recovery** test (`h.crash()` mid-flight) |
| An itx capability or API surface                    | A catalogue example proven by the examples matrix (and thereby every runtime), plus engine e2e for its failure arms                                                                       |
| A product flow in the dashboard                     | A Playwright spec under `specs/`, readable as a product spec                                                                                                                              |
| An incident fix with a journal-shaped cause         | A captured-journal repro named for the PR (`stream-repros/`)                                                                                                                              |

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

## Test dimensions (DRAFT — under discussion)

Every test sits somewhere on five axes, and the rule mirrors the env-var
doctrine: **one control per dimension, no parallel mechanisms**, and the
vanilla `vitest` / `playwright` CLIs keep working. Dimensions are expressed
through file names, project selection, and environment presence — never a
bespoke runner.

| Dimension    | Values                                            | Controlled by                                                                                                         | Status         |
| ------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| Surface      | in-process / itx API / browser / PTY              | which lane you invoke (`pnpm test` / `pnpm e2e` / `pnpm spec` / tui) + vitest `--project`                             | works today    |
| Speed        | fast / slow-by-contract                           | per-test `{ timeout }` capped at `E2E_HEAVY_TEST_TIMEOUT_MS`; the slowest-first sequencer feeds on observed seconds   | works today    |
| Determinism  | deterministic / retry-absorbed                    | `E2E_CI_RETRIES = 1` + retry telemetry — a nondeterministic test that retries is visible, never silent                | works today    |
| Cost         | free / pays for LLM turns                         | **gap** — implicit today (the onboarding smoke and codemode proofs pay; nothing marks them)                           | proposal below |
| Remote reach | hermetic / hits a deployment / hits a third party | **partial** — `APP_CONFIG_INTEGRATIONS__*` presence gates third-party suites; deployment-reach is implied by the lane | proposal below |

Draft proposal for the two gaps, keeping vanilla CLIs:

- Put the **cost** dimension in the filename, the same way lanes already
  live there: `*.llm.e2e.test.ts` for tests that pay for model turns.
  Filename dimensions compose with plain vitest filtering
  (`pnpm e2e llm`), grep, and the sequencer — no runner machinery. The
  e2e-policy guard test can then enforce the budget structurally: files
  NOT tagged `.llm.` must not import the agent-turn helpers.
- Keep **third-party reach** on environment presence (the doppler-native
  control we already have); it composes with per-env secrets and skips
  cleanly when a config lacks the integration.
- Playwright's native tags (`@slow`, `--grep`) are the escape hatch on the
  specs side if a spec ever needs a dimension; don't build it until one
  does.

Open questions for the next grilling round: is the filename the right home
for cost (vs a lint-enforced import rule alone)? Should third-party reach
be visible in filenames too, or is env-gating enough? Does "slow" deserve
a filename marker so the sequencer stops needing hand-maintained observed
seconds?

## Running a lane against an environment

Every non-unit lane targets a live deployment and is invoked the same way:

```bash
doppler run --config <cfg> -- pnpm <lane>
```

The Doppler config supplies the deployment identity — `APP_CONFIG_BASE_URL`
and `APP_CONFIG_ADMIN_API_SECRET` (plus optional integration secrets):

```bash
# local dev (start `pnpm dev` first; base URL comes from the discovery file)
doppler run --config dev -- pnpm e2e

# a preview slot
doppler run --config preview_3 -- pnpm e2e

# production
doppler run --config prd -- pnpm e2e
```

Local configs (`dev`, `dev_<you>`) do not set `APP_CONFIG_BASE_URL`; the
harness falls back to the dev-server discovery file
(`apps/os/.dev-server/dev-server.json`, written by `pnpm dev`). To point a lane at
a custom target (captun, another port), set the base URL explicitly _inside_
the Doppler environment:

```bash
doppler run --config dev -- env APP_CONFIG_BASE_URL=http://localhost:1234 pnpm e2e
```

## Using Tunnels In Tests

Use [Iterate tunnels](tunnels.md) when a test target cannot reach the test
runner directly. The common case is a deployed preview Worker calling an e2e
fixture: `127.0.0.1` belongs to the Worker runtime, not the CI runner, so the
fixture must be published at a public HTTPS URL.

Tunnel-backed tests should run inside Doppler so `CAPTUN_TOKEN` is available:

```bash
doppler run --project os --config dev -- pnpm e2e
```

OS e2e fixtures should use `withTunnel()` from
`apps/os/e2e/test-support/tunnel.ts`. It returns a loopback URL for local dev
targets and a captun URL when `APP_CONFIG_BASE_URL` points at a deployed
worker. Lower-level scripts can use
`createCaptunTunnel({ fetch, token, gateway })` from `captun`.

Omit `name` for isolated test fixtures; pass `name` only when a stable
callback URL is required:

```text
https://<name>.tunnels.iterate.com
```

The gateway forwards HTTP and WebSockets. That makes it suitable for webhook
receivers, OAuth callbacks, local dev server access, and e2e fixtures that need
streaming or WebSocket behavior.

## Environment variables

The rule: **one name per control, and no variable without a real setter**.
`APP_CONFIG_*` variables come from the Doppler config and describe the
deployment under test — tests never invent parallel names for them. The two
`OS_E2E_TUI_*` variables and `E2E_RETRY_TELEMETRY_FILE` are the only harness
knobs. Nothing else exists (the root Playwright config additionally honors
the Playwright-conventional `CI` and `VIDEO_MODE`).

| Variable                         | Set by                                                  | Controls                                                                                                         | Default                         |
| -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `APP_CONFIG_BASE_URL`            | Doppler (deployed configs); unset in local configs      | THE deployment under test, for every lane                                                                        | Local dev-server discovery file |
| `APP_CONFIG_ADMIN_API_SECRET`    | Doppler                                                 | Admin credential for the itx surface (project seeding, admin lanes)                                              | None — lanes that need it throw |
| `APP_CONFIG_INTEGRATIONS__SLACK` | Doppler                                                 | Gates the slack-agent e2e suite (provides the Slack signing secret)                                              | Unset → suite skips             |
| `E2E_RETRY_TELEMETRY_FILE`       | The preview lane (`scripts/preview/preview.ts`), or you | Where the vitest `RetryTelemetryReporter` writes its JSON (see [Retries and timeouts](#retries-and-timeouts))    | Unset → log line only, no file  |
| `OS_E2E_TUI_PROJECT_ID`          | `e2e/tui-test/run.ts` (internal; passed to the spec)    | The disposable project the TUI spec chats against                                                                | Unset → TUI spec skips          |
| `OS_E2E_TUI_SNAPSHOT`            | You                                                     | `"1"` opts into the manual aesthetic TUI snapshot test                                                           | Skipped                         |
| `GITHUB_SHA`                     | GitHub Actions (ambient)                                | Labels the preview-smoke seed project slug in CI                                                                 | `"manual"`                      |
| `CI`                             | GitHub Actions                                          | Playwright: `forbidOnly`, one retry, trace on first retry, never reuse an existing dev server                    | Unset locally                   |
| `VIDEO_MODE`                     | You                                                     | `"1"` records spec demo videos with relaxed timeouts — see [Video mode](#video-mode-recorded-spec-demos-for-prs) | Video only retained on failure  |

## Artifacts

- **The Vitest e2e suite** writes a per-run artifact root under the OS temp dir
  — `os-e2e-*` (`/tmp/os-e2e-*` on Linux/CI) — containing per-test console
  logs. The active root is printed at startup
- **Playwright** writes `test-results/` at the repo root: traces, videos, and
  screenshots under `test-results/playwright-output`, plus HTML and JSON
  reports.
- **Preview CI** collects all of the above (`test-results`,
  `apps/os/test-results`, `/tmp/os-e2e-*`) into the repo-level
  `test-results/` directory, then uploads that one workspace-relative directory
  as a CI artifact. The collection paths live in
  `scripts/preview/collect-test-artifacts.sh`.

## Where test helpers live

Four layers. A helper lives at the **lowest layer all its consumers share**,
and imports point **down** only. When both lanes need a helper, it moves down
a layer — never sideways into a copy.

| Layer                     | Home                                                                                | Charter                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0 policy & infra         | `packages/shared/src/test-support/`                                                 | Runner-agnostic: the [e2e-policy budgets and retry telemetry](#retries-and-timeouts) (`e2e-policy/`), vitest run-artifact plumbing (`vitest-e2e/`), the fixture slug convention (`fixture-slug.ts`).                                        |
| L1 environment & identity | `apps/os/scripts/` and `scripts/auth/`                                              | The deployment under test and who you are against it: dev-server lifecycle (`dev.ts`, `lib/dev-server-info.ts`), Doppler plumbing, the auth forge (`scripts/auth/forge-token.ts` behind `pnpm auth:mint`). Consumed by both lanes' configs. |
| L2 surface clients        | `apps/os/e2e/test-support/` (itx surface) · `specs/test-support/` (browser surface) | Lane-specific clients and fixtures: admin itx handles and disposable projects on the itx side; forged browser sessions and page plugins on the Playwright side.                                                                             |
| L3 domain harnesses       | `apps/os/src/domains/*/test-helpers.ts`, colocated with the domain                  | Unit-lane fakes implementing real interfaces (stream processor harnesses etc.); never imported by L2 or above.                                                                                                                              |

Anti-goal: one mega test-support package. That would drag itx clients and
forge machinery into a package that production workers import; the layers keep
the credentialed, lane-specific pieces at the edges that need them. The
"lowest shared layer" rule is also deliberately lazy — e.g.
`apps/os/e2e/test-support/wait-for-condition.ts` stays L2 until a Playwright
spec actually needs it: "needed by both lanes" is proven by a consumer, not
predicted.

## Video mode: recorded spec demos for PRs

Any Playwright spec re-runs as a watchable demo — pointer highlights on every
action, dead air compressed, the blank startup lead-in trimmed. Design and
plugin by Misha: [middlewright](https://github.com/iterate/middlewright)'s
`videoMode`, wired in `specs/test-support/test.ts`; the auto start-trim
shipped in iterate/middlewright#3 / PR #1788.

```bash
# local dev, one flow (the config auto-starts the dev server; specs read
# os secrets from the apps/os Doppler scope themselves)
VIDEO_MODE=1 pnpm spec -g "dashboard"

# against a deployed slot — note --project os: the repo root scopes to
# _shared, which lacks the os APP_CONFIG_* values the specs need
doppler run --project os --config preview_3 -- env VIDEO_MODE=1 pnpm spec -g "dashboard"
```

`VIDEO_MODE=1` flips two things:

- **Config** (`playwright.config.ts`): `video: "on"` plus relaxed budgets
  (10s `actionTimeout`, 300s test timeout) so highlight pauses don't trip the
  deliberately-tight normal budgets.
- **Plugin** (`videoMode` in `specs/test-support/test.ts`): records each
  action's bounding box during the run, then post-renders with ffmpeg (must
  be installed): pointer highlights, dead-air spans >300ms sped up, a 1s
  final hold, and the blank `about:blank`-to-first-paint lead-in trimmed
  automatically (`trimStart: "auto"`, pixel-based; an explicit
  `page.videoMode.setStartTime()` in a spec still wins).

Output lands under `test-results/playwright-output/<test-title-dir>/`:
`video-rendered.webm` (the demo), `video-raw.webm`, and a `video-mode.html`
frame-stepper, all also attached to the HTML report.

**Getting the video into a PR description is manual** — the "automatic" part
is only the recording/trimming. GitHub renders an inline video player only
for `user-attachments` URLs, and only its web editors mint those (`<video>`
tags pointing at any other host are sanitised — which is why older PRs fell
back to release-asset GIFs, e.g. PR #1764):

1. Convert for the widest GitHub support:
   `ffmpeg -i video-rendered.webm demo.mp4`.
2. Drag (or paste) `demo.mp4` into the PR-description editor on github.com.
   GitHub uploads it and inserts a `https://github.com/user-attachments/assets/…`
   URL — leave it on its own line and it renders as an inline player. There
   is no API or `gh` route for this upload. PR #1788's before/after clip is
   the working example.

## Retries and timeouts

Every number and retry knob in the e2e system follows five rules. The
constants live in **`packages/shared/src/test-support/e2e-policy/budgets.ts`**
(one file, every config imports it) and
`scripts/preview/e2e-policy.test.ts` guards the invariants — including the
files that can't import TypeScript constants (shell). The evidence behind the
rules is the 50-consecutive-green-run marathon audit in
[preview-e2e-flake-hunt.md](preview-e2e-flake-hunt.md) (~5,800 test
executions: ~0.5% of tests needed their single retry, none ever needed a
second, and every mechanism above the test layer either never fired or fired
only on genuine infra wedges).

1. **Retries live in exactly one layer: the individual test.** The test is
   the smallest unit that owns its state — every test (and every
   onboarding-smoke attempt) provisions its own project — so it is the
   cheapest genuinely independent trial. `E2E_CI_RETRIES = 1` in CI, zero
   locally, everywhere: retrying anything larger re-runs minutes of healthy
   work to re-roll one six-second dice.
2. **Everything above a test is a watchdog: it fails, it never retries.**
   The preview vitest lane gets a hard `timeout`; a whole run gets a
   kill-tree watchdog; the Depot job has `timeout-minutes`. Re-running a
   killed run is the outer edge's job (the Depot re-run button, the next
   push) — never automatic.
3. **Watchdogs are sized to ~2× the healthy p99 of what they bound — never
   to accommodate worst-case retry stacks.** A run burning retries against a
   wedged platform _should_ get killed; both historical watchdog kills were
   genuine infra wedges where retrying was hopeless.
4. **Waits are progress-based; static budgets are backstops.** The
   Playwright `actionTimeout` is a tight 750ms; the
   [middlewright](https://github.com/iterate/middlewright) spinner-waiter
   extends it — up to ~30s — only while the
   app visibly reports progress. An app that goes blank fails fast instead
   of being slept through: this exact tightness caught a real blank-render
   product bug (flake 21). Don't widen budgets to paper over a missing
   loading state.
5. **Retries are measured, never silent.** With one retry, a
   5%-probability real race turns a run red about once in 400 runs — but
   shows up in retry telemetry about once in 20. The count is the detector;
   see below.

### The ladder

| What it bounds             | Knob                                  | Where                                                              | Value                                     | On expiry                   |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- | --------------------------- |
| One UI action              | `actionTimeout` + spinner-waiter      | `playwright.config.ts` ← `SPEC_ACTION_TIMEOUT_MS`                  | 750ms (→ ~30s with spinner)               | fail the attempt            |
| One assertion              | `expect.timeout`                      | `playwright.config.ts` ← `SPEC_EXPECT_TIMEOUT_MS`                  | 15s                                       | fail the attempt            |
| One Playwright spec        | `timeout`                             | `playwright.config.ts` ← `SPEC_TEST_TIMEOUT_MS`                    | 90s                                       | retry once (CI)             |
| One vitest e2e test/hook   | `testTimeout` / `hookTimeout`         | `apps/os/e2e/vitest.config.ts` ← `E2E_TEST_TIMEOUT_MS`             | 120s                                      | retry once (CI)             |
| A container-cold-boot test | per-test `{ timeout }`                | individual tests, capped at `E2E_HEAVY_TEST_TIMEOUT_MS`            | ≤ 240s                                    | retry once (CI)             |
| The onboarding smoke gate  | attempt loop                          | `apps/os/e2e/vitest/onboarding-smoke.ts`                           | 90s greeting wait                         | one more attempt, then fail |
| Each preview sub-lane      | `timeout N <lane command>`            | `scripts/preview/preview.ts` ← `OS_PREVIEW_LANE_TIMEOUT_SECS`      | 480s                                      | **fail — never retry**      |
| One whole preview run      | `RUN_TIMEOUT_SECS` kill-tree watchdog | `scripts/preview/flake-hunt-loop.sh` ← `PREVIEW_RUN_WATCHDOG_SECS` | 600s                                      | **kill — never retry**      |
| The Depot CI job           | `timeout-minutes`                     | `.depot/workflows/*.yml`                                           | 10–45 (mainline/preview) / 300 (marathon) | outer edge: re-run button   |

The ladder is strictly ordered and the guard test asserts it stays that way.
Note the deliberate rule-3 consequence: the 480s lane watchdog does _not_
budget for a heavy test double-burning its 240s cap, and the 600s run
watchdog does not budget for the lane doing that twice.

### Retry telemetry

A retried test is a real failure that a re-roll absorbed — it must stay
visible:

- **Run log**: vitest lanes print `[retry-telemetry] N test(s) needed
retries: ...` (the `RetryTelemetryReporter` in
  `packages/shared/src/test-support/e2e-policy/`); the onboarding smoke
  prints the same marker when it needed attempt 2. Grep any run log for
  `retry-telemetry`.
- **Preview CI**: the os lane writes the vitest telemetry JSON (via
  `E2E_RETRY_TELEMETRY_FILE`) and Playwright's `playwright-results.json`;
  `scripts/preview/preview.ts` folds both into a `retries` column in the
  PR-body table and a `::notice::` annotation (escalating to `::warning::`
  when ≥4 tests retried in one run — that smells slot-wide, not
  probabilistic).
- **Volume**: probabilistic regressions need run volume to detect — that is
  what the on-demand marathon is for
  (`.depot/workflows/preview-e2e-marathon.yml`, N consecutive runs of the
  full preview lane on Depot). Watch the retry counts across a marathon, not
  just the pass/fail streak.

When telemetry trends up without failures, treat it exactly like a budget
`::warning::`: find the cause, don't wait for red.
