---
state: in-progress
priority: high
size: large
tags: [ci, e2e, mobile, approvals, notifications, quarantine, flake]
---

# Restore the quarantined mobile approvals event-delivery e2es

## Status

Implementation is about 95% complete. Both skips are removed, failures name
the first missing durable transition, and the dynamic-worker ownership leaks,
foreground-approval ordering race, accepted-message UI gap, and orphaned live
stream callback now have regression coverage. Exact-head preview
`4fbdd93` passed both restored mobile cases first try under the canonical
16-worker load, then the new forced-stream-reset regression caught one final
liveness defect before the restoration gate began. The corrected head still
needs a clean preview and 25-run gate.

The two end-to-end mobile approval and notification flows were quarantined on
2026-08-03 while landing PR #2388. That PR changes only the OS web stream-tree
model and routing; the mobile bundle does not import its route helper. The
specs instead expose an intermittent existing break between script execution,
approval intent creation, the batch shown in the thread, and the device
notification journal.

## Evidence

- The canonical preview run
  [`5g5q0jx7ft`](https://depot.dev/orgs/0p91s0lz49/workflows/8dbhw8jjqj?job=wlvh1tdz8f&attempt=42l1ltkjn1)
  failed the spec on both its initial attempt and its one test-level retry. The
  second notification row did not appear after both approval decisions had
  settled.
- A deliberate full-preview rerun
  [`mpfgwwg55b`](https://depot.dev/orgs/0p91s0lz49/workflows/7ztppxzg7d?job=552gs9p59w&attempt=q0j07bxzvd)
  failed both attempts at different boundaries. The first attempt finished the
  running-code spinner without showing the first approval batch; the retry
  completed both decisions but again journaled only one notification row.
- A single-worker invocation passed in 55.8 seconds. A subsequent three-run,
  single-worker repetition passed twice in 56.4 and 53.7 seconds, then failed
  after the running-code spinner disappeared without the first approval batch.
  This reproduces independently of the fully parallel preview lane.
- The next canonical preview run
  [`l9ltm7xhch`](https://depot.dev/orgs/0p91s0lz49/workflows/thbdr63gtq?job=dg1s6sm3g4&attempt=vwckl1b7x1)
  exposed the same defect in `specs/mobile/notifications.spec.ts` after the
  first case was skipped. Its initial attempt never rendered the expected
  suppressed-notification row; its retry never observed the root
  `notification/requested` fact for an approval batch. Both attempts exhausted
  their existing bounded waits at different transitions.
- All runs use unique projects. The failing screenshots and traces show no page
  exception or non-2xx request, and preview Worker logs show no error-level
  entry for the first two canonical runs. The missing transition is therefore
  silent today, which is itself the defect rather than evidence of a healthy
  request.
- PostHog's longer pre-quarantine baseline shows this was not introduced by
  PR #2388: approvals finished failed in 9/221 runs and retried in 22/221;
  notifications finished failed in 8/102 runs and retried in 29/102 between
  2026-07-25 and the decisive PR runs.
- On 2026-08-03 the two specs failed across several unrelated PRs. The same
  day's e2e telemetry recorded 37 dynamic-worker saturation errors and 16
  `stream-wait-timeout` errors, up from 11 and 3 on 2026-08-02. The decisive
  PR #2388 workflows also retried tests after `Too many dynamic workers`,
  script-concurrency failure, and stream-wait timeouts.
- Local reproduction confirmed the causal capacity path. `runScript` used
  Worker Loader `get()` with a fresh identity for every unique execution, so
  one-off code-mode isolates entered the reusable-worker cache and could not
  be reused. One approvals run grew local workerd RSS from 164 MB to 4.6 GB;
  the next browser flow then lost its OS/auth connection. Cloudflare's current
  Worker Loader contract reserves `get()` for reusable workers and `load()`
  for one-off code execution.
- The first fixed canonical preview, Depot run `s3xmd7x093` on `preview-14`,
  passed approvals in 57.5 seconds and notifications in 71.5 seconds with no
  retry. PostHog independently recorded both exact Playwright results as
  passed with `retry_count = 0` and `error_count = 0`.
- The same run was not accepted as a restoration-gate run because Cloudflare
  still recorded 27 error rows across ten traces from 21:34:31.649Z through
  21:34:39.859Z: `Dynamic worker concurrency limit exceeded: each request may
  have up to 4 concurrent dynamic worker invocations`. Exact trace
  `4bab3d906a7603a15e78c8910fc0f55e` roots at a `StreamDurableObject` alarm,
  enters `ProjectDurableObject.wakeStreamProcessor`, and fails in
  `#waitForDefaultProjectWorker` while probing the project-config worker.
  `withWorkerCommit` had replaced the dynamic worker's disposable `Response`
  with a plain stamped `Response`, so every bounded readiness probe dropped
  its invocation ownership instead of releasing it.
- Restoration attempt `2hpdtl6rqz` exposed a different deterministic device
  race. On project `prj_b6b560b9895c4c01b2612df3ea8b6c47`, the ordered copy
  lane put `approval-presented` root offset 48 at device offset 8, then the
  matching notification root offset 49 at device offset 9. The reducer dropped
  the early claim, sent the fake token, revoked the device on Expo rejection,
  removed the subscription at root offset 56, and therefore could not copy the
  second notification at root offset 59. The failure diagnostic correctly
  named `notification/requested copied to device` as the first missing link.
- Final-head preview run `9wgmlm2ztp` passed approvals in 52.2 seconds and
  notifications in 1.1 minutes without either test retrying. The workflow was
  rejected because `workspace-edit-and-push` retried once after two Cloudflare
  Durable Object storage resets (`rnobmgjufmksoiinfovt95q1` and
  `hubulkncdqrp82raijd9a82b`) in its execution window. The interrupted CLI child
  exited without its promised JSON document, which the matrix previously
  surfaced as the generic parser error `Unexpected end of JSON input`. The
  adapter now names that missing result and interrupted lifecycle directly.
- Canonical preview workflow `xn1rbdkrdx` passed approvals on its first attempt
  but retried notifications after the first approval request missed its 15s
  behavior budget. Durable events and trace `c1cec4015eb11c878a7d04e39078e162`
  show the script was accepted at 23:30:46Z but its first egress request did
  not start until 23:31:16Z. The same window began with the 20-script
  concurrency proof and then a steady run-script catalogue stream. Later
  scripts completed ahead of this one. The one-off path released the derived
  entrypoint stub but dropped the `WorkerStub` returned by `LOADER.load()`;
  current Cloudflare Code Mode explicitly disposes both native handles.
- Exact-head preview on `4fbdd93` passed approvals in 52.5 seconds and
  notifications in 49.6 seconds, both first try under 16-worker Playwright.
  The run was still rejected because the new forced-stream-reset Vitest case
  failed twice. A Stream DO `ctx.abort()` can leave the relay's local wake
  socket looking open even though the next DO incarnation no longer owns it;
  the dead RPC leg was detected, but `ping()` incorrectly returned `true`, so
  the owner never reopened from its cursor. A focused run preserved the exact
  red assertion: expected the stale handle to report `false`, received `true`.
- Since the quarantine merged, each test has been skipped 99 times across 98
  preview workflows through 2026-08-05 16:05 UTC.

## Quarantined behavior

- CI no longer proves that a mobile-web user can approve one script burst,
  reject another with a reason, see both outcomes in the same chat, and inspect
  both batches in Notifications. It also no longer proves watched-thread push
  suppression, off-thread push sending, or the synthetic row for an approval
  parked before device enrollment.
- The two preserved Playwright cases are explicit `test.skip` calls in
  `specs/mobile/approvals.spec.ts` and `specs/mobile/notifications.spec.ts`; no
  discovery filter, timeout increase, or additional retry hides the gap.
- Other approval, script-execution, stream-delivery, and notification tests
  remain active.

## Working hypotheses

Test these in order; do not treat the first plausible one as the conclusion.

1. **Confirmed:** shared dynamic-worker capacity pressure rejects or delays a
   Script Execution. One-off `runScript` workers were loaded through the
   reusable `get()` cache under per-execution identities, retaining every
   unique isolate until eviction and exhausting capacity under preview load.
2. The egress batching processor loses or strands a held-request obligation
   during concurrent delivery or Durable Object eviction. Prediction: the
   Script Execution starts and the fetch parks, but no matching Approval Batch
   fact appears; replay or eviction reproduces the same source-offset gap.
3. **Confirmed:** approval facts can exist durably while the live thread misses
   them. A forced Stream DO reset can orphan both callback channels without a
   close event; the relay then treated its stale local wake socket as proof of
   life. The callback owner must see `ping() === false` and reopen from its
   durable cursor. An accepted mobile message is also projected as pending
   agent activity until the first durable script/LLM/assistant/error outcome,
   closing the transient no-spinner gap without inventing durable state.
4. **Confirmed:** notification intent delivery can disappear after an earlier
   foreground claim loses its ordering race. The dropped claim permits an
   unwanted Expo send; token rejection revokes the device and removes its
   subscription before the next intent.

## Work

- [x] Remove both skips on the investigation branch so failures are observable
  without weakening assertions, waits, or retries. _Both original tests are
  active; approval/notification assertions and retry policy are unchanged._
- [x] Add one correlated diagnostic surface covering Script Execution request,
  start and settlement; held request and Approval Batch creation; approval
  decision; root notification intent; and device notification settlement. A
  failure must identify the first absent transition, project, stream path,
  execution/batch/device identity, and source offset where applicable.
  _`specs/mobile/approval-delivery-diagnostics.ts` reports each execution ID,
  durable offsets, settlement, and first missing transition on UI failure._
- [x] Establish a serial baseline, then raise the reproduction rate with the
  existing four-worker stress shape and a production-shaped fully parallel
  preview. Capture the exact first absent transition for each failure.
  _Serial and fully parallel runs crossed different boundaries; strict run
  `2hpdtl6rqz` preserved the exact root/device offsets and first missing copy._
- [x] Minimize the first confirmed failure at the public itx or stream-
  processor harness seam. Preserve it as a readable red regression test before
  changing product behavior. _Red tests proved one-off scripts still called
  cached Worker Loader `get()`, completed entrypoint calls were not released,
  stamped responses lost disposal ownership, and pre-intent presentation
  claims were discarded on an otherwise healthy ordered copy lane._
- [x] Fix the owning state machine. Capacity exhaustion must become bounded
  durable recovery or an explicit terminal outcome; processor obligations
  must survive eviction. Do not add polling, broader waits, fallback values,
  compatibility shims, or another retry layer.
  _`run_script` now uses one-off Worker Loader `load()`; reusable apps remain
  content-addressed through `get()`. Completed RPC calls, entrypoint targets,
  and copied result disposal groups are released on every outcome. The device
  reducer retains claims that precede their matching intent, consumes them on
  arrival, and uses an approval-offset high-water mark to reject late claims
  without retaining unbounded history. The stream relay reports a probed-dead
  RPC leg as dead even when its local wake socket is stale, allowing the
  existing bounded owner watchdog to reopen from the durable cursor._
- [x] Re-run the original browser flows serially, under the focused concurrent
  stress loop, and in the canonical fully parallel preview lane. _Both cases
  pass independently and passed first try together in the exact-head
  16-worker preview on `4fbdd93`; the run was rejected only by the deliberately
  added stream-reset regression._
- [ ] Update this task with the confirmed cause, diagnostic contract, fix,
  traces, and validation evidence.

## Exit criteria

- Remove the explicit skips and make both original cases pass without increasing
  their timeouts or retries.
- Each test asserts a durable diagnostic at the first missing transition, so a
  future failure identifies the owning processor and source offset.
- At least 25 consecutive canonical, fully parallel preview runs complete with
  no retry, silent event loss, unexplained Worker error, or missing approval or
  notification row.
- CI and review are green with zero unresolved threads. The pull request stays
  unmerged until the user explicitly approves it.

## Implementation log

- 2026-08-05: Re-read the Slack report, PR #2388 evidence, current task, and
  PostHog CI telemetry. Confirmed the reported 4/4 approvals and 2/2
  notifications attempts while finding earlier passing PR runs and correlated
  capacity/stream failures in the same workflows. Created the isolated
  `fix/mobile-approval-event-delivery` branch from current `origin/main`.
- 2026-08-05: Reproduced local workerd growth and separated several unrelated
  auth/project-bootstrap failures from the quarantined delivery boundary.
  Added red/green Worker Loader and RPC ownership tests, switched only
  `run_script` to one-off loading, released completed RPC ownership, removed
  both skips, and added correlated failure diagnostics. Focused 45 unit tests,
  repo typecheck, approvals browser flow, and notifications browser flow pass.
- 2026-08-05: The first canonical preview passed both restored cases, but the
  required Cloudflare audit rejected the apparently green run. A new red test
  proved trusted response stamping discarded the dynamic worker response's
  disposal group; `withWorkerCommit` now transfers that ownership to the
  stamped response. The focused worker/capability-host suite passes 71 tests.
  The initial marathon counted one retry-free workflow before this trace
  finding; its streak was deliberately discarded and run two was cancelled.
- 2026-08-05: The strict gate rejected two more workflows: one for a Cloudflare
  internal Durable Object storage reset in Semaphore, then one for a separate
  Cloudflare reset plus an approvals retry. The new diagnostic led to the live
  root/device journals and proved the early-claim ordering race above. Added a
  red state-machine spec, durable pending-claim/high-water state, and a contract
  version bump; all 24 device processor tests, OS typecheck, lint, and format
  checks pass.
- 2026-08-05: A final-head preview passed both restored mobile cases, but an
  unrelated catalogue case retried. PostHog placed the retry at 22:20:19Z and
  Cloudflare traces showed two internal storage resets in the same window. The
  reset interrupted the CLI child before it wrote its result. Added an explicit
  empty-result diagnostic so a repeat names the lifecycle boundary instead of
  failing later in `JSON.parse`; the next canonical preview is the
  production-shaped regression check.
- 2026-08-06: The next canonical preview's initial notification attempt
  exposed a 30-second fresh-worker queue after the concurrency burst. Added a
  red ownership test proving `run_script` disposed only the entrypoint stub,
  then retained and disposed the parent one-off `WorkerStub` as well. Focused
  worker-runner tests, formatting, lint, and OS typecheck pass; the next preview
  will test whether fresh loads now drain promptly under the same full-suite
  pressure.
- 2026-08-06: Exact-head preview `4fbdd93` passed approvals and notifications
  first try, but the new stream-incarnation regression failed both attempts.
  A focused red run proved the relay returned `true` after its RPC leg died
  because an orphaned local wake socket still looked open. The relay now
  reports `false`; the existing 15-second owner watchdog reopens the logical
  subscription, and the regression will prove cursor replay through the
  replacement connection on the next deployment. OS typecheck, the 36
  React/session tests, and focused formatting checks pass.
