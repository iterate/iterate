---
status: in-progress
size: medium
blocks: agent-birth-userland-refactor
---

# Worker delivery obligations: the config-worker event feed becomes load-bearing

## Status summary

Audit complete — and it rewrote the task. The delivery layer was already
hardened well past this task's assumptions (details below); the real
remaining gap is narrow: **worker-build-in-progress errors are classified as
a failing *event* instead of an unavailable *receiver***, which routes the
~1-minute first-build window into the skip-then-halt lane. Fix is surgical.
Remaining: implement the classification fix + tests.

Prerequisite for
[agent-birth-userland-refactor](agent-birth-userland-refactor.md): that
refactor makes every agent birth *and every turn* ride this delivery path.

## Audit findings (2026-08-18)

The task was specced against the delivery behavior observed on 2026-08-11
(dropped birth handovers during first build; "skip-on-failure,
observation-grade"). The streams rebuild (#2395 and successors) already
landed most of what this task assumed was missing:

- **Park-and-retry exists.** Failed deliveries back off exponentially
  (1s → 30min cap, ±20% jitter), `MAX_DELIVERY_ATTEMPTS = 15` ≈ 2–2.5h of
  continuous outage, then a LOUD halt: `stream/subscription-delivery-halted`
  event + red UI row, resumable via one itx call
  (`stream/subscription-delivery-resumed`). `stream-event-sender.ts`.
- **"Skip" is not silent or naive.** Under `onFailingEvent: "skip"`, a batch
  failure first pins the read to batch-size 1 (isolate-or-progress); the
  isolated event must fail `FAILING_EVENT_CONFIRM_ATTEMPTS = 3` consecutive
  times before being stepped over, each skip appends a
  `stream/error-occurred` audit event, and 3 skips without an intervening
  success trip a mass-skip fuse → halt ("everything fails" means the
  receiver is down, not that events are bad).
- **Receiver-unavailability never becomes a skip verdict.**
  `isStreamReceiverUnavailableError` / DO-availability errors go to the
  backoff/halt ladder with a retry counter deliberately separate from the
  per-event confirmation fields.
- **Start cursors are right.** Child project streams configure their
  `project-worker` feed at birth with `start: "beginning"` — the worker sees
  full history once it first builds. The root's feed is installed by the
  creation saga only *after* the worker answers its readiness probe, and
  deliberately starts at its own configuration event (the platform's
  creation facts stay private to the saga; `project/created` is the first
  userspace event). That's design, not a gap.

**The remaining gap:** `rethrowItxDeliveryError`
(`stream-durable-object.ts:~300`) converts only hung-entrypoint
cancellations into the receiver-availability contract. A
`WorkerBuildInProgressError` (name-based, survives RPC —
`worker-loader.ts`) or repo-not-seeded error thrown through the
`processEventBatch` dispatch is an *ordinary* error to the sender, so under
`skip` policy it enters the failing-EVENT lane: isolate → 3 fast attempts
(~1s+2s) → skip (potentially skipping `agent/created`!) → 3 skips → halt,
all within the first ~20s of a ~60s first build. After the build, the
subscription stays halted until manually resumed. This is the modern
descendant of the bug observed on 2026-08-11.

## Checklist

- [x] Audit the dynamic worker invocation + subscription delivery paths;
      write up the failure modes found _above; the assumed missing machinery
      mostly exists — one misclassification remains_
- [x] Classify worker-build-in-progress + repo-not-seeded + deterministic
      build-failed (cause-chain walking, name-based) as
      receiver-unavailability in the itx delivery path — build windows
      park-and-retry, never skip, never pre-confirm a failing event
      _`isProjectWorkerUnavailableDelivery` in stream-durable-object.ts,
      used by `rethrowItxDeliveryError`. Build-FAILED included too: the
      build is unretryable but the receiver recovers on a fix commit, and
      parking loses nothing where the skip lane loses three events_
- [x] Tests: classifier signals + cause-chain wrapping + cycle safety +
      ordinary-handler-error negative
      _project-worker-delivery-classification.test.ts; sender-side
      park-on-unavailability and isolate/skip/audit behavior already pinned
      by stream-event-sender.test.ts (67 tests green together)_
- [x] ~~Park-and-retry replaces skip-on-failure~~ _already exists
      (backoff ladder + halt + resume); see audit_
- [x] ~~Defined start cursor~~ _already exists: children `start:
      "beginning"`; root post-probe by design_
- [x] ~~Dead-letter visibility~~ _already exists: halted event + red UI
      row + per-skip audit events_
- [ ] No regression to the "can't wedge the stream" property: delivery
      failures must never block appends or other subscribers _(covered by
      existing sender tests; re-verify lane green)_

## Follow-ups noted, deliberately not here

- Auto-resume halted `project-worker` subscriptions on
  `project/worker-updated` (only matters for >2.5h build outages once the
  classification fix lands).
- Watchdog primitive ("expected follow-up event didn't arrive within X
  ms") — the birth refactor's keeper deadline covers the birth case; a
  generic primitive is its own task.
- [streams-event-delivery-flake-under-concurrent-load](streams-event-delivery-flake-under-concurrent-load.md)
  may share a root cause with none of the above (saw 0 events for 120s on
  *hosted* wake paths) — not touched here.

## Notes

- Latency is explicitly out of scope (separate speed round after the birth
  refactor); this task is about *never losing* deliveries, not making them
  fast.
