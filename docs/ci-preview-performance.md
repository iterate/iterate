# Preview CI performance

The **Cloudflare Previews** check (deploy every app to a leased preview slot,
then run the full e2e suite against it) is the slowest thing that runs on every
PR push, so it gets a dedicated performance budget. The target is **under
3m30s** end-to-end. A retry-clean full-fleet run on 2026-07-18 landed in
**3m08s**. This doc explains how, and — more importantly — how to keep it
there.

For the mechanics (where the workflows live, how to run them locally, the
Doppler wiring), see [Depot CI](depot-ci.md). This doc is about speed
and cost.

## Where the time goes

| Phase      | Guardrail | Observed | What it is                                      |
| ---------- | --------- | -------- | ----------------------------------------------- |
| Pickup     | —         | ~4s      | Depot CI assigns a runner                       |
| Setup      | —         | ~15s     | checkout + `pnpm install` + Doppler CLI         |
| Deploy     | 90s (OS)  | ~72s     | all apps deploy in parallel to the slot         |
| Tests      | 100s (OS) | ~91s     | full e2e against the deployed slot              |
| Reporting  | —         | ~3s      | state update + test-artifact upload             |
| Full check | 210s      | 188s     | check start through successful check completion |

The OS deploy and the OS e2e lane are the long poles; the other apps finish in
seconds and run alongside OS.

## The optimizations (and why each one is load-bearing)

- **Runs on Depot CI, not GitHub Actions.** GitHub's runner assignment was
  measured at 20s–3m39s (and once ~40min during a webhook incident), because a
  push has to clear GitHub's run creation → scheduling → `workflow_job` webhook
  → dispatch chain before any runner starts. Depot CI receives the push webhook
  directly and picks up in ~7s. The whole preview lifecycle — deploy + e2e and
  the PR-close cleanup — lives in one Depot workflow
  (`.depot/workflows/cloudflare-previews.yml`); there is no GitHub Actions
  preview workflow (see [Depot CI](depot-ci.md)).
- **Deploys run in one parallel batch.** OS bakes the auth JWKS at deploy time,
  but instead of waiting for auth to finish first, the OS deploy _polls_ the
  slot's auth worker for JWKS (`bakeStaticAuthJwks` in `apps/os/scripts/deploy.ts`). All
  apps deploy at once. `previewDependencies` co-selects current-head fixtures;
  it does not order their deploys. Reserve `previewDeployAfter` for a real
  start-after constraint that cannot be represented by a readiness barrier.
- **Container rollout completion is part of deploy readiness.** Wrangler
  returns after creating a Container rollout; it does not wait for every
  assigned instance to be replaced. A default 10%→100% rollout once continued
  for about 90 seconds after Wrangler returned and killed a test sandbox with
  exit 137. Preview Container changes therefore use one 100% step, and the OS
  deploy polls all six application rollouts concurrently until Cloudflare
  reports every target instance updated and healthy. Production keeps gradual
  rollout. Do not replace this API-backed barrier with a sleep or test
  serialization.
- **Parallelism is explicit per deployed slot, not accidental.** The OS
  Vitest catalogue uses twelve workers with at most two concurrent tests each;
  Playwright uses twelve fully-parallel workers. The create/onboarding smoke,
  TUI, Vitest, and Playwright overlap against one OS slot for an aggregate
  configured peak of 38. Each sublane emits start/finish timing markers and
  retry telemetry. A capacity failure must stay visible and be fixed;
  serializing independent suites made a clean OS phase exceed six minutes. The
  five apps' independent preview suites also run concurrently
  (`scripts/preview/preview.ts`).
- **File-level parallelism plus bounded intra-file concurrency.** Every Vitest
  file either uses unique state or leases from a bounded family-owned project
  pool, so files are independent (`fileParallelism`, `maxWorkers: 12`,
  `sequence.concurrent`, `maxConcurrency: 2`, `retry: 1` in
  `apps/os/e2e/vitest.config.ts`). The deployed slot — not the Depot runner —
  is the bottleneck. The real speedup for the slow itx suite is splitting its
  monolith file so file-level parallelism covers it.
- **Playwright runs 12 workers, `fullyParallel`, in CI**
  (`playwright.config.ts`). Specs isolate mutable state with unique namespaces,
  worker-owned project fixtures, or an explicit fresh project when creation is
  what the spec proves. Preview queues the long reconnect/resume project first,
  overlapping its fixed probe windows with the ordinary web catalogue instead
  of letting four resilience tests become the end-of-lane tail.
