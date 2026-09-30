# Review 12: context-owned `DurableSubscriptionDelivery` (24f762f6b)

**Verdict.** Moving ownership into the context is simpler, and the ownership model is correct. The log, target authority, cursors and the one alarm now sit in one Durable Object. One nice consequence: a halted cursor and its `subscription-delivery-halted` append now land in the same synchronous turn. The runner calls `terminal` with no await in between (`durable-delivery.ts:448-455` → `iterate-context-durable-object.ts:1218-1257`), so they commit atomically, which the facet bridge never managed.

The experiment isn't correct yet, though. Removing the facet also removed two durable guarantees that the SDK engine's claim path gave the facet: a persisted recovery claim, and a bound on how often in-flight work can die (`processor.ts:17-23`, `MAX_DEATHS`). It also added a new alarm write during birth. Below are five source defects, then load and cost risks, then cuts and probes.

---

## A. Manager and wiring defects (actual source, ranked)

### A1. Recovery between commit and admission no longer survives a restart

- In the draft, `drive(runInBackground)` ran on the facet engine's claim path. That path wrote a persisted `facet-claim:subscriptions` row, which is due at birth for first-party facets (`facet-host.ts:336-344`).
- Now the only recovery source is `#durableDeliveryRecoveryAt`, which lives in memory. It is set in `#pushDurableSubscriptionDelivery` (`:913-915`) and `#runDurableDelivery` (`:550-563`), and only counted while `#durableDeliveryInFlight > 0` (`:1751`).
- **Failure case.** A durable event commits, and the incarnation dies before the runner persists `pending`. That window includes the whole time a durable wake is parked behind `#again` while `#drainEphemerals` delivers a queue of ephemerals, each allowed up to 20 s.
- The stored alarm still fires at commit + 20 s. But the fresh incarnation's `sync()` finds no `pending`, so no cold recovery is set. `deliveryRecovery` is false because `inFlight === 0`, and `alarm()` takes the sweep-only branch (`:1937-1944`).
- Result: the event stays undelivered until the next matching commit or some unrelated full pass.
- **Fix (about 10 lines, same shape as `BackgroundClaims.started/settled`):**
  - In `#runDurableDelivery`, `put("durable-delivery-recovery", true)` when in-flight goes 0→1. This happens in the commit's own turn, so it commits with the event.
  - Delete the row when in-flight returns to 0.
  - At birth, if the row exists, set `#durableDeliveryRecoveryAt = Date.now()`, and make the deadline source `this.#durableDeliveryRecoveryAt` unconditionally.
  - Also delete the row when `revive()` finds no row left to drive.
  - Write cost matches the draft's claim put/delete.

### A2. Retries are unbounded when a delivery kills the context isolate

- Attempts are counted before the call (`durable-delivery.ts:404-413`, fan-out `:629-633`). The `maxAttempts` check only runs in the `catch` (`:441`, `:674`).
- In the draft, a context crash during the raw call looked to the facet like a failed bridge call, and the engine's `MAX_DEATHS` bounded revives. Now the runner shares the isolate with the raw call. An OOM, CPU-limit reset or deploy reset means the `catch` never runs.
- The persisted in-flight deadline (`now + callDeadlineMs`) wakes the next incarnation, which increments to 26, 27, and so on, about every 20 s, forever. Each cycle resets the whole context.
- This breaks the bounded-retries requirement.
- **Fix:** before incrementing, if `pending.attempt >= maxAttempts`, take the existing halt path with `pending.error ?? "delivery did not settle before its host restarted"`. For fan-out, the same check sets `terminal = true`. About 6 SDK lines, separate from D1/D2.

### A3. `sync()` writes the alarm during construction

- `#restoreWakes` always calls `wakesChanged()` (`durable-subscription-delivery.ts:190`), so the constructor's `sync()` (`:427`) reconciles the alarm before the guarded `rearmIfOverdue` runs (`:437`). Two effects:
- **Alarm-woken incarnations.**
  - `getAlarm()` returns null while an alarm is firing, so any non-null wanted time triggers `setAlarm`. The usual triggers are first-party claims made due at birth (`bornAt`) or a cold-recovery `Date.now()`.
  - When the pass then finds nothing else owed, its closing `reconcile()` sees `null === null` and writes nothing. The alarm the constructor wrote survives and fires an extra empty pass.
  - This contradicts the `alarm()` contract: "no alarm and no alarm write at all".
