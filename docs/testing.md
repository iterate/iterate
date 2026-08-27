# Testing: Unit, E2E, And Playwright Specs

How the test lanes are organized, how to run each against any environment,
the canonical environment variables, and [the retry/timeout
policy](#retries-and-timeouts) every lane follows. For unit-test style (fake
timers, `test.for` tables with hand-written literal expectations), see
[Vitest patterns](vitest-patterns.md).

For cross-run timing analysis and the PostHog event/query contract, see
[CI and test telemetry](ci-test-telemetry.md). Every runner writes the same raw
artifact contract (not only retries); one always-running CI finalizer validates,
normalizes, retains, and sends Playwright attempts/steps, Vitest
hook/body/module/import timing, Node attempts, and standalone smoke phases.

> [!CAUTION]
> **🔥 CLOUDFARE ARTIFACTS EVENT DELIVERY IS QUARANTINED.** The former bridge
> synchronously created/reconciled an account-level event subscription for
> every repository. That made every otherwise-independent project bootstrap
> contend on one rate-limited Cloudflare control plane and caused fleet-wide
> `429`, `500`, and correlated timeout bursts. Project and repository creation
> must never call Cloudflare queue or event-subscription control-plane APIs.
> The queue consumer and all subscription reconciliation have been removed.
> Repository reads, writes, builds, and readiness remain active; automatic
> Artifact-push → `repo/commit-completed` / `repo/task-*` delivery does not.
> Its live e2e is explicitly skipped and restoration is owned by
> [`tasks/quarantined-cloudflare-artifacts-event-delivery.md`](../tasks/quarantined-cloudflare-artifacts-event-delivery.md).

> [!CAUTION]
> **🔥 LIVE-CAPABILITY WEBSOCKET MESH E2E IS QUARANTINED.** Its boundary
> probe caught the expected serialization failure and reported a pass, then
> deterministically caused the Workers runtime to cancel the shared OS isolate.
> In the fully parallel suite that severed 19 unrelated ITX sessions with
> WebSocket code 1006. The two explicit skips cover only the known-unsupported
> Node live-capability → internal Worker mesh WebSocket upgrade; ordinary live
> capabilities, project-app WebSockets, and all other OS e2e coverage remain
> active. Evidence and restoration criteria live in
> [`tasks/quarantined-live-capability-websocket-e2e.md`](../tasks/quarantined-live-capability-websocket-e2e.md).

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
   own project (unique slug; `projects.get(slug).create` resolves only after the
   bootstrap saga commits). No shared fixtures, no ordering, no cleanup
   coupling — this is what makes parallel workers and rule 4 sound.

