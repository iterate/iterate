# Round 14 review: source `7cdbc4f00944951f919fa6b0d0b26d32821ae94f`

I only read files: no tests were run and nothing was changed. I also had no search tool, so "the context is the runner's only host" is unconfirmed.

## Is the wave-local fence true for every entry?

**Yes, for cursor integrity.** Every writer of `durable-delivery/<key>` other than the single drain bumps the generation first.

- **SDK entries:**
  - `resume` bumps it in both branches (`durable-delivery.ts:239`, `:266`).
  - `halt` bumps it at `:288`. Its early return writes nothing.
  - `[Symbol.dispose]` bumps it at `:214`, and the wave's own row refusal at `:703`.
  - `push`, `drive`, `snapshot` and `#queueEphemeral` never write. `#requested` guarantees one drain per runner.
- **Native entries:**
  - `DurableSubscriptionDelivery.#reconcile` is the only caller of halt, resume and dispose. It runs synchronously in the `onCommit` of the commit that changed the row.
  - It disposes before it deletes (`durable-subscription-delivery.ts:110-113`), and the one-time sweep deletes only keys with no live row.
  - `destroy` aborts. Nothing else touches these keys.

Two consequences:

1. **The same proof makes other rereads redundant.** These can all go, so one proof covers every path:
   - `#isCurrentPending` (`:447`, `:468`, `:473`, `:774-785`)
   - the post-read `cursor.pending || cursor.halted` recheck (`:386-390`)
   - the fan-out `admittedThrough` recheck (`:599-602`)
   - the per-wave cursor re-read
   - the terminal `reported` refind (`:560-567`)
2. **The fence proves no clobber, not that the runner is on core's current resume.** If `#subscriptionDelivery.onCommit` (DO `:577`) throws, the durable reconcile is skipped until the next push or revive. `staleResume` is the only thing covering that window. Delete it only after the durable reconcile runs first, or is isolated from other effects' failures.

## Proven code defects

**1. (P1, affects soak) A request-initiated cold start drops other rows' recovery.**

- **Mechanism:**
  - After an eviction or deploy, the first request commits `itx/woken`. Every wildcard durable row consumes that event, and any other consumed event has the same effect.
  - `#pushDurableSubscriptionDelivery` overwrites `durable-delivery-wake-at` with now+20s (DO `:943-944`) and drives only the relevant rows (`durable-subscription-delivery.ts:77-83`).
  - When those drains settle, `#runDurableDelivery` writes `deadline` (DO `:545-546`). That value only knows rows driven in this incarnation, so it is null: the key is deleted and `AlarmCoordinator.reconcile` removes the alarm.
- **Effect:**
  - Any other row stalls: one with a persisted backoff (up to 4 h), an attempt interrupted by the reset, or dead letters still to report.
  - It restarts only when it consumes a new event, a configuration changes, or an unrelated alarm pass calls `revive()`. A deploy during soak with a webhook call in flight reproduces this.
- **Unit repro:**
  1. Row A with no `consumes` and row B with `["work"]`.
  2. B's cursor has `pending.nextAttemptAtMs = now + 60_000`.
  3. On a fresh helper, call `push(rows, [durable woken], false)` and await the runs.
  4. `deadline` is `null`; it should be B's time.
- **Fix:**
  - In `push`, also drive every non-halted runner that `#reconcile` just constructed. This adds no state and keeps "no wake reconstruction".
  - The push pre-arm at DO `:943-944` then becomes redundant, because every due path reaches `#runDurableDelivery` synchronously. Delete it.

**2. (P2) Fan-out rows are driven by ephemerals they never receive.**

- **Cause:** Relevance in `push` uses `consumesEvent` (`:77-78`), and the DO's ephemeral clause (`:945-952`) doesn't exclude `ordered === false`.
- **Effect:**
  - A fan-out row that names an ephemeral type runs a full drain on every such commit: a recovery-key put and delete, a source read, and the write from defect 3.
  - `#again` then triggers an alarm pass that revives every row, so an ephemeral flood becomes a write-and-alarm loop.
- **Fix:** Exclude fan-out rows from ephemeral relevance in both places.

**3. (P2) Fan-out admission rewrites the whole cursor even when nothing was admitted.**

- **Cause:** The put at `durable-delivery.ts:603-611` is unconditional, and every alarm pass revives every row (DO `:2080`).
- **Effect:** A fan-out cursor with up to 1,000 items (about 1 MiB with 1 KiB errors) is rewritten on every pass, including passes for schedules, facet claims and other rows' retries.
- **Fix:** Skip the put when there are no additions and `scannedThroughOffset === admittedThrough`.

**4. (P2) Dead letters are reported one per alarm pass, and they block the row.**

- **Cause:** `#drainFanOut` reports one terminal item, calls `scheduleWake(Date.now())` and returns (`:549-575`). While any terminal item remains, the row neither admits nor delivers.
- **Effect:** With a target that fails every event, each dead letter costs a full alarm pass: two alarm-trace ephemerals, a revive of every row, and recovery-key writes.
- **Fix:** Report all terminal items in one loop, or better, apply deletion A below.

**5. (P3) Resume keeps stale ephemeral descriptors.**

