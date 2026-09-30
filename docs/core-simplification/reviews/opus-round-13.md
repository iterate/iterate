# Round 13 review: Iterate core simplification (source 179629660f, read-only)

I only read the source. No tests were run, and nothing below has been executed.

**Verdict:** the round-12 findings A1–A5 are fixed as described. But the fan-out path still has two defects that break correctness and one alarm loop that wastes cost. They matter more than it first looks: every project context is born with a fan-out durable row that takes every durable event (`config`, see `apps/os/src/project/context-birth-events.ts:9-19`). So these bugs are on the default path, not an unusual configuration.

---

## Real defects, most severe first

### D1. A selective fan-out resume can stop the row permanently and fire the alarm once a second forever

- **Cause.** `resume()` gives the new resume stamp only to the item it resets. Other terminal items that haven't been reported yet keep the old `resumeAtOffset` (`packages/iterate/src/stream/durable-delivery.ts:246-256`).
- **Interleaving:**
  1. One wave marks offsets 5 and 7 terminal.
  2. The dead-letter fact for 5 is reported and 5 is removed.
  3. An operator appends `resumed {name, offset: 5}` at offset 100.
  4. The next `#drainFanOut` finds 7 first (`:529`) and reports it with `resumeAtOffset: undefined`.
  5. The DO throws GONE because the row is now resumed at 100 (`apps/os/src/iterate-context-durable-object.ts:1287-1291`).
  6. The runner catches that, sets a wake for +1s and returns (`:552-554`) before any admission or delivery.
- **Effect.** This repeats forever and survives restarts. Offset 5 is never redelivered, no new events are admitted, and the row doesn't show as halted.
- **Fix:** give every retained item the new stamp in `resume()`. That's a one-line change.

### D2. A dead letter goes back to the row that produced it, with no bound

- **Cause.** When a row declares no `consumes` (or `"*"`), `consumesEvent` selects every durable event (`packages/iterate/src/stream/processor.ts:153`). That includes the `subscription-delivery-failed` facts that `#recordConfiguredSubscriptionTerminal` appends (`:1301-1306`).
- **Interleaving:**
  1. A config worker throws `PERMANENT_FAILURE` for any type it doesn't know, or fails in general.
  2. Event E fails and dead-letter F1 is appended.
  3. `#pushDurableSubscriptionDelivery` sees F1 as due and the row admits it.
  4. F1 fails too, and F2 is appended, and so on.
- **Why nothing stops it:**
  - Each fact reuses `event.source.cause`, so the cause depth never increases.
  - These facts are stream records, so they skip the loop-limit check.
- **Effect:** with `PERMANENT_FAILURE` the loop runs at alarm speed. With transient failures, each chain adds one event per 15-attempt ladder (about 4.5 hours) and never ends. Two fan-out rows can also bounce facts between each other.
- **Fix:** durable rows should not implicitly select `subscription-delivery-failed` or `-halted`. Deliver them only when a row names them explicitly, the way ephemerals already work. Filter in `#readSubscriptionDelivery` and in the push predicate.

### D3. Hot alarm loop while a fan-out drain runs longer than 20 seconds

- **Cause.** `revive()`, and `#reconcile` on configuration commits, rebuild wakes from the stored cursor even for runners that are still draining (`apps/os/src/context/durable-subscription-delivery.ts:94-107, 178-194`). The fan-out calculation includes:
  - due retries in waves that haven't started yet, whose times are already past;
  - terminal items still carrying an old attempt deadline (`nextAttemptAtMs`) that is now past.
- **Interleaving:**
  1. A drain starts: recovery is set to T+20s, and there are 13 waves.
  2. Wave 1 fails, so its retries fall at about T+16s.
  3. At T+20s the alarm runs `revive()`. The runner is still draining, so `drive()` only sets `#again`.
  4. `#restoreWakes` sets the wake to the past T+16s. The pass ends and re-arms in the past. The next pass does the same.
- **Cost per pass:** a KV write for the recovery key, an alarm write, and two alarm-trace ephemerals that push other entries out of the 1 MiB ring.
- **Scope:** the loop lasts for the whole drain, up to 13 × 20s. A flaky config worker triggers it on its own.
- **Fix:** skip draining runners in `#restoreWakes`. The in-flight recovery key already covers them. The deletion option below (P1) removes the whole problem.

### D4. Ephemerals that sit below the durable head cost one alarm pass and one cursor write each

- **Interleaving:**
  1. `confirmed = 10`, queued ephemerals are 11, 12 and 13, and a durable lands at 14.
  2. Ephemeral 11 is delivered on the `through <= confirmed` branch.
  3. The next loop iteration computes `through = min(14, 11) = 11`. Nothing is selected, so it runs `putCursor(11)`, sets a wake for now, and **returns** (`durable-delivery.ts:406-411`).
