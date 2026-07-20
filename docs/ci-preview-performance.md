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

OS starts its onboarding smoke, built-package TUI, Vitest, and Playwright as
four independent sub-lanes. Therefore, healthy wall time should approach:

```text
pickup + setup + slowest deploy + slowest test lane + reporting
```

It must not approach the sum of app deployments, app test suites, or OS
sub-lanes. Soft warnings currently fire above 105 seconds for OS deploy or 100
seconds for OS tests; crossing one is evidence to investigate, not a reason to
raise the budget automatically.

## Parallel execution

- `previewDependencies` co-selects apps so a slot contains one coherent head;
  it is not a deployment-order edge. Each deploy owns its readiness check, and
  tests start only after the whole selected fleet is ready.
- Different app suites run concurrently.
- OS smoke, TUI, Vitest, and Playwright run concurrently. Every background
  process is joined even if another one fails, so a failure cannot orphan work
  or discard another lane's result.
- Chromium installation begins before the four OS lanes and overlaps their
  startup.
- OS Vitest uses twelve file workers and at most two concurrent tests per file
  in CI. Its sequencer starts historically slow files first; the examples
  matrix then overlaps its isolated runtimes inside each case.
- Root Playwright uses 12 fully parallel workers in CI. Preview runs queue the
  long reconnect/resume specs first so their fixed probe windows overlap the
  ordinary catalogue.
- The job uses a 16-core Depot runner. A complete 32-core run peaked below ten
  cores while its allocation wait dominated setup, so the larger shape added
  queue tail without removing remote latency. The deployed Worker and Durable
  Objects remain the integration boundary.

Tests make this safe by owning isolated state. Test clients give every project
create a collision-resistant caller-owned `prj_…` identifier, avoiding an
unnecessary deployment-global ID-mint hop. The examples matrix exclusively
leases two reusable projects per runtime so mutable project-global state stays
isolated while runtimes overlap. Only the sandbox example runs its runtimes
serially because they intentionally share one warm container.

## Reliability rules

- **Retries live only at the individual-test layer.** CI permits one retry;
  app lanes and the whole workflow never retry automatically.
- **Watchdogs fail rather than retry.** The TUI and Vitest/Playwright processes
  retain their own bounded `timeout`s, inside the workflow backstop.
- **Readiness is a version barrier.** OS must serve the exact deployed Worker
  version continuously for 40 seconds before project creation begins. Shorter
  holds previously admitted Durable Object code-update resets. Reduce this
  only with post-deploy trace evidence.
- **Retries remain visible.** Vitest, TUI, and Playwright write compact retry
  telemetry that is folded into the preview state in the PR description.
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
- Raise workers only with repeated preview evidence. More local concurrency
  cannot shorten one composite test and may create retry work at the deployed
  slot.
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

## Cost

Depot bills per second per vCPU. The preview runner is sized for the measured
local peak while its worker pools overlap; inspect total core-seconds as well as
duration after changing it. Cleanup remains on the small default runner.
`cancel-in-progress: true` prevents superseded pushes from continuing to
consume preview compute.
