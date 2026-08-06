---
state: in-progress
priority: high
size: large
tags: [ci, e2e, mobile, approvals, notifications, quarantine, flake]
---

# Restore the quarantined mobile approvals event-delivery e2es

## Status

Implementation is about 98% complete. Both mobile skips are removed and the
reported delivery defects plus each recovery failure found by the strict gate
have regression coverage. The latest exact-head baseline kept both restored
mobile flows first-try green but was rejected for six OS retries sharing one
stalled config-repo birth.

Gate candidate one then caught two classified Auth deployment gaps: the
post-deploy OAuth seed could race bootstrap-admin visibility, and Wrangler did
not recover Cloudflare D1 code 7009. The server now reports the first as 503;
the seed and captured-output command wrapper bound retries to explicit
availability outcomes while still rejecting unclassified failures. Auth's 86
tests, the 18-test deploy-helper suite, typechecks, lint, and formatting are
green. The next baseline exposed a Semaphore waiter timing out while its lease
assignment was already in flight; that lifecycle is now explicit. Its
successor exposed a deeper Artifacts flaw: the retained repo-processor callback
raced first creation against eight seconds, abandoned the successful response's
one-time write token, then hammered an existing but unreadable repo. Empty repo
birth now transfers to an independent durable alarm actor which awaits that
token, checkpoints the seeded Artifact, and appends the terminal fact under the
original stream-lifetime fence. Its first baseline made every preview group
green with both restored mobile flows first try, but the exact-version audit
caught one remaining dynamic-worker concurrency error. A later config commit
was probing the project worker from the retained root Stream alarm while that
alarm delivered the same commit to the userspace worker feed. The probe now
transfers to the Project DO's durable alarm queue and keeps the original stream
fence. Its exact-head baseline passed all six groups, including both restored
mobile flows first try, and had no dynamic-worker concurrency failure. The
strict audit then found three expected paused-ancestor rejections mislabeled as
application errors because their direct Durable Object error name differed
from the public-RPC-normalized name. After that fix passed its exact-head
baseline, the first cold candidate found one unflagged local SQLite reset in
subscription `nack`; a narrow referenced-reset classifier is locally green.
The 25-run streak remains at zero until the new exact head passes preview and
trace audit.

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
- Exact-head preview workflow `wxczbq1zp3` on `16c29a0` was green overall, but
  PostHog rejected it for the restoration gate: approvals failed after 60.4
  seconds when the second notification row did not render, then passed its
  retry in 49.4 seconds. Cloudflare recorded an internal storage reset on the
  Project DO (`skeb35u7pdbcs1uscf038h2i`) at 00:03:58Z. Both live hosted
  callbacks timed out at 00:04:18Z, then did not reopen until 00:05:15Z. The
  source Stream had no intervening retry alarm; the 56.8-second delay matches
  an attempt-7 exponential backoff, showing that lifecycle availability
  failures could inherit an already-inflated retry delay.
- A focused deployed E2E now restarts the Project DO while its notification
  callback is live, appends an approval request to the surviving root Stream,
  and requires the notification intent within 12 seconds. It failed against
  `16c29a0` with the public wait timing out after 12 seconds; the old path took
  about 20 seconds because only the batch watchdog detected the dead callback.
- Canonical workflow `79mpzrv8mt` on `1c66ee9` passed approvals in 52.7s,
  notifications in 57.8s, and the new Project-restart E2E, all with zero
  retries/errors in PostHog. The Cloudflare audit still rejected it: rollout
  resets left retained callbacks whose pure ping calls hung instead of
  rejecting. One or two missed one-second probes are allowed for a busy
  processor; three consecutive misses now classify that callback as
  unavailable and use the bounded one-second lifecycle retry before the 20s
  application-work watchdog can report a false application failure.