4. **One retry, watchdogs above, telemetry always.** Retries live in
   exactly one layer (the individual test, CI only); everything above is
   a fail-never-retry watchdog sized to ~2× healthy p99; every absorbed
   retry surfaces in the PR table but does not make an otherwise-green
   ordinary PR run fail. A recurring or pathologically slow unrelated flake
   is explicitly quarantined and tracked instead of repeatedly taxing the
   critical path.
   Budgets are evidence, not vibes — see [Retries and
   timeouts](#retries-and-timeouts) and the marathon audit.

5. **Harnesses must be honest about fidelity.** Where we do unit-test,
   fakes implement the real interfaces (`MemoryStream` honors idempotency
   keys and offset gaps; eviction is an operator: `h.crash()`), every
   vendor-touching processor suite has a refold test, and a harness that
   structurally cannot catch a bug class says so in its file header (the
   `stream-event-sender.teardown.test.ts` pattern).

6. **No workerd test runtime.** There is deliberately no
   `@cloudflare/vitest-pool-workers` lane: unit tests run in plain node
   with a thin `cloudflare:workers` shim (plus capnweb's real workers
   build), and real-runtime coverage comes from the e2e lanes against
   live deployments — production-shaped by construction. Adding a third
   runtime needs a proven coverage gap, not a preference.

## Lanes

The geography rule: `specs/` tests the product through a browser;
`<app>/e2e/` tests that deployable's own contract. Every e2e suite must be
wired to a CI lane or explicitly documented as manual — a tag filter or
unset env var that silently skips tests is the failure mode this table
exists to prevent (a `@preview` title filter once quietly reduced the
streams example app's CI coverage to 3 of ~37 tests while the rest rotted).

| Lane                | Command (from `apps/os` unless noted)             | Lives in                                | In CI                                                                                                                       | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                | `pnpm test`                                       | `apps/os/src/**/*.test.ts` (colocated)  | Depot **Test** workflow, every PR — full suite                                                                              | In-process logic; no deployment needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| OS e2e              | `pnpm e2e`                                        | `apps/os/e2e/` (`e2e/vitest.config.ts`) | Preview CI when OS is selected — full `node` project (`browser` project covered by the REPL specs instead)                  | One config, one project (`node`) against a live deployment through the itx surface: engine e2e (`e2e/vitest/` — streams, security, ingress, agents, admin, preview smoke) plus the itx catalogue matrix (`e2e/examples/` — every example across the four server-side runtimes: node, cli, run-script, project-worker). Browser coverage for the catalogue is `specs/repl-examples.spec.ts`, through the real REPL.                                                                                                                                                                 |
| TUI                 | `pnpm exec tsx e2e/tui-test/run.ts`               | `apps/os/e2e/tui-test/`                 | **Quarantined** — `run.ts` is an explicit no-op skip; see [`tasks/quarantined-tui-e2e.md`](../tasks/quarantined-tui-e2e.md) | Nothing while quarantined. The specs and `tui-test.config.ts` stay in place as the starting point for reviving the installed-user `iterate chat` path (built package, OpenTUI renderer, shared itx/TanStack data layer, live feed, send flow).                                                                                                                                                                                                                                                                                                                                     |
| Playwright specs    | `pnpm spec` (repo root)                           | `specs/` (`playwright.config.ts`)       | Preview CI when OS is selected — full suite                                                                                 | Browser-level product flows: signup, project create, dashboard, REPL, agent chat, reactivity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Semaphore e2e       | `pnpm test:e2e` (from `apps/semaphore`)           | `apps/semaphore/e2e/`                   | Preview CI when semaphore is selected — full suite (both files); fails fast without `SEMAPHORE_BASE_URL`                    | The lease API's full contract against a live worker: auth rejection, CRUD, blocking `waitMs` acquire, holder + force acquire/release, least-recently-released handout order, the typed contract client.                                                                                                                                                                                                                                                                                                                                                                            |
| Auth e2e            | `pnpm test:e2e` (from `apps/auth`)                | `apps/auth/e2e/`                        | Preview CI whenever auth deploys (selected directly, or as the os/semaphore dependency); fails fast without `AUTH_BASE_URL` | The OAuth2/OIDC provider's own contract against a live worker: discovery endpoints match the deployed origin, dynamic registration → authorize (PKCE) → consent → code → token exchange, JWKS-verified access-token claims, the RFC 8707 resource allowlist (the streams.iterate.com incident resource accepted, unknown origins' exact rejection), and redirect_uri pinning at both authorize and exchange. Needs the auth Doppler config (service token + fixed test OTP), so it targets dev/preview, never prd — the lane the PR #1862 stale-registration incident was missing. |
| Streams example app | `pnpm test:e2e` (from `apps/streams-example-app`) | `apps/streams-example-app/e2e/`         | Preview CI when the app is selected — full suite (vitest + Playwright), no tag filter                                       | The streams stack from very far away: capnweb wire protocol over real WebSockets, node-hosted processors, and the browser OPFS/SQLite mirror UI (leadership, virtualization, kill/reconnect) against a deployed playground.                                                                                                                                                                                                                                                                                                                                                        |
| Dummy petshop e2e   | `pnpm test:e2e` (from `apps/dummy-petshop`)       | `apps/dummy-petshop/e2e/`               | Preview CI when the app is selected — full suite; fails fast without `PETSHOP_BASE_URL`                                     | The OAuth/API fixture's own contract against its deployed worker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The normal Depot **Test** workflow runs `pnpm test` from the repo root. That
recursively runs every workspace's `test` script, including the `iterate` CLI
and dummy-petshop's unit suite. Live tests with separate `test:e2e` scripts
belong to preview CI instead: dummy-petshop is deployed and runs its complete
live e2e whenever that app is selected. Selecting OS also selects and deploys
dummy-petshop first, then passes that same leased preview's recorded
`PETSHOP_BASE_URL` into the OS e2e lane. The OS Petshop integration specs fail
CI if that URL is absent; they cannot silently skip back out of preview CI.

The quarantined TUI specs and configuration remain as evidence and a starting
point for the linked restoration task, but they are not active coverage. The
preview lane invokes the explicit no-op `run.ts` stub so the skip is visible in
the job log; it does not install Bun or run a hidden subset. Any suite a CI lane
does not run in full is a wiring bug unless the table names the quarantine or
manual status. A test that genuinely cannot run against a deployed target
carries an explicit in-code skip with a named guard and a comment saying why,
so exclusion is always visible where the test lives.

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

| You built                                           | It ships with                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stream processor, or a new side-effect arm in one | A harness suite including a **refold test** (replay the whole journal ⇒ zero side effects, zero appends); if it holds obligations, an **eviction-recovery** test (`h.crash()` mid-flight)                                                                                                 |
| An itx capability or API surface                    | A catalogue example proven by the examples matrix (and thereby every runtime), plus engine e2e for its failure arms. A test exercising a catalogue pattern runs the entry itself by id (`runExample`, `apps/os/e2e/test-support/run-example.ts`); hand-rolled scripts are for probes only |
| A product flow in the dashboard                     | A Playwright spec under `specs/`, readable as a product spec                                                                                                                                                                                                                              |
| An incident fix with a journal-shaped cause         | A captured-journal repro named for the PR (`stream-repros/`)                                                                                                                                                                                                                              |

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
| Cost         | free / pays for LLM turns                         | **gap** — implicit today (the agent smoke and codemode proofs pay; nothing marks them)                                | proposal below |
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

The free-and-deterministic alternative to paying for turns is the `intercepted/*`
model lane: `itx.ai.intercept(handler)` installs a live handler (an in-memory
function in the test process, session-bound over capnweb) that serves every
model under `intercepted/` — both `itx.ai.run("intercepted/…")` calls and full agent
conversation turns for agents configured with `model: "intercepted/<x>"`. The whole
loop runs for real — debounce, journaled llm-request events, chunk streaming,
codemode, chat reply — with the test scripting each response. Non-fake models
are never interceptable, so a journaled `openai/*` turn is always the real
provider. Reach for a paid `.llm.` test only when the point IS real-model
integration. Usage guide (handler contract, the session-bound lifetime and
4901 recovery contract, spec/node recipes):
[Intercepted models](intercepted-models.md).

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
deployment under test — tests never invent parallel names for them.
The root Playwright config additionally honors the Playwright-conventional
`CI` and `VIDEO_MODE`. The dormant TUI lane's `OS_E2E_TUI_*` contract lives in
`apps/os/e2e/tui-test/tui-test.config.ts` and returns to this table if that
lane is revived.

| Variable                             | Set by                                                | Controls                                                                                                                | Default                               |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `APP_CONFIG_BASE_URL`                | Doppler (deployed configs); unset in local configs    | THE deployment under test, for every lane                                                                               | Local dev-server discovery file       |
| `APP_CONFIG_ADMIN_API_SECRET`        | Doppler                                               | Admin credential for the itx surface (project seeding, admin lanes)                                                     | None — lanes that need it throw       |
| `APP_CONFIG_INTEGRATIONS__SLACK`     | Doppler                                               | Gates the slack-agent e2e suite (provides the Slack signing secret)                                                     | Unset → suite skips                   |
| `SLACK_CI_BOT_TOKEN`                 | Doppler (`_shared/prd`; injected or loaded by helper) | **Inbound message actor** for real Slack smokes (Niterate). Not the product bot — see [Slack testing](slack-testing.md) | Unset → scripted smokes cannot post   |
| `TEST_TELEMETRY_ARTIFACT_FILE`       | The preview orchestrator, or you                      | Optional named immediate canonical JSON used by the PR retry summary                                                    | Unset → no immediate copy             |
| `TEST_TELEMETRY_ARTIFACT_DIR`        | CI, or you                                            | Durable canonical JSON directory consumed by the always-running finalizer                                               | Unset → reporter does not write       |
| `TEST_TELEMETRY_KIND`                | CI/orchestrator                                       | Shared `unit`, `integration`, or `e2e` dimension                                                                        | Runner-appropriate default            |
| `TEST_TELEMETRY_LANE`                | CI/orchestrator                                       | Shared lane dimension (`unit`, `vitest`, `playwright`, `agent-smoke`, …)                                                | Runner-appropriate default            |
| `TEST_TELEMETRY_APP`                 | Preview orchestrator                                  | Deployed application dimension                                                                                          | Unset outside app e2e                 |
| `TEST_TELEMETRY_PREVIEW_SLOT`        | Preview orchestrator                                  | Preview slot dimension                                                                                                  | Unset outside preview                 |
| `TEST_TELEMETRY_HEAD_SHA`            | Preview orchestrator                                  | Exact tested commit identity, including manually dispatched PR runs                                                     | Ambient GitHub SHA, then local HEAD   |
| `TEST_TELEMETRY_BRANCH`              | Preview orchestrator                                  | Exact tested source branch, including manually dispatched PR runs                                                       | Ambient GitHub head/ref name          |
| `TEST_TELEMETRY_PULL_REQUEST_NUMBER` | Preview orchestrator                                  | Exact selected PR identity for manually dispatched preview runs                                                         | Ambient pull-request ref, then unset  |
| `TEST_TELEMETRY_EXPECTED_WORKSPACES` | CI finalizer                                          | Comma-separated unit workspaces that must each have emitted one runner artifact                                         | Unset → require at least one artifact |
| `GITHUB_SHA`                         | GitHub Actions (ambient)                              | Labels the preview-smoke seed project slug in CI                                                                        | `"manual"`                            |
| `CI`                                 | GitHub Actions                                        | Playwright: `forbidOnly`, one retry, trace on first retry, never reuse an existing dev server                           | Unset locally                         |
| `VIDEO_MODE`                         | You                                                   | `"1"` records spec demo videos with relaxed timeouts — see [Video mode](#video-mode-recorded-spec-demos-for-prs)        | Video only retained on failure        |

## Artifacts

- **Every instrumented runner** atomically writes schema-validated JSON under
  `test-results/ci-telemetry/raw`. The finalizer writes the exact PostHog batch
  and manifest under `test-results/ci-telemetry/normalized`. Both remain in the
  uploaded workflow artifact even when a test or delivery fails. See
  [CI and test telemetry](ci-test-telemetry.md) for replay and query examples.
- **The Vitest e2e suite** writes a per-run artifact root under the OS temp dir
  — `os-e2e-*` (`/tmp/os-e2e-*` on Linux/CI) — containing per-test console
  logs. The active root is printed at startup
- **Playwright** writes `test-results/` at the repo root: traces, videos, and
  screenshots under `test-results/playwright-output`, plus HTML and JSON
  reports.
- **Microsoft TUI Test** (dormant while the TUI lane is skipped) writes full
  PTY traces under `apps/os/e2e/tui-test/tui-traces`; the preview wrapper
  still captures the (stub) runner log at `/tmp/os-preview-tui.log`.
- **Preview CI** collects all of the above (`test-results`,
  `apps/os/test-results`, `apps/os/e2e/tui-test/tui-traces`,
  `/tmp/os-e2e-*`, and `/tmp/os-preview-*.log`) into the repo-level
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

## Data fixtures with regenerable outputs

`apps/os/src/domains/agents/prompt-scenarios/` is the pattern reference: one
markdown file per scenario holds input events (YAML fence) and output fences
computed by the real prompt fold. Plain runs assert the outputs (and the
generated `explainers/prompt-sections.html`) are byte-fresh; refresh with:

```bash
cd apps/os && pnpm vitest run prompt-scenarios -u
```

Commentary lives in an `annotations.yaml` fence ({request, find, comment});
the harness re-weaves `#` comment lines into regenerated outputs, and an
annotation matching nothing fails the test. See `fixture-helpers.ts` for the
format.

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
   the smallest unit that owns its state — independently scheduled tests (and
   every agent-smoke attempt) provision isolated projects — so it is the
   cheapest genuinely independent trial. `E2E_CI_RETRIES = 1` in CI, zero
   locally, everywhere: retrying anything larger re-runs minutes of healthy
   work to re-roll one six-second dice.
2. **Everything above a test is a watchdog: it fails, it never retries.**
   The preview TUI and vitest lanes get hard `timeout`s; a whole run gets a
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

| What it bounds              | Knob                                   | Where                                                                                             | Value                                          | On expiry                                                   |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| One UI action               | `actionTimeout` + spinner-waiter       | `playwright.config.ts` ← `SPEC_ACTION_TIMEOUT_MS`                                                 | 750ms (→ ~30s with spinner)                    | fail the attempt                                            |
| One assertion               | `expect.timeout`                       | `playwright.config.ts` ← `SPEC_EXPECT_TIMEOUT_MS`                                                 | 15s                                            | fail the attempt                                            |
| One TUI workflow spec       | _(lane skipped — see the lanes table)_ | `apps/os/e2e/tui-test/` ← `SPEC_EXPECT_TIMEOUT_MS` / `TUI_TEST_TIMEOUT_MS`                        | 15–30s assertions; 55s hard watchdog (dormant) | n/a while skipped                                           |
| One Playwright spec         | `timeout`                              | `playwright.config.ts` ← `SPEC_TEST_TIMEOUT_MS`                                                   | 90s                                            | retry once (CI)                                             |
| One vitest e2e test/hook    | `testTimeout` / `hookTimeout`          | `apps/os/e2e/vitest.config.ts` ← `E2E_TEST_TIMEOUT_MS`                                            | 120s                                           | retry once (CI)                                             |
| The built-package TUI lane  | `timeout N <lane command>`             | `scripts/preview/preview.ts` ← `OS_TUI_LANE_TIMEOUT_SECS`                                         | 180s (wraps the no-op skip stub)               | **fail — never retry**                                      |
| A container-cold-boot test  | per-test `{ timeout }`                 | individual tests, capped at `E2E_HEAVY_TEST_TIMEOUT_MS`                                           | ≤ 240s                                         | retry once (CI)                                             |
| The agent smoke lane        | attempt loop + `timeout N <command>`   | `apps/os/e2e/vitest/agent-smoke.ts`; `scripts/preview/preview.ts` ← `OS_AGENT_SMOKE_TIMEOUT_SECS` | 90s reply wait per attempt; 240s lane watchdog | one more attempt, then fail; watchdog expiry fails the lane |
| Each Vitest/Playwright lane | `timeout N <lane command>`             | `scripts/preview/preview.ts` ← `OS_PREVIEW_LANE_TIMEOUT_SECS`                                     | 480s                                           | **fail — never retry**                                      |
| One whole preview run       | `RUN_TIMEOUT_SECS` Depot cancellation  | `scripts/preview/flake-hunt-loop.sh` ← `PREVIEW_RUN_WATCHDOG_SECS`                                | 600s                                           | **cancel — never retry**                                    |
| The Depot CI job            | `timeout-minutes`                      | `.depot/workflows/*.yml`                                                                          | 10–45 minutes (20 for preview)                 | outer edge: re-run button                                   |

The ladder is strictly ordered and the guard test asserts it stays that way.
Note the deliberate rule-3 consequence: the 480s lane watchdog does _not_
budget for a heavy test double-burning its 240s cap, and the 600s run
watchdog does not budget for the lane doing that twice.

### Retry telemetry

An attempt that fails and then passes on its one permitted retry does **not**
make the ordinary PR run fail or block an unrelated PR. It remains useful
reliability telemetry and must stay visible. A stability marathon has a
different acceptance contract: any absorbed retry stops the streak so it can
be diagnosed, even though the same test outcome remains green in normal CI.

- **Run log**: Vitest and TUI lanes print `[retry-telemetry] N test(s) needed
retries: ...` (the Vitest `RetryTelemetryReporter` lives in
  `packages/shared/src/test-support/e2e-policy/`); the agent smoke
  prints the same marker when it needed attempt 2. Vitest and Playwright
  records retain the first failed attempt's compact error even when the retry
  passes. Grep any run log for `retry-telemetry`.
- **Preview CI**: each runner writes canonical telemetry to the shared durable
  directory and may also write a named `TEST_TELEMETRY_ARTIFACT_FILE` that
  `scripts/preview/preview.ts` reads immediately. It folds those reports into a `retries` column in the
  PR-body table and a `::notice::` annotation (escalating to `::warning::`
  when at least four tests retried in one run, which may indicate a slot-wide
  incident rather than independent flakes).
- **Volume**: probabilistic regressions need run volume to detect — that is
  what the on-demand marathon is for
  (`scripts/preview/flake-hunt-loop.sh`, N sequential dispatches of the
  canonical full preview workflow on Depot). Every iteration follows the same
  runner and PostHog path as ordinary preview CI. The orchestrator records the
  retry and exits non-zero immediately; only zero-retry runs advance its
  accepted streak.

When telemetry trends up without failures, investigate it. If the test is
repeatedly flaky or adds disproportionate tail latency, use the quarantine
protocol below instead of repeatedly making unrelated PRs pay for it.

### Flaky-test quarantine protocol

A flaky or pathologically slow test may be quarantined only after the current
change is shown not to cause its failure. Failures on behavior changed by the
PR remain ordinary blockers. For an unrelated test:

1. Record the test name, first-attempt error, run link or artifact, and timing.
2. Add the narrowest explicit skip (`test.skip`/`fixme`, or a clearly logged
   no-op for an entire broken lane). Never hide it with a title filter, deleted
   discovery entry, extra retry, or swallowed error. The skip names its task.
3. Create `tasks/<name>.md` with the evidence, impact, investigation work, and
   concrete exit criteria for removing the skip.
4. State prominently in the PR description that an unrelated flake was found,
   what was skipped, and which task owns restoration.

Once the remaining CI is green, the quarantine is explicit coverage debt, not
a reason to keep the unrelated PR open indefinitely.

### Parked tests expire

A skip/fixme/todo marker that parks a KNOWN issue is a loan against the
suite, and it carries its terms in a comment on (or right above) the marker:

```ts
// parked: <what is broken, with evidence> — revisit by 2026-08-15
test.fixme(true, "Known regression: ...");
```

— or it points at a tracking task (`tasks/<name>.md`) that owns the revisit
instead. Flake quarantines always use the task-backed form above. Markers
without a date are for **structural** reasons only:
platform- or env-gated suites that cannot run in a given context (the
email-OTP specs skip on deployments with OTP disabled — that is a property
of the target, not a parked bug).

`lint/dated-skips.test.ts` enforces this in the unit lane: it scans the
test corpus for skip/fixme/todo markers and **fails on any `revisit by`
date in the past**, printing the file and the parked reason. An expired
date is a decision point, not a nag to bump: fix and un-park the test, or
renew the date with the reason re-argued. Undated markers must be either
task-referenced or allowlisted in that guard with a note — structural
gates live there permanently; parked markers that predate this convention
are grandfathered there once and the grandfather list only shrinks.