- **Contexts reached by id alone (the context sweep's `identity`/`readForSweep`).**
  - A first-party claim, such as `repo` or `workspace` in an orphaned child, brings the alarm forward to now.
  - The orphan then wakes and runs `#announceToAncestors`, which is exactly what the `ctx.id.name` guard exists to prevent.
- **Fix:** delete line 190. Every caller that matters already reconciles:
  - `onCommit` (after `push` and the no-rows `sync`),
  - the end of the pass (after `revive`),
  - runner `scheduleWake`,
  - and `rearmIfOverdue` for named births, which now reads a populated `deadline`.

### A4. Fan-out cold recovery waits behind the latest backoff

- In `#restoreWakes` (`:186-188`), a defined fan-out `nextAttemptAtMs` wins over `#coldRecovery`.
- So a fan-out row with one item in webhook backoff (retry cap 4 h) plus admitted items that were never attempted wakes only at the backoff time.
- **Fix:** test `#coldRecovery.has(key)` first.

### A5. The migration marker misses idle draft datasets, and the refusal writes before any facet start

- `startFacetsTheLastIncarnationRan` deletes every `facet-ran:<name>` after a successful birth start unless a claim exists (`facet-host.ts:498-501`).
- So a draft context shows `facet-ran:subscriptions` only if its private facet was called since that context's latest birth, or holds a claim.
- **Gap.** Take a draft context whose durable row filters out `itx/woken` and whose last incarnation served only unrelated calls. It has no marker. The new runner then starts at `row.afterOffset ?? configuredAtOffset` and silently replays webhooks. That is exactly what Core19 meant to refuse.
- I can't see the draft, so this holds unless the draft called the facet in every incarnation.
- **Fix (one clause):** keep the current condition, then also refuse when there is no `durable-delivery-owner` and any of these holds: `facet-claim:subscriptions` exists, or any `coreReducedState.subscriptions` row has `delivery === "durable"`.
  - Core19 reconstruction already refuses every older subscription shape, and every experiment context writes the owner marker at birth, so an ownerless durable row can only be a draft dataset.
- **Write before start.** The refusal branch calls `deleteAlarm()` (`:411`) before any facet start. The draft's facet class no longer exists, so it can never be started, and this write is exactly what the facet-storage reset defect (`FACET_START_WATCHDOG_MS`) needs.
  - Drop it. `alarm()` already returns early (`:1921`), and a completed handler spends the alarm anyway.
  - `destroy()`'s `deleteAll` becomes the first write, and needs a probe (P5).
- **Owner marker cost.** The owner `put` (`:423`) runs on every incarnation. Make it `if (!get) put`.
  - This doesn't open any new storage path for unborn contexts: `countIncarnation` already writes per incarnation.

---

## B. Load and cost amplification (real, cheap to cut)

### B1. Every due commit re-derives all rows about three times and drives every durable row

- For each commit, `#durableSubscriptionRows()` runs in the DO, again in `#reconcile`, and again in `push`. Each run calls `targetIsWebhook` → `resolveThroughState`.
- `#restoreWakes` then structured-clones every cursor. For fan-out that can be up to 1,000 pending items.
- `push` drives all non-halted rows, even rows none of the events concern (`:88-93`). Each drive reads a page (parsing bodies), writes an advanced `confirmedOffset`, and reconciles the alarm when it goes idle. So each due commit costs one KV write plus two reads per row.
- The same per-commit derivation happens on every ephemeral commit that a durable row consumes. That is a streaming-token flood path, and it runs synchronously inside `Stream.append` for the caller.
- **Cuts:**
  - Memoize rows on the identity of `coreReducedState.subscriptions` and `itxExpressionRewriteRules` (both copy-on-change).
  - Skip `#reconcile` in `push` when that identity hasn't changed.
  - Drive only rows with `consumesEvent(row.consumes, e)` for some event, or whose configure/resume is in the batch. The lag gets scanned once at the next match, in 100-event pages.
- **Side effect of the per-push `#restoreWakes`:** it overwrites wakes the runner scheduled but that aren't in the cursor (read-failure and halted-report retries at +1 s). Reconciling only on row change or revive fixes this.

### B2. Budget exhaustion is detected only after the read

- The budget check comes after `readForDurableDelivery` and `JSON.stringify(events)` (`:990`, `:1097`). Every retry while the body budget is exhausted (flagged `deliveryBusy`, so retried every 1 s and not counted) re-parses and re-stringifies up to an 8 MiB page.
- **Cheap guard:** throw busy before reading when `#configuredSubscriptionDeliveryBodyChars >= budget`. This fits your planned blocker-then-counted-UNAVAILABLE change.

### B3. Ephemeral re-validation reads a durable body

- `#ephemeralSubscriptionDeliveryEvent` calls `read(offset - 1, 1, { includeEphemeral: true })`, which parses the next durable row (up to 8 MiB) and then runs `jsonEqual` over the body.
- In process, the runner holds the same object as the ring (`onCommit` passes `committedEvent` by reference). Your offset-only queue should look up the ring directly: add a `Stream` accessor by offset and compare with `===`.
- The order cut should also re-check for newly admitted durable ranges between ephemerals, so that a slow ephemeral queue can't hold a durable wake behind `#again` (the A1 window).

---

## C. Checked and sound

- **Birth order:** the owner marker, `sync()` pruning/resume puts and cursor writes all come after `resetUnclaimedFacetsAtBirth` (apart from A5's refusal branch).
- **Generation fences:** every `#putCursor` after an await is behind `#isCurrent` / `#isCurrentPending`. Disposal on row replacement bumps the generation, so late raw results can't write. `halt()` from a nested terminal commit correctly invalidates the in-flight chain and sets `terminalReported`. The one-time orphan sweep and `durable-delivery-resumed/` apply-once are correct. Keys can't collide because names exclude `@`.
- **Resume clamp:** `Math.min(resumedAfterOffset, currentHead())` is applied once.
  - Not re-reported as new; please confirm D1/D2 cover it: an ordered resume of a non-halted row with no `afterOffset` returns before updating `#resumeAtOffset`, and fan-out ignores `afterOffset` once a `fanOut` cursor exists. Either would wedge the row in a 1 s stale-resume loop after the resumed marker is written.
- **Body reservation:** reserved synchronously before the first await, and released in `finally` only after the raw call settles. `admittedAlone` still keeps the 32 MiB RPC guard.
- **Target authority:** each attempt re-proves row identity, resume generation, halted state, filter and selected offsets from the log. The row is re-checked after hashing and after target evaluation, and target evaluation runs under the kernel caller. There is no longer an untrusted runner to validate against.
- **Cold `pending`:** a persisted in-flight attempt wakes at its own deadline, and an admitted page that was never attempted wakes immediately (ordered). Queued ephemerals are lost on restart, which is best effort as designed.

---

## D. Facet invocation budget concentration: actual failure vs needs a probe

In the draft, every `read`/`deliver`/`terminal` was a new inbound bridge request to the context. Each one got its own subrequest budget and CPU reset, and held the context resident. Now all of that runs in the invocation context that first scheduled the drain. `#again` re-drains chain inside the previous work's `finally` (`durable-delivery.ts:335-338`), and fan-out catch-up recurses until it reaches the head (`:608-619`).

**Actual (from source):**

- **A2:** retries are now unbounded when a delivery kills the context isolate, because the runner shares the isolate with the raw call and the facet boundary plus `MAX_DEATHS` are gone.
- **A1:** the recovery claim is no longer persisted.
- **Stuck pins:** a raw call that never settles now holds a Residency pin call indefinitely. That blocks the pins' release (borrowed stubs, library sockets) and keeps deferring the unclaimed-facet sweep. Before, an inbound bridge call held the actor instead. The body reservation must stay held; the pin probably shouldn't outlive your planned blocker cutoff.

**Needs a probe:**

- **Subrequest count:** one invocation's budget now covers a whole catch-up. A 12k-event fan-out webhook backlog is about 12k fetches in one invocation.
- **CPU:** there is no per-call CPU reset during an alarm-driven catch-up with no inbound traffic (parse, stringify ×2, sha256 per fan-out event).
- **Residency:** once the runner's 20 s timer ends, whether the actor stays resident with no inbound call.
- **Isolate memory:** a combined worst case of an 8 MiB ephemeral budget, 8 MiB of target bodies (up to 32 MiB admitted alone), 8 MiB of read scratch, the 1 MiB ring and stringify copies.
- **Subrequest depth:** likely improved (+0 vs the bridge's +2); no probe needed.

---

## E. Smallest source cuts

1. Drop `wakesChanged()` from `#restoreWakes` (A3).
2. Make the `maxAttempts` check before each call (A2).
3. Swap cold-recovery precedence (A4).
4. Add the `revive()`-time row check and the persisted recovery row (A1).
5. Extend the marker, drop the refusal's `deleteAlarm`, and guard the owner put (A5).
6. `FacetHost.deleteFirstPartyFacet` (`facet-host.ts:458-464`, "a platform coordinator… cursor storage") has no caller in the files I read. Delete it if it's unused elsewhere.
7. Pass `row` straight to the DO callbacks. That removes `DeliveryIdentity`, the `SubscriptionDeliveryBridgeRequest`/`…Terminal` types and four wrapper lambdas (`:147-158`, `:517-545`); `#configuredSubscriptionRow` stays as the fence.
8. The inline snapshot type in `#subscriptionList` (`:1852-1859`) can use `DurableDeliveryCursor`.
9. `subscriptionDeliveryStatus` calls `snapshots()`, which runs `#reconcile` and can write. Map the existing runners read-only instead.
10. The SDK header and comments still describe "the private subscriptions facet", "facet memory" and "facet invocation" (`durable-delivery.ts:1-3`, `:61`, `:105-106`, `:223-230`). Fix them before merge.
11. Separately, the webhook policy (`maxAttempts` 25, 4 h cap) is fixed when the runner is created. A rule change that makes a row a webhook takes effect only in the next incarnation. Accept this or rebuild the runner when `targetIsWebhook` flips.

---

## F. Conditions before merge

- Fix A1–A5.
- Cherry-pick D1/D2 and confirm they cover the two resume wedges in §C.
- Keep the TTL cache until the planned in-flight join lands. Don't mix that change into these fixes.
- Pass these probes on real Workers.

**Meaningful Worker probes:**

| #   | Setup                                                                                                                          | Pass condition                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| P1  | Commit a durable webhook-consumed event, then reset the actor before admission (also with a slow ephemeral queue ahead of it). | Delivered with no further commit. Fails today.                                                         |
| P2  | A target that drives the context to a memory or CPU reset during the raw call.                                                 | Halts at `maxAttempts`, with a terminal fact. Fails today.                                             |
| P3  | Alarm-woken incarnation with a first-party claim and a cold cursor.                                                            | Alarm traces show no extra empty pass.                                                                 |
|     | `readForSweep` by id on an orphan holding a `repo` claim.                                                                      | `getAlarm()` unchanged; no `child-created` appended.                                                   |
| P4  | Fan-out cold start with one item in 4 h backoff and unattempted items.                                                         | The unattempted items are delivered within seconds.                                                    |
| P5  | Draft-era context with an idle filtered durable row whose last incarnation never touched the facet.                            | Refused.                                                                                               |
|     | Refused draft context: `destroy()`.                                                                                            | Succeeds without a storage reset.                                                                      |
|     | Accepted draft context with no durable rows.                                                                                   | First birth is clean.                                                                                  |
| P6  | Alarm-driven 12k-event fan-out backlog, no inbound traffic.                                                                    | Count subrequest-limit errors, CPU resets and attempts burned; compare against the draft.              |
| P7  | 45 s target driven from the alarm, no inbound calls.                                                                           | Actor stays resident; exactly one raw invocation; body reservation and pins released after it settles. |
| P8  | Hung target holding an 8 MiB page, plus an ephemeral flood filling the 8 MiB budget, plus a full ring.                         | No isolate reset.                                                                                      |
| P9  | 200/s ephemeral flood with 10 durable rows, one consuming the flood.                                                           | Report append latency, CPU per commit and KV writes per commit, before and after the B1 cuts.          |

A refused project root also refuses `rulesSnapshot`, so it blocks every child that resolves through it. The operator runbook should recreate roots first.