- The first strict-gate workflow on `df641ef` passed both mobile cases first
  try, but the gate rejected the whole run because the worker-bundler case
  retried. Cloudflare trace `0f1fb6230b48c7b95031e366154cc27b`
  (`vit5vef1jngi9mh659bpbflk`) showed the actual failure happened earlier in
  `Project.create()`: an internal storage reset rejected the root Stream DO's
  terminal `waitForEvent`. Project creation now reacquires that idempotent
  terminal wait exactly once, with the second attempt consuming only the
  original deadline's remainder; a second lifecycle failure still propagates.
- PostHog recorded both restored cases on that workflow with
  `retry_count = 0` and `error_count = 0`, but the exact deployed Worker still
  emitted 285 error-level 20-second hosted acknowledgement timeouts. The
  owner ping can remain healthy while the batch's separate one-shot result
  capability is unusable, so owner liveness cannot classify the specific
  acknowledgement path. An expired acknowledgement is now an explicit
  receiver-unavailable outcome: it stays attempt-bounded, retries after one
  second even after prior failures, and logs as expected availability rather
  than an application error. Late results remain ignored by the existing
  per-batch token fence.
- The next unchanged-head attempt again made both restored cases 0/0 in
  PostHog and had no test retry, but the exact trace audit rejected it for a
  `RepoNotSeededError` from the Project processor's default-worker readiness
  probe (`prj_f7984c399815471887c4f38259c46677`). Browser fetch dispatch and
  project-worker event delivery already classify this config-repo birth window
  as “not ready yet”; only the processor's direct probe bypassed that contract.
  It now retries the same bounded 20-attempt readiness loop and still
  propagates every non-lifecycle dispatch failure.
- The first preview after that fix passed both restored cases first try and
  emitted no hosted-callback application errors, but an egress case retried.
  Its first attempt waited up to 30 seconds for child stream paths, then gave
  the repo catalog only the shared helper's five-second default before checking
  the same combined state. The retry passed in 45.2 seconds. The two waits are
  now one exact catalog-state condition under the test's existing 30-second
  budget; assertions and product timeouts are unchanged.
- The first canonical workflow on `ddcdcf2` passed both restored mobile cases
  and the stream-incarnation regression first try, but the forced Project
  restart case retried after its first 12-second public wait expired. Exact
  Stream telemetry showed the pending hosted batch start at 02:03:21.748Z but
  no one-second probe alarm; the first alarm fired at 02:03:37.520Z and only
  then classified the killed callbacks. A focused unit regression reproduced
  the final reconciliation arming the 20-second watchdog (`30000`) after the
  one-second probe (`11000`). Alarm recomputation now includes the earliest
  live pending-delivery probe, and the regression plus both adjacent stream
  suites pass.
- An earlier rejected gate attempt retried `repo-lazy` after `Repo.log` returned
  the property-stripped `HTTP Error: 503 Service Unavailable`. Trace
  `563d23a0e7a5ac39aa9dc89d134d3989` showed the project had already completed
  all four commits; only its later Artifacts-backed clone failed. Clone reads
  now retry that existing transient-infrastructure classifier locally at most
  three times, while branch/domain failures still propagate immediately.
- The same gate attempt timed out a live-capabilities project after its config
  artifact create occupied the callback for 160.512 seconds. Across 1,262
  creates in the surrounding window, p99 was 2.074 seconds and only this call
  exceeded eight seconds. The idempotent create plus ambiguous-create readback
  now share one eight-second deadline, safely below the 20-second hosted
  callback watchdog; expiry is an explicit retryable repo-creation obligation.
- Workflow `vhg630lf2m` passed all four linked cases first try, but its exact OS
  Worker version emitted two callback application errors for the same repo:
  first `RetryableRepoCreationError` at the eight-second create deadline, then
  `RepoNotSeededError` at the shared readback deadline. Both are explicitly
  retryable obligations, but neither class carried `retryable: true`, so the
  processor serializer could not preserve their availability classification.
  A red/green contract test now requires that flag on both errors; the existing
  wire serializer and stream receiver classification route them to warning
  telemetry while keeping the durable retry ladder unchanged.
