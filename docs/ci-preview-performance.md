# Preview CI performance

The **Cloudflare Previews** check deploys every affected app to one leased
preview slot and runs its deployed e2e coverage. Its target is **under 3m30s
end-to-end**. The 20-minute workflow timeout is only a runaway backstop.

For workflow commands, logs, and metrics, see [Depot CI](depot-ci.md). This
document defines the critical-path model and the rules that keep it fast.

## Critical-path model

The preview lifecycle has two barriers:

1. Start every selected app deployment together; wait until every deployment
   and readiness check finishes.
2. Start every selected app test lane together; wait until every lane finishes.

Once the fleet's exact Worker versions pass readiness, app suites start without
a synthetic deployment-age delay. OS starts its onboarding smoke, explicit TUI
quarantine marker, Chromium setup, and Playwright together; high-fanout Vitest
starts after the production-shaped onboarding smoke has exercised project
birth. Therefore, healthy wall time should approach:

```text
pickup + setup + slowest deploy + slowest test lane + reporting
```

It must not approach the sum of app deployments, app test suites, or OS
sub-lanes. Soft warnings currently fire above 90 seconds for OS deploy or 100
seconds for OS tests; crossing one is evidence to investigate, not a reason to
raise the budget automatically.

## Parallel execution

- `previewDependencies` co-selects apps so a slot contains one coherent head;
  it is not a deployment-order edge. Each deploy owns its readiness check, and
  tests start only after the whole selected fleet is ready.
- Different app suites run concurrently.
- The short Semaphore, Streams, Petshop, and Auth commands start together with
  the OS command after the deployed fleet is ready.
- OS smoke, the explicit TUI quarantine marker, Chromium setup, and Playwright
  run concurrently. High-fanout Vitest waits only for the smoke; every
  background process is joined even if another one fails, so a failure cannot
  orphan work or discard another lane's result.
- Chromium installation begins before the four OS lanes and overlaps their
  startup.
- OS Vitest gives every current file a worker immediately and permits at most
  two concurrent tests per file in CI. Each file owns isolated projects; the
  examples matrix still overlaps its isolated runtimes inside each case.
- Root Playwright uses sixteen fully parallel workers in CI. The latest
  zero-retry full-suite sample carried about 1,554 seconds of aggregate work and
  a 117-second longest case: sixteen workers make that longest case, rather than
  worker queueing, the expected floor. Preview runs queue the long
  reconnect/resume specs first so their fixed probe windows overlap the
  ordinary catalogue.
- The job uses a 16-core Depot runner. Measurements on larger runners showed
  the overlapping local work peaking below ten cores; the deployed Worker and
  Durable Objects, rather than host CPU, are the integration boundary. The
  marathon is the capacity and tail-latency proof for the resulting remote
  burst.

Tests make this safe by owning isolated state. Test clients give every project
create a collision-resistant caller-owned `prj_…` identifier, avoiding an
unnecessary deployment-global ID-mint hop. The examples matrix exclusively
leases two reusable projects per runtime so mutable project-global state stays
isolated while runtimes overlap. Only the sandbox example runs its runtimes
serially because they intentionally share one warm container.

## Reliability rules

- **Retries live only at the individual-test layer.** CI permits one retry;
  app lanes and the whole workflow never retry automatically.
- **Watchdogs fail rather than retry.** The TUI quarantine marker and
  Vitest/Playwright processes retain their own bounded `timeout`s, inside the
  workflow backstop.
- **Readiness proves the uploaded edge version.** OS and the streams example
  report `CF_VERSION_METADATA`; the orchestrator requires wrangler's exact
  final version on the health probe (no multi-second dwell after first match).
  The probe is a cheap public health request and never wakes synthetic Durable
  Objects.
- **Durable Object rollout is handled at the operation boundary.** Edge
  readiness cannot prove the version a future Durable Object placement will
  receive, so a fixed sleep is neither a convergence barrier nor a recovery
  mechanism. The previous 90-second clock charged every fresh live suite and
  still did not rule out later resets. An explicitly idempotent product
  operation may replay one classified reset on a fresh stub from the same
  durable cursor; a second reset, application error, or raw overload outcome is
  terminal and observable.