- **Effect:** one ephemeral per pass. The claimed limit of 100 ephemerals per pass only holds for ephemerals above the head. This breaks "ephemerals cost zero writes", and the wait for the next alarm makes eviction from the ring likely.
- **The same branch also slows batches like `[durable, ephemeral]`:** a single ephemeral after a durable in the same commit still needs an extra alarm pass.
- **Fix:** when no selected durable offset precedes the queued ephemeral, deliver it without persisting anything and `continue`.

### D5. The delivery re-read isn't bounded by `through`

This has two effects.

- **Up to 100× parse cost.** Each fan-out item calls `readForDurableDelivery(offset-1, 100)` (`iterate-context-durable-object.ts:1102`), so it parses up to 100 rows (8 MiB) to deliver one event. During catch-up, most of each read is wasted.
- **A false GONE halts an ordered row.**
  1. A batch `[durable…, ephemeral]` puts the durable mark on the ephemeral's offset (`stream.ts:614`).
  2. The first read is at the head with `scannedThrough = H`, which is greater than the last row's offset.
  3. Later, a large row makes the second read stop at the page's byte budget right after row k, so `scannedThroughOffset` is below `through`.
  4. That returns GONE, which the runner treats as permanent, and the row halts.
- **Fix:** add an `offset <= through` bound to `readEventPage`.

### D6. A GONE caused by the source data halts the whole fan-out row

- **Cause.** `configuredTargetFailure` includes GONE (`durable-delivery.ts:132-133`). But `#durableSubscriptionDeliveryEvents` also throws GONE when the source selection changed or was empty, or when the range is beyond the head.
- **Effect.** A resume `{offset: X}` where X is ephemeral, not consumed by the row, or in the future halts the project's `config` row.
- **Related:** a resume offset above `admittedThrough` is added to pending _and_ admitted again later, so it's delivered twice (`:260`).
- **Fix:** throw `PERMANENT_FAILURE` for source-selection problems, so the item is dead-lettered instead of the row halting.

### D7. The webhook retry policy is fixed when the runner is created

- `maxAttempts` and `retryCapMs` come from `targetIsWebhook`, which resolves through the live rules (`iterate-context-durable-object.ts:1022-1025`).
- The runner is only built `if (!runner)` (`durable-subscription-delivery.ts:131-152`), so later rule changes don't apply until a cold start.
- After a restart, a lower `maxAttempts` applied to a persisted attempt count halts the row immediately. The error then says "did not settle before its host restarted", or repeats whatever error was stored earlier.

### D8. The fan-out cursor grows with pending items and is rewritten in full for every item

- **Rewrite cost.** Every item does two reads and two writes of the whole cursor (`:649, 669, 701`). With 1000 pending items at about 1 KiB of error text each, that's about 1 MiB rewritten around 200 times per pass.
- **The cap is in characters, not bytes.** Error strings are cut at 1024 characters. Characters outside Latin-1 serialize at two bytes each, so the cursor can exceed the per-value KV limit (2 MB on SQLite-backed storage, as I recall; please verify).
- **What happens then.** The put throws inside `#deliverFanOutItem`'s catch, so the drain rejects without setting any wake. An unexpected throw in `#drain` generally leaves no wake at all, which is itself a gap in the KV-wake guarantee.
- **Fix:** write once per wave, and keep the full 1 KiB error only on terminal items.

### Smaller issues

- **Wrong progress figure in the subscription list.** For fan-out rows, `#subscriptionList` reports `admittedThrough` as `confirmedOffset`, and `paused: false` is hard-coded (`:1923, 1941`).
- **Ephemeral delivery parses an unrelated body.** It reads and parses the next _durable_ row's body just to find an entry in the ring (`:1126-1128`).

---

## Operational risks

- **A hung raw call pins the context.**
  - `pinCallStarted()` runs for every configured delivery (`:1148`), so the pin count never returns to 0.
  - As a result, the pin-release timer never starts, borrowed stubs stay borrowed, and the unclaimed-facet sweep re-arms forever.
  - Stub targets are already pinned by `RpcStubHandle`, so removing these two lines loses nothing.
- **One slow row makes healthy rows burn attempts.**
  - The shared body budget holds a large delivery, which can be up to 32 MiB when it's the only one in flight.
  - After 20s, the other rows' refusals stop counting as "busy" and become real attempts (`:1188-1192`).
  - So healthy rows move toward halting because of another row's slow target.
  - Ordered rows also share one delivery slot (`rowKey`) between best-effort ephemerals and durable ranges, so a hung ephemeral does the same to the row's own durable deliveries.