- **The create/onboarding smoke is an ordinary parallel lane.** It retains one
  production-shaped project-birth and onboarding proof with its own watchdog;
  it is not a serial warm-up barrier. Cold-start defects must be modelled by the
  operation that encounters them, not displaced into a preflight that adds its
  healthy duration to every run. The old curl-round HTTP warmups existed to
  absorb post-deploy edge 499/522s; those were zombie worker routes (routes
  visible in the API but dead at the edge). Routes now ride the generated
  wrangler config as ensure-only (the worker script is never deleted, so a
  deploy can't strand them) with proxied DNS ensured by `ensureProxiedDnsRecord`
  (`scripts/lib/deploy-helpers.ts`), and slot teardowns leave routes parked, so
  the curls are gone.
- **Chromium setup overlaps all remote lanes.** Its download hits no slot, so
  it runs in the background while smoke, TUI, and Vitest start, instead of
  blocking the specs.
- **GitHub API calls retry transient 5xx.** The preview script fetches PR
  context from GitHub's REST API at the start of each step; that API
  intermittently 5xxs (its "Unicorn!" 503 page failed a run mid-flight). The
  calls retry with backoff (`withGithubRetry` in `scripts/preview/preview.ts`)
  so a blip doesn't fail the whole run and force a re-run.
- **Right-sized runner.** The job is network-bound on average. The 2026-07-18
  full-fleet run on the current runner averaged 33% CPU / 16.5% memory, with
  short build peaks of 81.4% CPU / 37% memory. It stays on 8 cores.

## Keeping it fast

**The budget guardrail.** `scripts/preview/preview.ts` sets
`previewDeployBudgetMs` and `previewTestBudgetMs` on the OS app. When a phase
runs slower than its budget, the preview script emits a `::warning::`
annotation that shows up on the PR — it never fails the run, it just makes
creep visible. If you see one:

1. Find out _why_ it got slower (a new serial suite? a heavier test? more
   round-trips to the slot?) and fix the cause.
2. Only if the new floor is legitimate and unavoidable, raise the budget in
   `preview.ts` — in the same PR, with a note saying why. Don't bump the budget
   to silence a regression.

**Rules that keep the concurrency safe and the pipeline fast:**

- **Every e2e test must isolate its mutable state.** Prefer unique resource
  namespaces inside a worker/family-owned project pool. Create a fresh project
  only when project birth/lifecycle/destruction is the behavior under test or
  isolation cannot be bounded and verified. Tests must never depend on another
  test's side effects.
- **Prefer test-level parallelism over adding lanes.** A new check that runs
  _after_ the existing lanes adds its whole duration to the critical path. If
  you must add coverage, fold it into an existing concurrent lane.
- **Never serialize what can self-provision.** The apps' suites and the vitest
  lanes run concurrently on purpose; keep it that way.
- **Keep the create/onboarding proof, but never as a warm-up barrier.** It runs
  in parallel and owns its failure. Every other suite must correctly handle the
  lifecycle states its operation documents.
- **Measure slot load, not folklore.** More Playwright workers or higher
  `maxConcurrency` increases concurrent pressure on the deployed slot. Step it
  with lane timings, retry telemetry, and exact traces; a traced product defect
  is not evidence for suite-wide throttling. The 2026-07-18 audit observed 176
  successful creates and no capacity rejection while the remote lanes
  overlapped.

**How to measure:**

- `depot ci metrics --run <run-id> --org 0p91s0lz49` — CPU/memory utilization,
  the evidence for runner sizing.
- The `[preview] deploy passed: <app> (Ns)` / `[preview] test passed: <app>
(Ns)` lines in the run log — per-phase wall time.
- The preview state block on the PR body records `deployDurationMs` /
  `testDurationMs` per app.

## Cost

Depot CI bills per second per vCPU (no per-minute rounding), so the levers are
core-count and run-count, not wall-clock padding:

- **Preview job: 8 cores, not 16.** Metrics-backed right-sizing (see above)
  halves the per-second cost with peak utilization still ~60%. Re-check with
  `depot ci metrics` before changing the size in either direction.
- **Cleanup job: the small 2-core default runner.** It only runs a
  Doppler-wrapped destroy; it doesn't need the preview job's cores.
- **`cancel-in-progress: true`** on the preview workflow cancels superseded
  runs when you push again, so only the latest commit's run pays.
- **The preview-CI image bake is weekly, not daily.** Nothing consumes that
  snapshot today (Depot CI uses its standard runners), so a daily bake was
  spending compute on an unused artifact. Make it daily again — or delete
  `.depot/workflows/build-preview-ci-image.yml` — only once something actually
  reads the image.

None of these change how long a run takes; they change how much each run costs.
