I found one concrete bug, a lost wake. The round-14 fresh-row fix covers durable pushes but not a cold context whose first relevant push is ephemeral-only. Everything else I checked holds. I only read code; I ran no tests.

## Blocker: an ephemeral-only first push deletes another row's persisted retry wake

The in-flight `finally` in `#runDurableDelivery` (`iterate-context-durable-object.ts:545-548`) replaces the persisted recovery key with `deadline`. That value only includes runners that have been driven in this incarnation. Fresh runners are driven only when the push contains a durable event (`durable-subscription-delivery.ts:80`).

**Minimal interleaving:**

- **Setup:**
  - Row A is ordered with `consumes: ["tick"]`.
  - Row B has `consumes: ["work"]`, ordered or fan-out. Its cursor has `pending.nextAttemptAtMs = T`, so `durable-delivery-wake-at = T` is persisted.
  - The context is evicted before T.

1. A client calls `append({ type: "tick", ephemeral: true })`.
2. The `itx/woken` wake record commits. No row consumes it, so `#pushDurableSubscriptionDelivery` returns early (`:946-960`). No runners are built.
3. `tick` commits and `push` runs. `#reconcile` builds A and B as fresh runners. Only A is driven, because B is fresh but the push has no durable event and B doesn't consume `tick`.
4. A's run writes the recovery key as now+20s, delivers the ephemeral, then calls `scheduleWake(null)`.
5. In the `finally`, in-flight drops to 0 and `#setDurableDeliveryRecovery(deadline)` runs. `deadline` only knows about A, so it is `null`: the KV key is deleted and the alarm is removed.
6. B's retry at T never fires. B is also no longer "fresh", so it stays stuck until one of these arrives:
   - a `work` event
   - a configure, resume or halt event
   - an unrelated full alarm pass (schedule, claim or run).

The same thing happens to any owed work on B, such as an interrupted in-flight claim or admitted fan-out items.

**Minimal fix:** at `durable-subscription-delivery.ts:80`, drive every rebuilt runner once, the same way `revive` does:

```ts
const relevant =
  configurationChanged ||
  fresh.has(key) ||
  events.some(
    (event) => consumesEvent(row.consumes, event) && (!event.ephemeral || row.ordered !== false),
  );
```

- **Cost:** one drain per row per incarnation, not one per ephemeral. So ephemeral storms still don't drive warm fan-out rows, which keeps the irrelevant-fanout fix in place.
- **Test to change:** "an ephemeral-only commit does not drive a fresh fan-out row" (`durable-subscription-delivery.test.ts:254`) expects the current behaviour. Change it to assert that a second ephemeral-only commit doesn't drive the now-warm fan-out row.
- **Regression test to add:** copy the test at `:207`, but make row `a` ordered with `consumes: ["tick"]` and push `[{ offset: 3, type: "tick", ephemeral: true }]`. Expect `deadline === retryAt`. The current code returns `null`.

## Checked and correct

- **Generation fencing:** every cursor write after an await in the ordered drain, the fan-out waves, the terminal splice and `#reportHalted` is guarded by `isCurrent`. Resume, halt and dispose are the only other writers, and each changes the generation.
- **Resume and seek:**
  - Ordered resume clears `pending` and seeks to `halted.after`.
  - Fan-out seek clears pending items, and a selective offset uses the new boundary.
  - A future selective offset is left for normal admission.
  - `halt()` is a no-op on repeat, so there's no write on every push.
  - A cold cursor that already applied a resume isn't reapplied.
- **Retry bounds:** busy and stale-resume retries don't spend an attempt, but both become attempt-spending after 20s. An interrupted final attempt ends in a halt or dead-letter.
- **Source cause:** row halts take the cause from `sourceOffset`, which is the first selected event (ordered) or the refused item (fan-out). An ephemeral-gap selective resume gets no borrowed cause.
- **Logs:** under the normal commit→push ordering, the `ephemeral-overtaken` warning only fires after a real seek. I found no new noisy log path.

## Remaining known risks (not blockers)

- **Fenced final fan-out attempt:** suppose a warm resume that doesn't halt lands while an item's final (25th) attempt is in flight. That item keeps `attempt == max` and is then dead-lettered with the "did not settle before its host restarted" message, without another real attempt. This matches the interrupted-final design, but the message is misleading.
- **Duplicates after a fan-out refusal halt:** the halt persists the whole wave, including items that already succeeded, so those are redelivered after resume. That's allowed under at-least-once.
- **Already-accepted costs:**
  - one terminal receipt per alarm
  - hung native calls keep their body budget and pins, and spend attempts after 20s
  - the global recovery key and old-owner refusal remain.
