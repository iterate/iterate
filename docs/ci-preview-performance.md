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

OS starts its onboarding smoke, explicit TUI quarantine marker, Vitest, and
Playwright as four independent sub-lanes. Therefore, healthy wall time should
approach:

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
- OS smoke, the explicit TUI quarantine marker, Vitest, and Playwright run
  concurrently. Every background process is joined even if another one fails,
  so a failure cannot orphan work or discard another lane's result.
- Chromium installation begins before the four OS lanes and overlaps their
  startup.
- OS Vitest gives every current file a worker immediately and permits at most
  two concurrent tests per file in CI. Every case owns isolated deployed state,
  so there is no file queue or historical-duration scheduler on the critical
  path; the examples matrix also overlaps its isolated runtimes inside each
  case.
- Root Playwright uses eight fully parallel workers in CI. Preview runs queue the
  long reconnect/resume specs first so their fixed probe windows overlap the
  ordinary catalogue.
- The job uses a 64-core Depot runner so the fully fanned-out Vitest catalogue,
  eight Playwright workers, deploy builds, and packaging do not create a local
  CPU queue. The deployed Worker and Durable Objects remain
  the integration boundary; the marathon is the capacity and tail-latency
  proof for the resulting remote burst.

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
  final version to remain continuously visible for 10 seconds. The probe is a
  cheap public health request and never wakes synthetic Durable Objects.
- **Durable Object resets are handled by product operations.** Cloudflare may
  still move an individual Durable Object to new code after edge readiness.
  Idempotent operations must redeliver after that explicit lifecycle outcome
  without committing terminal failure state. A finite placement sample cannot
  prove the whole fleet, so readiness does not pretend otherwise.
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
- Keep isolated files fully fanned out. If the resulting remote burst exposes
  a real shared-capacity defect, diagnose that defect rather than serializing
  the suite around it.
- Split composite tests when their internal serial work becomes the phase
  floor. This improves both scheduling and retry granularity.

## Measuring a run

- `depot ci metrics --run <run-id> --org 0p91s0lz49` shows host CPU and memory.
- `[preview] deploy passed: <app> (Ns)` and `[preview] test passed: <app> (Ns)`
  in the run log show phase wall times.
- `[preview:os] lane start/finish` lines show the four overlapping OS lanes.
- The managed preview block in the PR body records per-app deploy duration,
  test duration, and consumed retries.

Use at least three unchanged warm-slot runs when changing concurrency. A single
green run proves neither the tail nor the retry rate. Classify every retry and
audit matching Cloudflare errors before calling an operational change proven.

For a release-level stability proof, dispatch `preview-e2e-marathon.yml`. Each
counted run repeats the complete critical path (full-fleet deploy, then all test
lanes), records duration and retry count in `summary.tsv`, and fails fast on a
functional failure or a duration at or above five minutes. The acceptance bar
is 25 consecutive accepted runs; environment ownership refusals are recorded
but uncounted because the guard fires before any tests run.

## Cost

Depot bills per second per vCPU. The preview runner is sized for the measured
local peak while its worker pools overlap; inspect total core-seconds as well as
duration after changing it. Cleanup remains on the small default runner.
`cancel-in-progress: true` prevents superseded pushes from continuing to
consume preview compute.