- That workflow was also correctly rejected for a `repo-ide-svg-index-preview`
  retry. Project `prj_86b46f9224d849788e7e9d22a101bff6` spent two bounded
  drives in `artifact-get-or-create`, then emitted `repos/created` at
  02:34:22.267Z without a Git push. `Repo.commitFiles` immediately failed with
  `Could not find main`; the live Artifact still reports `last_push_at: null`.
  The recovery read returned a Workers binding handle whose runtime shape has
  `log()` but no `lastPushAt`, while the old condition treated the missing
  property as proof of a push. Red/green tests now cover a handle with no
  branch, a missing default-branch error, a valid existing head, and a stalled
  head check sharing the original deadline.
- Exact-head workflow `2lhj7j115w` rejected the next streak after two clean
  candidates. The approvals trace captured a 429 from
  `/api/auth/email-otp/send-verification-otp` with `x-retry-after: 46` while
  the popup still showed its email form. Better Auth keys that plugin limit by
  runner IP and endpoint, so seven unique test emails still contend for its
  default three requests per minute. Fixed-test-OTP stages now use 100/minute;
  production keeps 3/minute, with red/green policy coverage. The same workflow
  retried the recreated-source hosted-processor proof; its stream recovery
  remains separate from this auth fix.
- Since the quarantine merged, each test has been skipped 99 times across 98
  preview workflows through 2026-08-05 16:05 UTC.
- Exact-head baseline `pjdxkm1kjb` / attempt `ljkjs8v9mc` on `7df2242c3`
  passed all six preview groups, 190 OS tests, interrupted-session recovery,
  approvals in 51.6 seconds, and notifications in about one minute with no
  test retry. The strict Cloudflare audit rejected it for one unexplained
  exact-version error in trace `54342071e9bcc5e682d1166fe77f2194`:
  `ProjectDurableObject` called the project-config dynamic worker from its
  config-commit processor while the root Stream alarm's permanent
  `project-worker` feed called that worker in the same invocation tree. The
  latter succeeded; the former hit Cloudflare's four-dynamic-worker limit.

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
- 2026-08-06: Exact-head preview `16c29a0` passed CI but approvals retried. The
  root journal, PostHog result, and Cloudflare Worker logs tied the missing
  second notification to an internal Project DO storage reset and a 56.8s
  hosted-callback recovery gap. Added a deployed red Project-restart E2E plus
  unit coverage. A pending callback now gets a one-second liveness probe; a
  dead callback is closed and re-woken before the 20s work watchdog, while a
  busy callback keeps that full deadline. Explicit DO-availability failures
  retain the bounded attempt count but use a fixed one-second retry so prior
  infrastructure resets cannot inflate recovery latency. The focused 54-test
  sender suite, OS typecheck, lint, and formatting pass; preview validation is
  next.
- 2026-08-06: Preview `1c66ee9` made all three target cases retry-free, but its
  trace audit found callbacks orphaned by the deployment itself still reaching
  the 20s error watchdog. Their liveness probes timed out rather than returning
  Cloudflare lifecycle flags. Added a red/green three-consecutive-miss test and
  a success-between-misses test: a reachable slow processor keeps its full work
  deadline, while a callback whose owner cannot answer three pure pings moves
  onto the one-second availability path. The restoration streak remains zero
  until the next exact-head audit is clean.
- 2026-08-06: The first `df641ef` gate workflow passed both restored mobile
  specs but retried worker-bundler after a Cloudflare Stream DO storage reset.
  Trace reconstruction proved the reset interrupted `Project.create()` before
  worker-bundler ran. Added red/green project-create coverage and a one-retry
  terminal-wait recovery under the existing 100-second creation deadline; the
  focused project/stream suites pass 35 tests, and OS typecheck is green.
