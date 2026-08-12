---
status: in-progress
size: medium
branch: stream-fanin-stall-repro
---

# Reproduce: silent stream fan-in stall after redeploy

## Status summary

Investigation + repro task, spec committed first. Nothing implemented yet.
Goal: a deterministic failing test showing that a `/media`-style stream stops
delivering committed events to its `project-worker` feed (and therefore to a
userland processor host like MediaApp) after a redeploy-shaped eviction, with
no error events, no halt, no backoff — then fix it or write up the mechanism +
fix proposal.

## The incident (preview_8, project "nustom", 2026-08-12)

The mobile media feature appends `media/uploaded` to `/media`; the userland
MediaApp starter app (packages/iterate/src/starter-apps/media) reacts by
analyzing images and appending `media/processed` settlements. Fan-in chain:

```
/media Stream DO
  └─ "project-worker" itx-call subscription (start: beginning, onFailingEvent: skip)
       └─ evaluateItxExpression(["worker", ["processEventBatch", batch]])
            └─ template worker processEvent → MediaApp.create().processEvent
                 └─ workers.get(mediaWorkerRef).syncEvent(event)
                      └─ MediaApp DO registry.catchUp("media")   ← pull, folds + runs obligations
```

- Analysis worked all afternoon (76 processed events; a Delete-all wipe at
  15:24Z re-analyzed fine).
- The preview environment REDEPLOYED ~15:55Z (CI push): every DO evicted,
  in-flight RPC severed, runtime state gone; durable rows + alarms persist.
- After that: a wipe at 15:59:39Z + 19 fresh `media/uploaded` events
  (15:59:49–15:59:58Z) got ZERO processing. The MediaApp fold was later found
  frozen at stream offset 252 while the head was 486 — it never saw the wipe
  or the uploads.
- No `stream/error-occurred`, no revival events, breaker not tripped, no
  backoff state, journal healthy. Perfectly silent.
- One arbitrary wake (`worker.search()`, which drives `registry.catchUp`)
  healed it instantly: fold 252→498, all 19 obligations opened, settlements
  flowed in seconds.

Not the PR #2480 failure mode (that one is loud: crash loops, error events,
6h backoff plateau). Sibling, not duplicate.

## What the fold-frozen observation implies

`syncEvent` calls `registry.catchUp` on every delivered `/media` event, and
catch-up is a full pull from the stream. So a SINGLE delivered event after the
redeploy would have healed everything. The fold staying frozen means the
`project-worker` feed delivered nothing at all post-redeploy despite ~20
appends — each of which runs the stream DO's post-commit
`#reconcileCommittedState → sendDue → #sendDueSubscriptions`.

Also: the MediaApp keepalive (recovery: true) had nothing registered at
eviction time (all obligations settled by 15:24+), so no revival was owed —
the keepalive doctrine only protects in-flight registered work, not "future
events will keep arriving". The gap is delivery-side.

## Suspect surface (in rough priority order)

1. `sendDue`'s outer catch (stream-event-sender.ts): any deterministic throw
   in the pre-send phase (closeStaleHosted / sendQueued / pageDormantSubscribers)
   silently arms a backoff alarm and retries the SAME throwing path forever —
   no events, no halt, capped 30min retries that never progress. A fresh
   incarnation shape that throws here would look exactly like the incident.
2. The alarm chain across incarnations: `StreamDeliveryAlarmBoundary`
   scheduleOrRun arms an immediate alarm from the append turn; the delivery
   itself happens in the alarm turn. If the alarm write coalesces wrongly
   with the quiet-deletion (`clearWhenQuiet`) or the facet-desire repair,
   the armed wake could be deleted before firing.
3. `#sendPendingSourceOwnedEvents` in a fresh incarnation: interactions
   between the durable cursor row (nextAttemptAt/inFlightDeadlineAt persisted
   pre-deploy) and the new incarnation's in-memory sets.
4. The itx delivery evaluation (`deliverToItx` → authority root → dynamic
   worker load) failing in a way that is misclassified (not throwing into the
   failure ladder, e.g. hanging forever without the withDeliveryTimeout
   firing, or resolving without invoking).
5. The empty-read cursor-jump ("phantom lag" ack to maxOffset) skipping real
   events on a fresh incarnation whose log read misses rows.

## Plan

- [ ] Read the delivery machinery end to end (sender, stream DO reconcile,
      alarm armer/boundary, cursor store) — done enough to write the map above.
- [ ] Inspect preview_8 live: the `/media` stream's `project-worker`
      subscription runtime state (confirmedOffset vs head, attempt,
      nextAttemptAt, status) for project nustom. This discriminates
      source-side stall vs host-side stall with real data.
- [ ] Write the repro as a failing node test: real `StreamEventSender` over a
      real SQLite cursor store, drive a working delivery, then simulate
      redeploy (new sender instance over the same durable rows, in-flight call
      severed, alarms preserved-or-lost per the mechanism), append new events,
      assert the receiver gets them within the expected delivery window.
      Escalate to the workerd e2e suite only if the node layer can't express it.
- [ ] Identify the mechanism; fix if small and doctrine-clean, else write the
      proposal here + PR body.
- [ ] Full gauntlet: typecheck, lint, knip, format, relevant tests.

## Guesses / assumptions (flagged per AFK doctrine)

- Assuming the incident numbers (252/486/498) are approximate but the shape
  (frozen fold, silent, healed by one catchUp) is exact.
- Assuming preview_8 project "nustom" is still in the post-heal state and
  inspectable via `doppler run --config preview_8 -- pnpm cli ...`.
- Assuming the stall is source-side (stream DO → project-worker feed) based on
  the fold-frozen implication above; the live inspection should confirm.

## Implementation notes (lab notebook)

- (2026-08-12) Task created; delivery-chain map drawn from
  stream-event-sender.ts, stream-durable-object.ts, sdk.ts, starter-apps/media.
