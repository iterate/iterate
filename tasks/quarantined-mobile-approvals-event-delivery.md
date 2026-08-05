---
state: in-progress
priority: high
size: large
tags: [ci, e2e, mobile, approvals, notifications, quarantine, flake]
---

# Restore the quarantined mobile approvals event-delivery e2es

## Status

Investigation started 2026-08-05. The quarantine is still active and no fix is
claimed. PostHog shows a pre-existing flake which spiked during broad preview
load on 2026-08-03; the next step is to reproduce it with first-missing-
transition diagnostics and separate capacity rejection from processor loss.

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
  script-concurrency failure, and stream-wait timeouts. This is correlation,
  not yet proof that capacity pressure is the trigger.
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

1. Shared dynamic-worker capacity pressure rejects or delays a Script
   Execution, and the failure is not durably classified or propagated to the
   thread. Prediction: a controlled concurrency limit reproduces a missing
   approval batch while a serial run passes, and correlated execution facts
   end before approval creation.
2. The egress batching processor loses or strands a held-request obligation
   during concurrent delivery or Durable Object eviction. Prediction: the
   Script Execution starts and the fetch parks, but no matching Approval Batch
   fact appears; replay or eviction reproduces the same source-offset gap.
3. Approval facts exist durably but a live thread subscription misses them.
   Prediction: the root stream contains the complete batch and decision while
   only the browser view is absent; reconnecting from a durable cursor repairs
   the view without creating new facts.
4. Notification intent delivery or device journaling strands a durable
   obligation. Prediction: the Approval Batch and root
   `notification/requested` fact exist, but the device stream lacks the
   correlated terminal notification event after its bounded deadline.

## Work

- [ ] Remove both skips on the investigation branch so failures are observable
  without weakening assertions, waits, or retries.
- [ ] Add one correlated diagnostic surface covering Script Execution request,
  start and settlement; held request and Approval Batch creation; approval
  decision; root notification intent; and device notification settlement. A
  failure must identify the first absent transition, project, stream path,
  execution/batch/device identity, and source offset where applicable.
- [ ] Establish a serial baseline, then raise the reproduction rate with the
  existing four-worker stress shape and a production-shaped fully parallel
  preview. Capture the exact first absent transition for each failure.
- [ ] Minimize the first confirmed failure at the public itx or stream-
  processor harness seam. Preserve it as a readable red regression test before
  changing product behavior.
- [ ] Fix the owning state machine. Capacity exhaustion must become bounded
  durable recovery or an explicit terminal outcome; processor obligations
  must survive eviction. Do not add polling, broader waits, fallback values,
  compatibility shims, or another retry layer.
- [ ] Re-run the original browser flows serially, under the focused concurrent
  stress loop, and in the canonical fully parallel preview lane.
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