- 2026-08-06: PostHog confirmed both restored specs were retry/error-free, but
  the exact-version trace audit rejected the same workflow for 285 error-level
  hosted acknowledgement timeouts. A processor-owner ping does not prove its
  separate per-batch result callback survived. Added red/green classification
  and retry-policy coverage: an expired acknowledgement is now a bounded
  receiver-unavailable warning with a one-second retry, even late in the
  attempt ladder; genuine processor failures remain errors.
- 2026-08-06: One strict rerun passed every test without retry but emitted one
  Project processor callback error after the suite: `RepoNotSeededError` while
  probing a newly born config repo. Added a red lifecycle spec and routed that
  named transient (plus the matching build-in-progress shape) through the
  processor's existing bounded readiness loop. The 31 project-processor tests,
  OS typecheck, lint, and formatting pass. The restoration streak is zero
  because this product commit changes the candidate head.
- 2026-08-06: Candidate `888ae6e` made both target cases first-try green and
  had zero hosted-callback application errors, but the egress catalog case
  retried after a split 30-second/5-second wait. Consolidated it into one
  exact-state wait using the already-declared 30-second propagation budget.
  OS typecheck, lint, and formatting pass; the streak remains zero.
- 2026-08-06: Rejected gate candidates then exposed three independent recovery
  defects: final callback settlement could overwrite the one-second owner
  probe with a 20-second watchdog; one read clone surfaced a transient
  Artifacts 503; and one idempotent artifact create ran for 160.512 seconds.
  Added red/green alarm reconciliation, bounded clone retry, and shared
  eight-second artifact-creation deadline coverage. The four focused suites
  pass 104 tests, OS typecheck is green, and the streak remains zero pending a
  fresh exact-head preview.
- 2026-08-06: The next preview exercised both bounded repo recovery outcomes
  and proved they still arrived at the source Stream as application errors.
  Added the missing wire-safe `retryable` flag to both named repo-readiness
  errors. The expanded four-suite set passes 105 tests and OS typecheck is
  green; no test wait or assertion changed.
- 2026-08-06: Candidate `2lhj7j115w` reset a four-run clean streak. Besides
  the fixed-test-OTP rate limit, its recreated-source proof exposed an
  unbounded retained processor-state callback after the stream reset and wake
  had completed. A red/green unit spec now enforces a five-second
  receiver-unavailable boundary; the deployed proof retries only that named
  observation inside its existing 30-second restoration budget. The full
  sender suite passes 59 tests, and OS typecheck, lint, and format checks pass.
- 2026-08-06: The corrected Artifacts head passed four strict gate candidates.
  Candidate five reset the streak for an auth 429 and one
  recreated-source lifecycle retry. Trace evidence showed the OTP request was
  the fourth-or-later same-IP send inside Better Auth's 60-second window, not
  a slow locator. Added red/green policy coverage and raised only fixed-test-
  OTP stages to 100/minute; production remains at 3/minute.
- 2026-08-06: Head `050cd7c` passed its initial preview and three strict gate
  candidates. Candidate four `fdjddkrnf7` retried only the interrupted-session
  regression. Exact-version traces recorded 276 successful
  `StreamConnection.ping` calls after the deliberate kill: the aborted DO's
  old capability kept returning captured in-memory liveness indefinitely.
  Added red/green relay and wake-registry coverage. A relay with a wake socket
  now probes a fresh DO for that exact socket identity. Its tri-state result
  preserves intentional dormancy, clears a stale handle when an idle frame was
  missed, and rejects orphaned old incarnations. The three focused suites pass
  69 tests; OS typecheck, lint, and formatting are green.
- 2026-08-06: The first six relay-fix candidates yielded three clean runs and
  four rejected outcomes across three candidates. Two rejected candidates
  independently returned an Artifacts `get()` value without the documented
  `log()` method; another repo-lazy attempt saw an opaque Artifacts HTTP 503.
  Added red/green coverage that keeps the incomplete handle inside the same
  eight-second readiness loop. Real binding errors still surface unchanged.
