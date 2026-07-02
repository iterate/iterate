# Preview CI performance

The **Cloudflare Previews** check (deploy every app to a leased preview slot,
then run the full e2e suite against it) is the slowest thing that runs on every
PR push, so it gets a dedicated performance budget. As of 2026-07-02 it lands
in **~2m30s** end-to-end. This doc explains how, and — more importantly — how
to keep it there.

For the mechanics (where the workflows live, how to run them locally, the
Doppler wiring), see [CI workflows](ci-workflows.md). This doc is about speed
and cost.

## Where the time goes

| Phase  | Budget   | Typical | What it is                              |
| ------ | -------- | ------- | --------------------------------------- |
| Pickup | —        | ~7s     | Depot CI assigns a runner               |
| Setup  | —        | ~20s    | checkout + `pnpm install` + Doppler CLI |
| Deploy | 55s (OS) | ~40s    | all apps deploy in parallel to the slot |
| Tests  | 80s (OS) | ~60s    | full e2e against the deployed slot      |

The OS deploy and the OS e2e lane are the long poles; the other apps finish in
seconds and run alongside OS.

## The optimizations (and why each one is load-bearing)

- **Runs on Depot CI, not GitHub Actions.** GitHub's runner assignment was
  measured at 20s–3m39s (and once ~40min during a webhook incident), because a
  push has to clear GitHub's run creation → scheduling → `workflow_job` webhook
  → dispatch chain before any runner starts. Depot CI receives the push webhook
  directly and picks up in ~7s. The `pull_request` triggers therefore live in
  `.depot/workflows/cloudflare-previews.yml`; the GitHub workflow keeps only
  the PR-close cleanup job (see [CI workflows](ci-workflows.md)).
- **Deploys run in one parallel batch.** OS bakes the auth JWKS at deploy time,
  but instead of waiting for auth to finish first, the OS deploy _polls_ the
  slot's auth worker for JWKS (`apps/os/alchemy.run.ts`, 120s deadline). All
  apps deploy at once.
- **Test-level concurrency.** Every e2e test provisions its own project against
  the deployed slot, so tests within a file are independent. In CI the vitest
  configs set `sequence.concurrent` with `maxConcurrency: 6` and `retry: 1`
  (`apps/os/e2e/vitest.config.ts`, `apps/os/e2e/examples/vitest.config.ts`).
  This alone took the itx suite from 287s to ~50s.
- **All test lanes run concurrently.** `pnpm e2e`, `pnpm e2e:examples`, and the
  root Playwright specs run at the same time against the slot, and the four
  apps' suites run concurrently too (`scripts/preview/preview.ts`).
- **Playwright runs 6 workers, `fullyParallel`, in CI** (`playwright.config.ts`)
  — every spec creates its own fixture project.
- **The slot is warmed before the burst.** A cold deployment answers its first
  requests only after loading each worker; ~40 concurrent WebSocket handshakes
  against zero warm isolates returned edge 499/522s. The test command curls
  each worker (health, app, itx, auth) before starting the lanes, and the
  WebSocket handshake timeout is 30s (`apps/os/src/itx-client.ts`).
- **The chromium install overlaps the warmup.** `playwright install chromium`
  hits no slot, so it runs in the background while the slot warms and the
  vitest lanes start, instead of blocking the specs.
- **GitHub API calls retry transient 5xx.** The preview script fetches PR
  context from GitHub's REST API at the start of each step; that API
  intermittently 5xxs (its "Unicorn!" 503 page failed a run mid-flight). The
  calls retry with backoff (`withGithubRetry` in `scripts/preview/preview.ts`)
  so a blip doesn't fail the whole run and force a re-run.
- **Right-sized runner.** The job is network-bound; Depot metrics showed peak
  CPU ~30% / memory ~10% of a 16-core box, so it runs on 8 cores.

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

- **Every e2e test must self-provision** (its own uniquely-suffixed project,
  fixture, marker). Shared mutable state breaks `sequence.concurrent`. This is
  what makes test-level parallelism safe — don't introduce a test that depends
  on another test's side effects.
- **Prefer test-level parallelism over adding lanes.** A new check that runs
  _after_ the existing lanes adds its whole duration to the critical path. If
  you must add coverage, fold it into an existing concurrent lane.
- **Never serialize what can self-provision.** The apps' suites and the vitest
  lanes run concurrently on purpose; keep it that way.
- **Keep the warmup.** Removing it brings back the cold-start stampede
  (edge 499/522s), which fails or retries and makes runs _slower_, not faster.
- **Mind slot load, not just runner load.** More Playwright workers or higher
  `maxConcurrency` increases concurrent pressure on the _deployed slot_, which
  is where the known stream-delivery race lives
  (`tasks/streams-event-delivery-flake-under-concurrent-load.md`). Flakes cost
  retry time. Raise concurrency only with evidence it stays green.

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