- **Pause.** Targets that append get `STREAM_PAUSED`, which spends attempts and leads to halts or dead letters. Schedules, by contrast, wait while the stream is paused. I'm flagging this, not recommending that delivery wait indefinitely.
- **About 5–7 storage writes per durable event in every project context**, because of the birth `config` row:
  - a KV put and a KV delete of the recovery key;
  - three cursor writes: admission, attempt start and settlement;
  - an alarm set and an alarm delete.
    These need measuring.
- **Sparse catch-up is slow.** An empty 100-row page still uses a whole pass, so a sparse row catching up through 1M rows needs about 10k passes.
- **Ephemeral floods.** A sustained flood to an ordered row causes one alarm pass per drain, plus `console.warn` for every dropped or failed ephemeral. That's a log-volume risk. A drain can also spend up to 100 × 20s on best-effort calls.
- **Live callback with the same name.** A live callback attached under the same name as a durable row doesn't stop the durable runner, so both targets receive events. Please decide which behaviour is intended.

---

## Missing tests, and the probes to add

The unit cold-recovery test uses a pending entry without `nextAttemptAtMs`, which the current SDK never writes. None of the following is covered:

1. **D1:** a fan-out row with two terminal items; report one, then `resume(undefined, 5, R)` with a `terminal` stub that rejects a stale stamp. Expect 7 to be reported and 5 redelivered.
2. **D2:** a project context whose config `deliverEvent` throws `PERMANENT_FAILURE`. Append one event and count `subscription-delivery-failed` after 30s. Expect exactly 1.
3. **D3:** a fan-out drain lasting over 20s whose wave 1 fails. Count `alarm-trace` passes during the drain. Expect 3 or fewer.
4. **D4:** ephemerals 11–13, then a durable at 14. Expect a single drive and no cursor writes before admission.
5. **D5:** a `[3 MiB durable, ephemeral]` commit, then a 6 MiB durable; fail attempt 1, then retry. Expect no halt.
6. **D6:** a resume of `config` with an ephemeral offset or an offset beyond the head. Expect the row not to halt.
7. **D7:** change the rules so the target now resolves to a webhook, without a restart. Check the attempt bound.
8. **D8:** 1000 pending items with 1 KiB errors containing non-Latin-1 characters. Check the put succeeds, and measure CPU per pass with 100 items of 80 KB each.
9. **Crash recovery:** abort or evict at each of these points:
   - after the commit but before the drain starts;
   - mid ordered attempt;
   - in fan-out wave 3;
   - during the terminal report;
   - after a +1s read-failure wake.
     With no inbound call, delivery should resume within about 20s plus alarm latency.
10. **Hung target:** watch `activeTargetDeliveries`, the pin state, other rows' attempt counts, and when the row halts.
11. **Write cost:** storage writes per event in a freshly born project context.

---

## Relaxations and deletions that keep existing capabilities

Line counts include the SDK.

- **P1 (largest payoff): delete wake reconstruction.**
  - What goes: `#restoreWakes`, `#coldRecovery` and the constructor's `sync()` call, about 35 lines in `apps/os` and 0 in the SDK.
  - Why it's safe:
    - The KV recovery key already covers every cold and mid-drain gap.
    - `revive()` already drives every row that isn't halted.
    - Runner-scheduled wakes would become the only in-memory source.
  - What it fixes: D3 and the whole class of "reconstruction overwrites a wake the runner scheduled". It also removes KV writes from the constructor; the orphan sweep and `halt` would run at the first reconcile instead.
  - Cost: a retry scheduled by another runner mid-drain can run up to about 20s late after a cold start.
  - Proof needed: probe 9.
- **R1–R6 are one-site changes:** the D1–D6 fixes above.
- **Remove `pinCallStarted/Ended` from configured delivery:** 2 lines.
- **Remove the ephemeral queue's `sort` and duplicate check:** 2 SDK lines. Pushes already arrive in offset order, once each.
- **Decide the webhook ladder from the configured target, not the live rules.** The row cache then keys on `subscriptions` alone.
- **Raise the victim threshold for the body budget** from 20s (the same as one call deadline) to a fixed bound such as 300s. It stays bounded.

---

## Ready with full tests, a preview, a 100-run soak and logs?

Not as the code stands. D1, D2 and D3 only appear with a slow, flaky or permanently failing target. A soak against a healthy target won't reach them, even though the birth `config` row exposes every project to them.

After fixes for D1–D6, probes 1–11 passing, and a soak that injects faults (a slow/flaky config worker and one that fails permanently), it would be ready if these logs stay clean:

- the pass rate of `alarm-trace` per context;
- `subscription-delivery.context-background`;
- the volume of `durable-delivery.*` warnings;
- `platform-failure-alarm-rearm`;
- `body-budget-exhausted`.