- 2026-08-06: Head `6ff4108bd` passed three wholly clean strict candidates.
  Candidate four `4f0vk02271` passed the restoration targets but emitted one
  exact-version callback error. Cloudflare request `JYIM4U7R0977H5GL` showed
  a memory reset while acknowledging the root `project-worker` feed at offset
  380 for `matrix-cli-1`; PostHog tied the project to the examples-matrix pool.
  The same alarm showed 16 concurrent `getEventPage` calls. Removed the
  unconditional `loadAndRefreshLive()` from durable stream-index ingestion:
  the row still commits synchronously, loaded folds refresh inline, and cold
  folds load only for an attached live-state watcher. The regression is red on
  the old fan-out and green with the fix; four focused suites pass 42 tests,
  and OS typecheck, lint, and formatting pass.
- 2026-08-06: The first `cb7f670c5` candidate passed both restored mobile
  flows first try but retried `dashboard.spec.ts`. Its trace proved project
  creation, not the browser, was stuck: config repo
  `prj_2de87d10bdc34ea48b0b5ed0f622ea42` repeated the bounded eight-second
  Artifacts drive until `waitUntilProcessed` expired at offset 7. REST state
  confirmed an existing empty repo (`last_push_at: null`, empty `main` log),
  while the Workers binding returned a valid token-management handle without
  `log()`. Added red/green coverage and an explicit `requires-clone` branch
  state. Recovery now lets the existing clone-and-seed operation preserve a
  real head or seed the empty remote instead of retrying that handle forever.
  The 273-test repo/project set, OS typecheck, lint, and formatting pass.
- 2026-08-06: Head `29c441742` passed its baseline with 190 OS tests, both
  restored mobile flows first try, interrupted-session recovery, and no retry
  markers. Candidate `hx0b2b0z3n` failed before tests when Auth's post-deploy
  `setClient` returned 500. Exact trace `b877e9090b092860b9d935d678180e47`
  showed the freshly seeded bootstrap admin was not yet visible; the same
  idempotent seed passed immediately afterward. Added a red/green bounded-503
  seed test and an explicit server precondition: only that missing-admin state
  becomes `SERVICE_UNAVAILABLE`; arbitrary 500s remain terminal. Auth's 86
  tests, Auth and contract typechecks, lint, and formatting pass.
- 2026-08-06: The next exact-head preview `3nnr6dn0pw` reached Auth's D1 admin
  seed but Wrangler's import API returned Cloudflare code 7009, “Upstream
  service unavailable.” Added a red/green captured-output command spec and
  routed Auth migrations and seed imports through the deploy helper's bounded
  retry schedule. Only exact 429/7009 outcomes retry; recovered markers before
  a later unrelated error and all unclassified failures remain terminal. The
  18 deploy-helper tests and Auth's 86 tests pass with typecheck, lint, and
  formatting green.
- 2026-08-06: Head `e32c5486a` passed 190 OS tests and both restored mobile
  flows first try, but its baseline was rejected because Semaphore's
  allowed-slug waiter case retried once. Exact traces showed both waiters
  started before release; beta was reserved, then its D1 mirror write took
  6.944 seconds and crossed the five-second wait deadline. The old timeout
  discarded an assignment already in flight and returned both requests as
  conflicts. Waiters now time out only while idle in the queue; an in-flight
  assignment finishes, while its own failure rejects that waiter explicitly.
  The live case no longer relies on a 250 ms cushion. Semaphore typecheck, its
  four local tests, lint, and formatting pass.
- 2026-08-06: Baseline `3v3313vbpl` on `a7ec3271f` kept both restored mobile
  flows first-try green but retried six OS cases. Exact-version telemetry had
  277 error rows across config repos: each first `create()` crossed the
  processor's eight-second `Promise.race`; the late invocation could reserve
  the name, but its successful response and one-time initial write token were
  abandoned. Recovery then saw `ALREADY_EXISTS`, could not read the repo, and
  retried every second until project waits expired. The first sampled 503 also
  lost its availability property over hosted-processor RPC, now preserved by
  `RetryableRepoCreationError`, but the broader audit showed classification
  alone could not repair the orphaned create.
