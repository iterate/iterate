Found 8 concrete correctness bugs.

1. [stream-processor-runner.ts:689](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:689) — `onCaughtUp` can still wedge because the runner never performs the required unfiltered trailing pull.

   Failure scenario: requested event N is consumed; N+1 is an unconsumed durable tail event. The production wake lane delivers only N with `streamMaxOffset=N+1`. The runner commits through N, sees it is behind, and does nothing further. N+1 is never delivered, so `onCaughtUp` never runs and the obligation opened by N remains undriven indefinitely. The harness masks this by manually delivering the unconsumed event at [stream-processor-runner.test.ts:891](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.test.ts:891), unlike the real consumes-filtered wake lane.

2. [stream-processor-runner.ts:684](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:684) — per-event cadence commits the head cursor before `onCaughtUp` and its blockers run.

   Failure scenario: cadence commits every event. The final event E is durably acknowledged at lines 684–686; then `onCaughtUp` starts at line 694. If its `blockProcessorWhile` work fails or the incarnation dies, the cursor is already at E. Redelivery contains no pending events and returns at line 617, so the failed head work is not retried. Thus `onCaughtUp`’s purported blocker does not hold the cursor. This is a real lost-work path, not merely partial-frame acknowledgement.

3. [stream-processor-runner.ts:823](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:823) — loading assumes the reduction cursor equals the processing cursor, although the declared valid invariant permits reduction to lag.

   Failure scenario: persisted progress contains a valid current-version state reduced through 5 and acknowledged through 10. Load accepts it without rebuilding 6–10. Delivery resumes after 10; event 11 is reduced onto state-through-5, then committed as state-through-11. Contributions from events 6–10 are permanently absent. Conversely, an invalid reduction-ahead-of-ack record is also accepted and published. The loader must validate cursor ordering and catch the fold up to acknowledgement before exposing it.

4. [stream-processor-runner.ts:889](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:889) — CAS on `cursorRevision` alone does not fence stale commits at the same revision.

   Failure scenario: incarnation A begins from `{ack: 0, revision: 0}` and stalls. Incarnation B processes through offset 2 and commits `{ack: 2, revision: 0}`. A later commits offset 1 with expected revision 0; the store accepts it because the revision still matches, rolling durable acknowledgement and state backward. A slow reduce-only refold can similarly overwrite newer normal progress. The harness store implements exactly this weakness at [stream-processor-runner.test.ts:241](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.test.ts:241). The revision bump correctly fences pre-`reprocessFrom` work, but normal same-revision progress also needs monotonic/versioned CAS protection.

5. [stream-processor-runner.ts:528](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:528) — `skipThrough` accepts offsets beyond the durable head and does not validate finite integer input.

   Failure scenario: journal head and acknowledgement are 10; an operator typo calls `skipThrough(1000)`. The read ends at the real head, but lines 565–573 persist both cursors as 1000. Future events 11–1000 are silently treated as already acknowledged and never processed. `NaN` also passes the comparison and can be persisted because `NaN > NaN` is false in the harness invariant check.

6. [stream-processor-runner.ts:318](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:318) — consequential background work is allowed without durable recovery.

   Failure scenario: a durable runner is configured with only `progress`; `processEvent` calls `runInBackground`; the frame commits and advances acknowledgement, then the DO is evicted before the background outcome is journaled. Lines 980–982 run directly or use only the non-durable incarnation keepalive, so no durable alarm or revival exists. Redelivery starts after the acknowledged event, permanently losing the outcome. The constructor checks only “recovery present implies some revived consume,” not the required reverse implication.

7. [stream-processor-runner.ts:724](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:724) — permanent blocker failures are not retried indefinitely.

   Failure scenario: `blockProcessorWhile` rejects on every delivery. The runner simply rethrows to the transport. The existing transport retries finitely and then parks the subscription; `skipThrough` changes processor progress but does not resume that parked subscription. The harness’s “retry-forever” claim at [stream-processor-runner.test.ts:807](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.test.ts:807) performs only one additional direct sink call and does not model backoff or parking.

8. [stream-processor-runner.ts:323](/Users/jonastemplestein/.herdr/worktrees/iterate/stream-runner/apps/os/src/domains/streams/stream-processor-runner.ts:323) — the recovery construction check accepts the wrong processor’s revival event.

   Failure scenario: processor `foo` consumes `events.iterate.com/bar/revived`, while its recovery adapter appends `events.iterate.com/foo/revived`. The `endsWith("/revived")` check passes, but the actual revival event does not invoke `foo`’s revived handler. `ProcessorRecovery` carries no expected event type, so the runner cannot validate identity.

The core per-event blocker placement is otherwise correct: event N+1 does not start until N’s blockers resolve, and all already-started blockers are settled before frame rejection. Persist-before-in-memory-advance, reduce-only refold execution, revision-0 legacy idempotency-key bytes, and the post-commit parse-diagnostic lane are also correctly implemented on their directly tested paths.
