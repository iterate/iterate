---
state: in-progress
priority: high
size: medium
tags: [ci, e2e, mobile, approvals, notifications, quarantine, flake]
---

# Restore the quarantined mobile approvals event-delivery e2es

## Status

The restoration is being rebuilt from current `main` as a narrow replacement
for draft PR #2428. The original investigation proved several failures at the
mobile delivery seam, but its full-preview marathon also absorbed unrelated
Auth, Semaphore, Artifacts, repository-birth, and deployment fixes until the
PR reached 98 files. Those platform findings remain valid work, but they are
not part of this restoration.

The narrow replacement is implemented and locally green. It contains only
directly reproduced script-worker ownership, approval-claim ordering, bounded
push settlement, accepted-message handoff, correlated diagnostics, and the two
unskips. The current preview passed 16 targeted cases before the shared auth
signup helper retried at its missing OTP-form navigation boundary; that helper
now waits for the visible form before using the normal action budget. The code
change resets all exact-head counters. Remaining work is a fresh deployment,
25 consecutive paired four-worker iterations, three canonical previews, and
review/telemetry cleanup.

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
- PostHog shows the failure predates PR #2388 and rose with preview load. Across
  recorded CI runs, approvals had failures or retries from 2026-07-29 onward;
  notifications retried on 2026-07-31, then failed or retried repeatedly on
  2026-08-01 and 2026-08-02. On 2026-08-03, approvals failed 11/74 and retried
  21/74 while notifications failed 9/74 and retried 20/74.
- The first investigation reproduced the load boundary locally: one approvals
  flow grew workerd from 164 MB to 4.6 GB. One-off `runScript` isolates were
  entering Worker Loader's reusable `get()` cache under a unique identity;
  parallel runs retained workers that could never be reused and eventually
  hit dynamic-worker capacity.
- A separate durable-ordering reproduction copied
  `project/approval-presented` before its matching notification intent. The
  Device reducer discarded the early claim, sent a push the foreground user
  had already suppressed, revoked the rejected fake token, and removed the
  subscription before the next intent could arrive.

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

## Work

- [x] Port only the directly reproduced fixes onto current `main`; do not pull
  unrelated gate discoveries into this PR.
  _Worker ownership, approval ordering, push settlement, and the accepted-
  message handoff are isolated in replacement PR #2460._
- [x] Add correlated diagnostics for every transition from script fetch hold,
  through batch creation and decision, to the device notification journal.
  A missing transition must become a bounded, classified failure rather than a
  vanished button or row.
  _`approval-delivery-diagnostics.ts` prints the durable chain and first absent
  transition when either restored UI wait expires._
- [x] Preserve one red/green regression per accepted product fix at the public
  Worker Loader, Device processor, Stream delivery, or Expo-send seam.
  _Focused red/green tests cover one-off loading and ownership, early approval
  claims across eviction, the terminal Expo deadline, and live activity after
  message acceptance._
- [x] Minimize whether the loss occurs in the egress batching processor, the live
  thread subscription, or notification journaling, then fix the owning state
  machine without polling, broader waits, or another retry layer.
  _The confirmed losses were retained one-off workers and discarded early
  approval claims; current main's Subscriber Pager already owns stream revival._
- [x] Remove both explicit skips without changing test timeouts or retry policy.
  _Both Playwright cases are active and discoverable; the out-of-band watched
  run now proves its durable start and live running-state projection before the
  approval-delivery wait, with no timeout or retry widened._
- [ ] Verify that a settled script cannot lose its approval batch or device row
  across Durable Object eviction and concurrent preview load.
- [ ] Run the prior four-worker stress reproduction for 25 consecutive paired
  passes on one exact commit. Any target retry, failure, missing transition, or
  relevant unexplained Worker error resets the streak; a code change also
  resets it. Infrastructure failure before either test starts is not a pass or
  a streak reset.
- [ ] Run three canonical fully parallel preview workflows on that exact commit.
  Both restored flows must pass on their first attempt, and any unexplained
  platform error remains release-blocking but is fixed in its owning PR.
- [ ] Leave the replacement PR unmerged, with green CI, no unresolved review
  threads, and exact PostHog/trace evidence in its body.

## Exit criteria

- Remove the explicit skip and make the original case pass without increasing
  its timeouts or retries.
- The test asserts a durable diagnostic at the first missing transition, so a
  future failure identifies the owning processor and source offset.
- Twenty-five consecutive paired four-worker stress iterations pass on one
  exact head, followed by three canonical fully parallel preview workflows in
  which both restored flows pass first try.
- CI, exact-version telemetry, and review are clean. The PR remains unmerged
  until the user explicitly approves it.

## After merge

Monitor the first 25 natural canonical preview occurrences in PostHog. A retry,
failure, or missing-transition diagnostic is investigated immediately; do not
hide a recurrence with a timeout increase or another retry.

## Implementation log

- 2026-08-10: Re-audited Slack, PostHog, draft PR #2428, and current `main`.
  Confirmed the tests exposed real load-sensitive product defects rather than
  a regression introduced by #2388. Started a clean replacement branch and
  excluded the unrelated platform fixes accumulated by the old marathon.
- 2026-08-10: Replacement PR #2460 passes full workspace CI, workspace
  typecheck, 56 focused worker tests, 30 Device tests, 23 mobile tests, and 66
  current-main Stream sender/Subscriber Pager recovery tests. Added the
  `preview` label to start the exact-head deployed gate.
- 2026-08-10: The first four-worker gate attempt reproduced two notification
  failures during the cold gap before `script-run-started`; both approvals
  arrived normally after test cleanup. Added a durable-start boundary followed
  by the existing visible `running code…` projection before measuring live
  approval delivery. A validation replay then exposed a same-millisecond
  parallel project-slug collision; both specs now include the Playwright worker
  index. The unchanged four-worker/eight-outcome shape subsequently passed 8/8
  against preview 8. Formal counters remain at zero until the new exact head is
  deployed.
- 2026-08-10: Canonical preview on `ec841aa78` deployed OS version
  `12a99a85-d3bc-4831-a44b-8e5823be2649`; both restored flows passed first try
  in 53.5s and 58.7s. The workflow still failed because the unrelated
  `clients-os-app` spec called `capabilities.browser.url` as soon as the client
  catalog saw its provider Pager, before the following capability-provided
  event reduced. The product contract documents those as separate durable
  transitions. The spec now polls the public call through that one classified
  mounting outcome; its four-worker replay passed 4/4. This gate-discovered
  test fix changes the head, so the formal mobile and canonical counters reset.
- 2026-08-10: On `c4a99261d`, the targeted four-worker gate passed 16 cases
  before an approvals attempt retried after 2.5s. The restored approval path
  had not started: the shared signup helper submitted the email address and
  immediately tried to fill an OTP field that had not mounted within the
  global 1s action budget. Its retry passed. Added an explicit 15s visible-form
  boundary followed by the normal-budget fill; exact-head counters reset.
- 2026-08-10: Audited two script-related retries from canonical run
  `cxgcwbgdvt`. Durable history classified the fence test as a Worker rollout
  reset and the concurrency batch as 20 safely orphaned executions after its
  common CapabilityHost incarnation vanished mid-hold. Both are known rollout
  failures, not evidence that one-off Worker disposal raced settled calls.