- **Cause:** `resume()` doesn't clear `#ephemeralQueue`, although `halt` and `dispose` do.
- **Effect:** The old descriptors hit the native fence (DO `:1236-1239`) and are logged as `durable-delivery.ephemeral-failed … older resume`, which is unexplained warning noise.
- **Fix:** Call `#discardEphemerals()` in `resume`.

**6. (P3) Halt receipts often lose their cause.**

- **Cause:** The receipt looks up its source at `afterOffset + 1` (DO `:1273-1279`). For an ordered range that is often an unconsumed event; for a fan-out halt it is `admittedThrough + 1`, usually beyond head.
- **Effect:** The receipt starts a new cause chain instead of continuing the source's.
- **Fix:** Pass the first selected offset.

## Operational risks

- **Preview contexts from earlier builds of this branch are refused.** Any such context that had durable rows or the old subscriptions facet refuses every entry point, `rulesSnapshot` included. A refused project root breaks the whole project. Use fresh projects, or watch for the `iterate-context.removed-private-subscription-cursor` issue.
- **Extra alarm passes will show in log comparisons.** Every alarm pass revives every row, and a drain still running gets `#again`, which adds another pass. Expect more alarm-trace volume in the same-window Workers Logs comparison.
- **Ephemeral-only ordered drains still write storage.** Each idle-to-busy drain costs a recovery-key put and delete (two KV writes).
- **A hung raw call can cost other rows attempts.** A call older than 20 s that is still holding the body budget turns other rows' busy results into spent attempts. This is documented.
- **One event can halt a fan-out row.** A receiver's `FORBIDDEN`, `GONE` or `NOT_A_METHOD` for a single event halts the whole fan-out row.
- **Transient faults won't halt during a 100-run soak.** 25 attempts with a 4 h cap is about 45 h before a halt. So a stuck row looks like a long backoff; triage it together with defect 1.

## Real deletions and what each one relaxes

**A. Append the receipt in the same turn; make the core row the only halt state.**

- **Why it works:** In the context, `terminal` is already synchronous: `#recordConfiguredSubscriptionTerminal` has no await.
- **How:**
  - Append the receipt first, then write the outcome.
  - A row halt's own `onCommit` reconcile already runs `halt()`.
  - Have the failed-receipt append check for an existing key first, as `Stream.recordLoopLimit` does, so a reset between the two writes can't cause `IDEMPOTENCY_CONFLICT`.
- **Deletes:**
  - `FanOutPending.terminal` and the cursor's `halted` object (including `terminalReported`)
  - the terminal-report pass and `#reportHalted`'s retry and wake
  - `halt()`'s five-field comparison
  - the `snapshot.halted` fallback in `#subscriptionList`
  - defect 4 entirely
- **Relaxation:** The published `DurableDeliveryRuntime.terminal` must be synchronous and use the same store as the cursor.

**B. Use the generation proof everywhere.** Delete the rereads listed in the verdict. Delete `staleResume` and its `GONE` data only after the ordering change described there.

**C. Stop persisting each attempt's error.** Receipts carry the final attempt's error. This cuts the worst-case fan-out cursor by roughly 10× and shrinks every wave write.

- **Relaxation:** When the final attempt was interrupted by a reset, the receipt says "did not settle before its host restarted" instead of showing the previous error.

**D. Use `confirmedOffset` as fan-out's admission mark.** This deletes `fanOut.admittedThrough`, the wrapper object and five fallback constructions. Relaxation: a breaking cursor shape, which is only a concern on this branch.

**E. Delete the migration refusal.** That is the `durable-delivery-owner` marker, the facet-key probes and `#durableDeliveryMigrationRefusal`.

- **Why:** Main's rows lack `delivery`, so `Stream.reconstructionRefusal` already refuses them.
- **Relaxation:** Only intermediate preview contexts would replay from their configured offset instead of being refused. This needs your approval.

**F. Remove the standalone SDK defaults, if the context is the only host.**

- **Deletes:**
  - `maxAttempts ?? 15`
  - both copies of the 30-minute retry ladder (`:504`, `:728`)
  - the no-op `error.slice(0, 1024)` at `durable-subscription-delivery.ts:165`

With A–D, runner state is just `{confirmedOffset, resumeAtOffset?}` plus either one ordered range or a list of fan-out items `{offset, attempt, nextAttemptAtMs}`. That deletes the receipt-pending state that drove round 13's D1, D2 and D6.

These are real reductions, but they won't move the combined line count much. The large remaining lever is the relaxation you already named: consumer-owned forwarding. That needs a product decision.

## Checked and not defects

- The halt reentrancy inside the wave (receipt, then reconcile, then `halt()`) is fenced, and `terminalReported` still lands.
- A reset between a fan-out receipt and its removal replays the same key and payload, so the append is a harmless echo.
- The UTF-8 error codec gives the same result on repeated use, and `halt()`'s early return stays stable.
- The worst-case cursor, about 1.1 MB, is under the 2 MB cell limit.
- The bounded reread returns exactly the admitted rows.
- `withTimeout` clears its timer.
- The owner marker is written before the first birth commit.
- A skipped resume reconcile heals on the next reconcile.