- 2026-08-06: Empty creation now durably enqueues a new
  `RepoBirthCoordinatorDurableObject` and releases the retained Stream
  callback. Its alarm validates the journaled request and stream ID, awaits
  first `create()` without abandoning the token, bounds only ambiguous
  readback, checkpoints the seeded Artifact before the terminal append, and
  publishes `repos/created` through `appendIfStreamId`. Repo adopts the exact
  seeded head before acknowledging birth. Classified vendor outages use a
  bounded explicit alarm retry; invariant failures remain error-visible. A
  180-second outer create deadline preserves the live-observed 160.5-second
  response while guaranteeing that a hung vendor call returns to the
  five-attempt ladder; the fifth classified failure appends one durable
  `repos/create-failed`. The red/green no-abandon, deadline, handoff,
  checkpoint, append-recovery, stale-lifetime, and wire-stripped-503 cases
  pass with all 246 repo tests (two expected failures), OS typecheck, root
  lint, and formatting. The generated itx API was refreshed for the new
  optional seeded-head certificate field after its freshness check caught the
  omission.
- 2026-08-06: Repo-birth baseline `pjdxkm1kjb` passed all six groups and both
  restored mobile flows first try, but strict trace audit rejected one
  dynamic-worker concurrency error in trace
  `54342071e9bcc5e682d1166fe77f2194`. A post-creation config commit was sent
  concurrently to the userspace `project-worker` feed and the Project
  processor's inline readiness probe from one retained root Stream alarm.
  Added a red handoff spec and a pure durable queue state machine. The
  processor now checkpoints an alarm handoff without probing; the Project DO
  later probes in an independent alarm invocation, checkpoints the exact
  success/failure outcome, and appends it through the original stream-ID
  fence. Queue tests cover dedupe, lost acknowledgement, stale stream,
  deterministic failure, bounded classified retry, visible invariant failure,
  and a second commit interleaving while the first probe is in flight. The 83
  Project-domain tests, OS typecheck, root lint, and formatting pass; a fresh
  exact-head preview and trace audit are next, so the 25-run streak remains
  zero.
- 2026-08-06: Exact-head workflow `tmsts7hq51` on `d12aea6fe` passed all six
  groups: 190 OS tests, both restored mobile flows first try, interrupted and
  recreated session recovery, and no retry markers. Exact version
  `5313b4d3-013b-4735-b709-3bf8cb415298` had no dynamic-worker concurrency
  failure, proving the alarm handoff. Its strict audit did catch three
  `stream core background work failed` rows from the deliberate
  paused-ancestor recovery spec. The receiving stream throws
  `StreamReceiverUnavailableError`; the classifier accepted only the plain
  `Error` name used after public RPC normalization, so direct Durable Object
  calls fell into error telemetry. A red/green spec now covers both wire
  shapes and keeps only the exact `stream paused:` contract outside error
  telemetry. The focused 10-test suite passes; a new exact-head baseline is
  required before the 25-run gate starts.
- 2026-08-06: Baseline `bnl8c233r4` on `03e0bda48` passed all groups and linked
  targets first try with no retry marker or restoration-blocking telemetry.
  Cold candidate `dd028cn0kp` also passed the workflow, but the strict audit
  rejected one `stream core background work failed`: local subscription
  `nack` hit Cloudflare storage reset reference `rke8qila30vbnhapsf1qshri`.
  Unlike a rejected stub call, local SQLite throws no lifecycle flags. A red
  regression now proves the exact referenced reset is classified outside error
  telemetry while a lookalike application message remains visible. Both
  focused suites pass (32 tests); the streak remains zero for the new head.