- **Warm OS deploys skip only proven-unchanged container work.** Wrangler
  otherwise builds and reconciles the six stock sandbox image applications
  serially even when all six report `no changes`. The orchestrator requests
  `--containers-rollout none` only when the same slot has an exact prior OS
  deployment and GitHub's ancestry diff contains no image, generated config,
  cap, package, or Wrangler-config input. New slots, bootstraps, force-pushes,
  truncated/unavailable comparisons, and relevant changes use the full
  rollout.
- **Recovery never crosses an unsafe boundary.** Identity minting, unkeyed
  writes, and whole fixture creation are not replayed. Recovery belongs inside
  the read-only or idempotency-keyed operation that can prove the same request
  is safe to issue again.
- **Readiness retries are bounded and diagnostic.** Each request has a short
  watchdog, the overall deploy check has a hard deadline, and the final HTTP
  response body or transport error is retained in the failure message.
- **Retries remain visible.** Vitest and Playwright write compact retry
  telemetry that is folded into the preview state in the PR description. The
  quarantined TUI marker writes an empty ledger and names its restoration task.
- **Do not serialize around a product defect.** Repeated storage, RPC, stream,
  or project-birth tails require diagnosis. Parallel tests are allowed to
  expose real shared-capacity limits.

## Keeping it fast

- Every new e2e test should create uniquely named state and must not depend on
  another test's side effects.
- Add coverage to an existing concurrent lane. A new serial phase adds its
  entire duration to the critical path.
- Start fixed-duration or historically slow work first. Once the phase is
  parallel, late scheduling of the longest item is the usual avoidable tail.
- Keep file scheduling out of the critical path: every isolated file should be
  runnable immediately. If that remote burst exposes a real shared-capacity
  defect, diagnose it rather than adding ad-hoc serial lanes.
- Split composite tests when their internal serial work becomes the phase
  floor. This improves both scheduling and retry granularity.

## Measuring a run

- `depot ci metrics --run <run-id> --org 0p91s0lz49` shows host CPU and memory.
- `[preview] deploy passed: <app> (Ns)` and `[preview] test passed: <app> (Ns)`
  in the run log show phase wall times.
- `[preview:os] lane start/finish` lines show the overlapping OS work and when
  Vitest was released after the onboarding smoke.
- The managed preview block in the PR body records per-app deploy duration,
  test duration, and consumed retries.
- The reporting tail remains part of the end-to-end budget. Test events are
  packed into size-bounded PostHog batches (5 MB of encoded events, below the
  20 MB request limit), so telemetry volume does not turn into one serial HTTP
  round trip per 100 events.

Use at least three unchanged warm-slot runs when changing concurrency. A single
green run proves neither the tail nor the retry rate. Classify every retry and
audit matching Cloudflare errors before calling an operational change proven.

For a release-level stability proof, run the thin Depot orchestrator:

```bash
PR_NUMBER=<pr> REF=<branch> RUNS=25 ./scripts/preview/flake-hunt-loop.sh
```

It sequentially dispatches the canonical `cloudflare-previews.yml` workflow;
there is no second deploy/test implementation and no nested marathon runner.
Every counted iteration therefore has its own ordinary Depot runner, artifacts,
GitHub timing, and PostHog telemetry. The ledger records the immutable head,
Depot run/attempt IDs, whole-run duration (dispatch creation through finish),
and retry count. It fails fast on a workflow failure, moved head, absorbed test
retry, or duration at or above seven minutes. The acceptance bar is 25
consecutive zero-retry runs of one head.

## Cost

Depot bills per second per vCPU. The preview runner is sized for the measured
local peak while its worker pools overlap; inspect total core-seconds as well as
duration after changing it. Cleanup remains on the small default runner.
`cancel-in-progress: true` prevents superseded pushes from continuing to
consume preview compute.
