---
state: todo
priority: high
size: large
tags: [streams, os, review, performance]
---

# Streams deep review 2026-07-09: bugs, performance, abstractions (findings only)

Three independent deep-review agents examined the streams system right after
PR #1784 (unified stream subscribers) merged and shipped to a reset prd. This
document is FINDINGS ONLY — no fixes are attached; each item carries a fix
sketch and enough detail to become its own PR. The three full reports are
appended verbatim below the synthesis.

Context for calibration: prd itself is healthy — three codex gpt-5.5 smoke
agents ran the full charter matrix (streams core, cross-post/spine, agents on
the wake lanes) against the fresh deployment the same day with ZERO anomalies,
and the wire tests measure p50 1.8ms append→delivered with zero
subscriber-originated frames. Everything below is latent, not burning.

## Act on these first (corroborated or high-severity)

1. **Parked subscriptions hot-loop the DO alarm forever** (bugs HIGH-1).
   `#park` never clears the row's `next_attempt_at`, and `onAlarm` re-arms
   from `minNextAttemptAt()` — which still sees the parked row's
   past timestamp. One parked subscription = the stream Durable Object
   re-fires its alarm in a tight loop indefinitely: never hibernates,
   unbounded invocations, real duration cost (the exact incident class from
   the 2026-06 DO-duration spike). Fix sketch: clear `next_attempt_at` (and
   `attempt`?) when appending the parked fact, and make `#armAlarmFromStore`
   skip rows whose key is parked in folded state.

2. **Wake-lane delivery failures never back off** (bugs HIGH-2). A durable
   sink delivery rejection closes the connection (`delivery-failed`) → the
   close's `wake()` re-pokes immediately → poke succeeds → `ack` resets
   `attempt` → next batch fails again. A DETERMINISTIC subscriber failure
   (host processor whose ingest throws on one event) spins
   poke→deliver→close at RPC round-trip rate, appending two presence facts
   per cycle, forever. The README promises "sustained failure parks" on this
   lane; no test pins the path. Fix sketch: route `onDurableDeliveryError`
   through `#onDeliveryFailure` (nack/backoff on the watermark row) instead
   of bare close-and-re-reconcile; only a poke that DELIVERS a batch
   successfully should reset the attempt counter.

3. **Core-state rebuild reads the whole log into memory** (bugs MED-5 ==
   perf 9 — found independently by both reviewers).
   `#recoverCoreProcessorStateFromEventLog` does one unbounded
   `getRange(...).toArray()`. A version-bump wake (exactly what v11 shipping
   does to every existing stream) on a large capture/voice stream can OOM
   the DO **in its constructor** — a bricked stream that re-OOMs on every
   wake. Fix sketch: page the replay at 500 rows like every other read path.

4. **Selector-condition error facts can self-feed** (bugs MED-HIGH-3). A
   push subscription with a condition-only selector whose JSONata throws on
   `error-occurred` events reads its own per-offset error facts and appends
   one more per fact read — unbounded log growth that even the pause door
   cannot stop (`error-occurred` is allowlisted through it). Fix sketch:
   never append selector-error facts FOR error-occurred events (or exclude
   stream/\* control events from condition evaluation entirely).

5. **Push batches leak core state to userspace** (abstractions 9 — a leak,
   not just a wart). `StreamPushEventBatch.state` ships the full folded core
   state — other subscriptions' delivery expressions, park errors, presence
   roster — into the project worker's `processEventBatch`, while the webhook
   envelope deliberately strips state as internal. Fix sketch: drop `state`
   from the push envelope (breaking template change) or project it to a
   public subset.

## Bugs (remaining)

6. **`ack` is an unfenced monotonic max** (MED-4): a seek (`cursor-set`,
   resume-with-offset, replacement `deliver`, remove+recreate) landing while
   a push/webhook delivery is in flight gets clobbered by that delivery's
   ack; the remove+recreate variant permanently skips the promised
   `deliver: "all"` history. Fix sketch: fence acks on a row generation
   (bump on seek/recreate), mirroring the poke's config-offset fence.
7. **Idle-teardown watermark over-ack** (LOW-6): teardown acks to
   post-close maxOffset even when the sink was wedged mid-batch — that
   batch is stranded until the next append re-pokes (at-least-once still
   holds via the subscriber checkpoint; latency-only).
8. **`#armAlarmNoLaterThan` get/set race** (LOW-7): two concurrent arms can
   keep the later timestamp; bounded by the next wake, worst case one
   backoff period late.
9. **Unvalidated client offsets** (LOW-8): `replayAfterOffset` / wake
   `checkpointOffset` accept NaN/negative; NaN binds NULL in SQLite and
   produces live-looking subscriptions that deliver nothing. Fix: integer
   > = 0 guards at the RPC edge.

## Performance (ranked by estimated impact at the 1000 events/sec design point)

10. **Per-call Zod schema construction on three hot paths** (perf 1):
    `StreamAppendInput.strict()` is BUILT per appended event
    (measured 19.8µs vs 0.4µs hoisted, ~50×), same pattern in
    `makeContractEventParser` and `StreamProcessor#reduceRawEvent`. Hoist or
    memoize — the single cheapest big win, entirely inside the synchronous
    append turn.
11. **Every event re-read from SQLite and re-parsed per delivery lane, then
    re-stringified for the byte cap** (perf 2): live-tail fast path (hand
    the append's own parsed events to the pumps) + byte accounting from
    stored chunk sizes.
12. **KV core-state checkpoint written twice per append** (perf 3): the full
    state is V8-serialized on every append AND `stateVersion` is re-put;
    debounce the checkpoint (catch-up replay already tolerates lag) and
    write the version once.
13. **`#reconcileDurable` issues two no-op SQL statements per subscription
    per append** (perf 4): in-memory write-through mirror of cursor rows.
14. **Loopback authority root minted per push delivery** (perf 5): one
    awaited RPC round trip + target-graph build (~0.1-0.3ms) per delivery;
    caching is safe for push/webhook (trusted-internal, project-fixed
    authority; dispose-and-remint on failure) — the wake lane's parked chain
    is the in-tree precedent.
15. **Full core state serialized into every live batch** (perf 6): 4-8MB/s
    redundant at voice rates; a `state: false` subscription opt-out mirrors
    the existing `events: false`. (Pairs with finding 5.)
16. Minor: AUTOINCREMENT + FK overhead in the commit turn (perf 7), JSONata
    cache wholesale `clear()` at 200 entries + per-batch selector recompile
    (perf 8), idle-timer setTimeout churn per append, `runtimeState()`
    assembly cost on big streams (perf 10).

## Abstractions / dead code (ranked by LOC-deleted-per-risk)

17. **`processorsBySlug` is a dead registry** — folded on every connect,
    read by nothing. Delete (~30 LOC + state-version bump).
18. **`stream/metadata-updated` + core `metadata` are dead** — no appender,
    no reader. Delete from the public event catalog (~15 LOC).
19. **Type twins**: `ProcessorSnapshot`/`StreamProcessorSnapshot`,
    `ProcessorRuntimeState`/`StreamProcessorRuntimeState` — identical shapes
    kept in lockstep by accident; unify (~15 LOC).
20. **Two single-use generics both named `latestConfiguredEvent`** (contract
    - DO) — vestiges of the deleted rules record; inline (~25 LOC).
21. **The webhook branch inside `#drainPush` collapses** if webhook pins the
    read limit to 1 — per-event ack, bisect-moot, and deliveryId fall out of
    the ordinary path (~30 LOC; moderate risk: per-event reads on backlog).
22. **Seek is spelled three ways** (`deliver` on replacement,
    `subscription-cursor-set`, `subscription-resumed{afterOffset}`);
    `resumed{afterOffset}` subsumes `cursor-set` exactly — delete one verb
    (~30 LOC; audit-log naming judgment call).
23. **`LiveStreamSubscriberDescriptor`** carries the live capability inside
    the descriptor on one lane and as a sibling on the other; make it a
    sibling everywhere, delete the type (~20 LOC).
24. **Write-only `incarnationId`** on subscriber descriptors + docstring
    promising reconcilers that do not exist (~12 LOC or fix the doc).
25. **"Transport-free and clock-free" is overstated** — `Math.random()`
    (jitter) and `new Date()` (metrics) bypass the hooks; add ports or
    soften the claim.
26. **Micro-cruft batch** (~35 LOC, zero risk): dangling/doubled docstrings
    (itx/utils.ts, stream-durable-object.ts:76), `appendToStreamPath` public
    with no external callers, `ingest`'s inline restatement of
    `StreamPushEventBatch`, initial-cursor policy spelled twice,
    `StreamWebhookDelivery.projectId` dishonestly `| null`, and optionally
    rejecting `deliver`/`onPoison` on wake configs at append time.

## Steelman-survivors (explicitly NOT findings)

The reviews deliberately tried to kill these and failed: the
`StreamSubscribersHooks` ports seam (earns its keep — the whole spine unit
suite runs in plain node), `SubscriberDial`'s shape, `processorSlug` as an
explicit wake field, the receiver-owned `params` bag, webhook as a third
mode (delivery unit + transport genuinely differ), and the single-use
retention helpers in the RPC quarantine.

---

# Appendix A — full bugs report

# Deep review: streams system — real bugs

Scope: `apps/os/src/domains/streams/**`, `src/itx/expression.ts`, streams parts of `src/rpc-targets.ts`, `src/domains/itx/itx-entrypoint.ts` (branch molten-spine == main post #1784). All paths below are under `/Users/jonastemplestein/.superset/worktrees/iterate/spiritual-hoof/apps/os/`.

Every finding below was traced line-by-line and checked against the unit tests (`stream-subscribers.test.ts`, `stream-subscribers.teardown.test.ts`) — none of these is pinned as intended behavior; two of them directly contradict documented intent (README / host docstrings).

---

## HIGH-1: Alarm re-arm arithmetic spins the DO alarm — permanently for every parked subscription, transiently during every in-flight retry

**Files:**

- `src/domains/streams/stream-subscribers.ts:672-696` (`#park` — never clears the row's backoff)
- `src/domains/streams/stream-subscribers.ts:241-244` (`onAlarm` → `wake(); #armAlarmFromStore();`)
- `src/domains/streams/stream-subscribers.ts:698-701` (`#armAlarmFromStore` — no parked / in-flight filter)
- `src/domains/streams/stream-storage.ts:296-305` (`minNextAttemptAt` — raw MIN over all rows)
- `src/domains/streams/stream-durable-object.ts:169-176` (`#armAlarmNoLaterThan` — a past `atMs` always wins because the fired alarm was consumed, `current === null`)

**The parked case (permanent hot loop).** `#park` appends the parked fact and clears the in-memory skip/bisect maps, but never touches the cursor row. Every park is preceded by a `#backoff` nack (the 14th failure's nack is what scheduled the alarm that drove the 15th, parking, attempt — same shape in the skip-mode park path), so at park time the row holds a `next_attempt_at` in the past. Nothing ever clears it: `ack`/`setCursor` only run on resume/reconfigure, and `#reconcileDurable` skips parked entries _before_ the backoff check.

Interleaving:

1. Push/webhook/wake subscription fails 15 times → `#park`. Row: `attempt=14`, `next_attempt_at = t₁₄` (past).
2. The parking attempt was alarm-driven → `onAlarm` runs → `wake()` (reconcile: `parkedAtOffset !== undefined` → `continue`, no dial) → `#armAlarmFromStore()` → `minNextAttemptAt()` returns `t₁₄` → `armAlarm(t₁₄)`.
3. In the DO, the fired alarm was consumed, so `getAlarm() === null` → `setAlarm(t₁₄)` — a past time — fires (effectively) immediately.
4. `alarm()` → `onAlarm()` → wake is a no-op (parked) → re-arm `t₁₄` → fire → … forever.

The stream DO never hibernates again and burns an unbounded stream of alarm invocations until someone appends `subscription-resumed` / `-removed` / a replacement config. Parking is the _expected_ outcome of ~3.5h of receiver outage (`MAX_DELIVERY_ATTEMPTS`), so this is a normal-operations path, not an exotic one.

**The in-flight case (transient spin, same root cause).** `onAlarm` calls `#armAlarmFromStore()` synchronously right after `wake()`. The drain/poke it just dispatched suspends at its first `await` _before_ nacking or acking, so the store still contains the just-due `next_attempt_at` (past). The alarm re-arms in the past and re-fires continuously — each fire a no-op wake (`#pushDrains`/`#pokesInFlight` guard) plus another past re-arm — until the attempt settles (up to `DELIVERY_TIMEOUT_MS = 60s` for a wedged receiver). Every alarm-driven retry of every backing-off subscription spins the alarm for the attempt's duration.

**Refutation attempted:** test d ("parks … then goes silent") only asserts no further _dial calls_ after park and never invokes `onAlarm` post-park; the harness records `armedAlarms` but asserts nothing about post-park arming. `driveUntilParked` stops the moment the park fact exists. Not pinned.

**Fix sketch:** (a) in `#park`, clear the row's failure state (`store.ack(key, row.ackedOffset)` keeps the cursor, clears attempt/backoff — the park fact already carries the error text); (b) make `#armAlarmFromStore` skip rows whose key is parked in `coreState()` or currently in `#pushDrains`/`#pokesInFlight`, or clamp `armAlarm` targets to `> now` only when the row is in flight. (a) alone kills the permanent loop; (b) kills the transient spin.

---

## HIGH-2: Wake-lane sink delivery failures bypass backoff/park entirely → infinite hot poke→deliver→close loop and unbounded log growth on any deterministic ingest failure

**Files:**

- `src/domains/streams/stream-subscribers.ts:879-887` (`onDurableDeliveryError` — the ONLY handling is `connection.close("delivery-failed")`)
- `src/domains/streams/stream-subscribers.ts:858-860` (close with `delivery-failed` → immediate `this.wake()`)
- `src/domains/streams/stream-subscribers.ts:396-399` (`#poke` success → `store.ack(key, checkpointOffset)` — resets `attempt` to 0 every cycle)
- `src/domains/streams/stream-processor-host.ts:212-222` (host sink returns the per-batch ingest promise; a throwing `reduce`/`processEventBatch`/`writeState` rejects it deterministically)

The documented contract — README (`src/domains/streams/README.md`, "the next **poke-with-backoff** replays from the host's checkpoint") and the host header docstring ("a rejected batch result closes the connection stream-side and the spine re-pokes **with backoff**; sustained failure **parks**") — is not implemented. `#onDeliveryFailure` (backoff → park) is reachable only from `#poke`'s catch and `#onPushFailure`. A _post-poke_ delivery failure never touches the row, and each successful poke's `ack` resets `attempt = 0`, so the park counter can never accumulate either.

Interleaving (a poison event for a wake-mode processor — e.g. an agent processor whose `reduce` throws on one committed event; `#reduceRawEvent` at `stream-processor.ts:493` does not catch subclass `reduce` throws):

1. Lag → `#poke` succeeds → `#open` → `ack(checkpoint)` (attempt=0) → pump delivers batch from `checkpoint+1` (contains the poison event).
2. Host `ingest` rejects → pulled result rejects → `onDeliveryError` → `onDurableDeliveryError` → `close("delivery-failed")`: appends a `subscriber-disconnected` fact, then `wake()`.
3. Reconcile: no connection, no poke in flight, `nextAttemptAt = null` (cleared by step 1's ack), watermark < maxOffset → **immediate** re-poke.
4. Host answers the _same_ checkpoint (ingest never committed) → same batch → same rejection → goto 2.

Each cycle takes ~one poke RTT + one batch RTT (tens of ms on loopback RPC) and appends **two events** (`subscriber-connected` + `subscriber-disconnected`), so the log grows unboundedly, both DOs stay pinned resident, and the subscription never backs off and never parks. The circuit breaker doesn't help: ~2 events per cycle at realistic cycle rates is far below the default refill (100k tokens/s). This is the agents' primary delivery lane.

**Refutation attempted:** no test exercises `onDurableDeliveryError` at all (both harnesses use sinks that never fail); test i only pins re-poke-on-new-lag. Transient failures recovering via immediate re-poke is fine — the hole is specifically that _nothing_ ever escalates, contradicting the stated design.

**Fix sketch:** in `onDurableDeliveryError`, before `close`, run the row through the failure machine (`#onDeliveryFailure`) — and make the counter survive poke success: either don't reset `attempt` in the post-open `ack` (use a cursor-only update there), or track consecutive `delivery-failed` closes per key (in-memory is acceptable; eviction resets to at-least-once) and route through backoff → `#park` at the same `MAX_DELIVERY_ATTEMPTS` threshold.

---

## MEDIUM-HIGH-3: Selector-condition error facts are self-feeding — a condition that throws on `error-occurred` events produces an unbounded append loop the pause gate cannot stop

**Files:**

- `src/domains/streams/stream-subscribers.ts:439-440, 562-584` (`#drainPush` → `#applySelector` — one new `error-occurred` fact per failing offset, appended to the same stream the drain reads)
- `src/domains/streams/stream-durable-object.ts:386-396` (pause door allowlists `error-occurred`, so even a paused/breaker-tripped stream keeps accepting these)

`#applySelector` records a durable `error-occurred` fact per event whose JSONata condition _throws_, keyed `selector-condition-failed:${key}:${event.offset}` — idempotent per offset, but every newly appended fact has a **new** offset. Those facts land on the same stream, the drain acks past the read window and loops, reads its own error facts, evaluates the same condition on them, throws again, and appends one new fact per fact read.

Interleaving (push/webhook subscription with a condition-only selector — no `eventTypes`, so the condition runs on every type — whose expression throws on the error-fact shape; e.g. `$number(payload.message) = 42` throws JSONata D3030 on any non-numeric string, and `error-occurred.payload.message` is always a prose string):

1. Events 1..N land; drain reads them; condition throws on some/all → facts appended at N+1..N+k; `matched=[]` (or delivered) → `ack(lastOffset)` → `continue`.
2. Next iteration reads offsets N+1..N+k (the spine's own error facts); condition throws on **each** (`payload.message` is prose) → k new facts appended → ack → continue.
3. Steady state: every iteration reads k facts and appends k facts. The loop never reaches the tail; `keepAlive` holds the DO awake; the log grows without bound.

The two guards that stop analogous loops don't apply here: the poison-skip lane parks after `MAX_CONSECUTIVE_SKIPS`, but condition-error skips increment nothing; and even if the circuit breaker tripped and paused the stream, `error-occurred` passes the pause door, so the loop continues while paused. Contrast: the eventTypes filter runs _before_ the condition (`event-selector.ts:89`), so a selector with `eventTypes` narrowing is safe — the bug needs a condition-only selector, which is a documented usage shape (the `EventSelector.condition` docstring's own example is condition-only).

**Refutation attempted:** the main suite's harness keeps `appendFact` output _out of the log_ — exactly the class of self-feeding bug the teardown-test header says that harness hides — and the teardown suite doesn't test selectors. Not pinned.

**Fix sketch:** never record a condition-error fact for events the spine itself appended (skip when `event.type === "events.iterate.com/stream/error-occurred"`, or when the offending event's idempotency key carries the spine's own prefixes); and/or count consecutive condition-error-only iterations per key toward the same consecutive-skip park that protects the poison lane.

---

## MEDIUM-4: Cursor seeks are silently clobbered by in-flight drain acks — `ack`'s monotonic-max has no fencing against `setCursor`

**Files:**

- `src/domains/streams/stream-storage.ts:259-266` (`ack` = `max(acked_offset, ?)`, unconditional)
- `src/domains/streams/stream-subscribers.ts:492, 496, 530` (drain acks after each awaited delivery)
- `src/domains/streams/stream-subscribers.ts:707-753` (`onSubscriptionConfigured` / `onCursorSet` / `onResumed` seeks via `setCursor`)

Any seek that lands while a push/webhook delivery is awaited is overwritten when that delivery's ack resolves, because `ack` takes `max` with no epoch/fence. The drain re-reads config and the row at the top of each _loop iteration_, but the ack for the in-flight batch lands regardless.

Interleaving A — audited redrive lost:

1. Push sub `k`, acked=0, events 1..100. Drain sends batch [1..100]; `await dial.push` in flight (any receiver latency; up to 60s).
2. Operator appends `subscription-cursor-set { afterOffset: 40 }` (the "audited form of replay"). `onCursorSet` → `setCursor(40)` → `wake()` → reconcile skips (`#pushDrains` has `k`).
3. In-flight push resolves → `ack(k, 100)` → `max(40, 100) = 100`. The seek is gone; the drain tails on. The audited fact says a replay happened; none did. On a busy stream a drain is almost always in flight, so the window is the common case, not the corner.

Interleaving B — real delivery hole on remove+recreate:

1. Sub `k` → receiver A, drain's batch [1..100] in flight.
2. `subscription-removed` for `k` (row deleted), immediately followed by `subscription-configured` for `k` → receiver B with `deliver: "all"` (`ensure(k, 0)` + `setCursor(0)`). Reconcile skips (drain slot held).
3. A's in-flight push resolves → `ack(k, 100)` → new row jumps 0 → 100. Receiver **B never receives offsets 1..100** — events skipped forever against the new config's explicit full-replay promise. (The old drain then continues under the new config: it re-reads `configuredSubscribersByKey[k]` each iteration and simply becomes B's drain, at the clobbered cursor.)

Same clobber applies to a replacement config's `deliver: {afterOffset}` seek (test l only covers the quiescent case). The webhook lane makes the window longer: its inner per-event loop never re-checks config/parked/removal between events (`stream-subscribers.ts:465-494`), so a removed/replaced webhook subscription keeps POSTing the rest of the batch — up to 99 further per-event deliveries to the _old_ URL — before the outer loop notices.

**Fix sketch:** add an `epoch` column to the cursor row; `setCursor` (and `ensure`-after-delete) increments it; the drain captures the epoch when it reads the row and `ack(key, offset, epoch)` becomes a no-op on mismatch (one `WHERE epoch = ?` clause). The webhook inner loop should additionally re-check `configuredSubscribersByKey[key]` identity (config offset) per event.

---

## MEDIUM-5: Core-state rebuild loads the entire event log into memory in one query — big streams brick their DO constructor on a version bump

**Files:**

- `src/domains/streams/stream-durable-object.ts:885-909` (`#catchUpCoreProcessorState` / `#recoverCoreProcessorStateFromEventLog` — one `getRange` call with `limit: highestOffset - maxOffset`)
- `src/domains/streams/stream-storage.ts:103-148` (`getRange` — single SQL cursor, `.toArray()` materializes every chunk row, then parses every event)

The incremental catch-up path is fine (KV is at most a few events behind). But the rebuild path — `CORE_STATE_VERSION` mismatch (10→11 just shipped) or missing KV — replays from offset 0 with **one** `getRange` whose `limit` is the whole log: every `event_chunks` row is materialized into a single JS array before any fold runs. Under the "capture everything verbatim, no edge filtering" doctrine, connection/capture streams grow to hundreds of MBs of event JSON; a DO has 128MB. The constructor OOMs (or blows CPU limits), which means **every** wake of that stream throws — the stream is bricked (appends, reads, deliveries all fail) until a code fix ships, since the failure is in the constructor itself.

**Refutation attempted:** replay-mode `#reduce` folding parse-poison as inert (the #1714 posture) protects against bad _rows_, not against the unpaged read; no cap exists on this internal `getRange` call (the 500 cap lives only in the public `getEvents`).

**Fix sketch:** page the rebuild — loop `getRange({ afterOffset: cursor, limit: 500 })` folding as it goes (the fold is already incremental; only the read is monolithic). ~5 lines in `#catchUpCoreProcessorState`.

---

## LOW-6: Idle teardown's watermark ack can strand events behind a wedged sink until the next append

**File:** `src/domains/streams/stream-subscribers.ts:967-987` (`runIdleTeardownNow` final `ack(key, maxOffset)`)

The teardown ack assumes "the pumps were long since drained, so maxOffset holds nothing the sink has not already seen". "Seen" means _delivered into the fire-and-forget sink_, not _ingested_: if the subscriber's ingest of the last batch is still unsettled >idleTeardownMs later (wedged host — the exact case `DELIVERY_TIMEOUT_MS` exists for on the dial side; batch results have no timeout), teardown disposes the sink before the rejection is observed, advances the watermark to maxOffset, and the rejection then no-ops (`onDurableDeliveryError` finds no connection). Result: the subscriber's checkpoint is behind, the watermark says caught-up, and nothing re-pokes until the next append or DO restart (whose `woken` fact creates lag). At-least-once is preserved _eventually_, but on a stream that goes quiet the redelivery is deferred indefinitely — a liveness hole, not a loss hole. Fix sketch: on teardown, ack to the connection's cursor only if no batch result is pending, or skip the ack for connections with unsettled deliveries (track a per-connection in-flight count).

## LOW-7: `#armAlarmNoLaterThan` get/set race can arm the later of two concurrent arms

**File:** `src/domains/streams/stream-durable-object.ts:169-176`

Two `armAlarm` calls in the same turn (e.g. two subscriptions backing off in one drain wave) both `await getAlarm()` → both observe `null` → the second `setAlarm` (later time) overwrites the first (earlier time). The earlier retry is delayed until the later alarm fires — self-healing (that alarm's `#armAlarmFromStore` re-arms correctly), worst case ~30min (backoff cap) of extra latency for one retry. Fix sketch: serialize arming through a single in-instance promise chain, or track the min requested time in memory and only write monotonically.

## LOW-8: Subscriber-supplied offsets are unvalidated (`replayAfterOffset`, wake `checkpointOffset`) → silently-dead subscriptions

**Files:** `src/domains/streams/stream-durable-object.ts:941-984` (`subscribe` passes `replayAfterOffset` through unchecked), `src/domains/streams/subscriber-sinks.ts:335-343` (`parseWakeHandshake` only checks `typeof === "number"` — NaN, negatives, floats pass)

A client `subscribe({ replayAfterOffset: NaN })` — or a wake expression pointed at _userspace_ code (e.g. `["worker", "someMethod"]`) returning `{ checkpointOffset: NaN, sink }` — flows into the pump cursor and `store.ack`. NaN binds as NULL in SQLite, so `offset > NULL` returns no rows: the connection looks live (`ping() === true`, presence fact on the roster) but delivers nothing, forever; the wake variant also corrupts the watermark row via `ack(key, NaN)`. Contrast `waitForEvent`, which validates `afterOffset`. Fix: `Number.isInteger(x) && x >= 0` at both boundaries; treat a bad wake checkpoint as a delivery failure (backoff → park).

---

## Design-hazard notes (not counted as bugs, flagged because the prompt asked)

- **A paused target stream parks every inbound cross-post within ~3.5h.** `#reconcileDurable` never checks `paused` (deliveries out of a paused stream continue — intended), but `Stream.ingest` on a paused _target_ throws for every copied event (`stream-durable-object.ts:386-396` — copied events are ordinary appends), so each source's push subscription runs the full backoff ladder and parks. Resuming the target does **not** resume them — each parked subscription needs a manual `subscription-resumed` on its _source_ stream. Combined with the breaker auto-pause, a runaway producer can convert one noisy stream into N parked cross-posts across the project. (Once HIGH-1 is fixed the parks at least stop costing alarms.)
- **`crossPostTo`'s `transform` is not validated at configure time** (`rpc-targets.ts:514-543`): an invalid JSONata string (or non-string) commits fine and only fails inside `buildIngestAppendInputs`'s `IngestParams.parse`/`compileJsonataExpression` at delivery — parking the subscription hours later instead of rejecting the call. Asymmetric with selector `condition`s, which ARE configure-time-validated (`#validateAppend` → `compileEventSelector`). One-line fix in the `crossPostTo` sugar: `compileJsonataExpression(args.transform)` before appending.
- **The live/wake pump has no byte cap** (`stream-subscribers.ts:785`, `limit: 100`, unlike `#readBatch`'s `DELIVERY_BATCH_BYTE_LIMIT` on the push lane): 100 near-2MB events in one batch can exceed the RPC frame limit, and via HIGH-2's missing backoff that becomes another deterministic-failure hot loop. Fixing HIGH-2 downgrades this to a park; applying `#readBatch`'s byte-shrink to the pump fixes it outright.

---

## Summary

| #   | Severity | One-liner                                                                                                                                                                                                                                 |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | Park never clears the row's backoff and `onAlarm` re-arms from stale/parked rows → permanent DO alarm hot loop for every parked subscription (plus transient spin during every in-flight retry)                                           |
| 2   | HIGH     | Wake-lane sink delivery failures only close+re-poke — no nack, no backoff, no park (poke ack resets `attempt`) → infinite hot loop + unbounded presence-fact log growth on any deterministic ingest failure; contradicts README/host docs |
| 3   | MED-HIGH | Selector-condition error facts self-feed: a condition that throws on `error-occurred` events makes each drain iteration append as many new facts as it reads — unbounded log growth the pause door can't stop                             |
| 4   | MED      | `ack` = unfenced monotonic max → cursor-set / resume-seek / replacement-deliver / remove+recreate seeks silently clobbered by in-flight drain acks; remove+recreate variant loses the new receiver's promised history outright            |
| 5   | MED      | Version-bump/KV-loss state rebuild reads the whole event log in one `.toArray()` — large capture streams OOM the constructor and brick the stream                                                                                         |
| 6   | LOW      | Idle teardown acks watermark to maxOffset past a wedged unsettled sink delivery → redelivery deferred until next append (indefinite on quiet streams)                                                                                     |
| 7   | LOW      | `#armAlarmNoLaterThan` get/set race can arm the later of two concurrent arms (retry delayed, self-heals)                                                                                                                                  |
| 8   | LOW      | `replayAfterOffset` / wake `checkpointOffset` unvalidated (NaN/negative/float) → live-looking subscriptions that silently deliver nothing                                                                                                 |

# Appendix B — full performance report

# Deep review: streams performance (measurable hot-path costs)

Scope: `apps/os/src/domains/streams/**`, `src/itx/expression.ts`, streams parts of `src/rpc-targets.ts`, `src/domains/itx/itx-entrypoint.ts`. Branch molten-spine (== main post #1784).

Baseline model used for magnitudes: 1000 events/sec of ~4KB events into one stream DO with the standard shape — the birth-certificate push subscription to the project worker, one wake-mode processor (agent-style), one ephemeral browser connection. Micro-benchmarks were run with the repo's zod 4.3.6 and @mmkal/jsonata on this machine (node, JIT-warm; workerd will be same order of magnitude).

Key measured numbers (µs/op):

| operation                                                                           | cost       |
| ----------------------------------------------------------------------------------- | ---------- |
| `StreamAppendInput.strict()` construct **+ parse** (as written today, per event)    | **19.8**   |
| same parse with the strict schema hoisted                                           | 0.40       |
| `getEventSchema(...)` construct + parse (per `parseEvent` call today)               | **25.2**   |
| same parse with schema cached                                                       | 0.34       |
| wildcard-consume `getEventSchema` construct + safeParse (StreamProcessor per event) | **27.3**   |
| cached wildcard safeParse                                                           | 0.26       |
| JSON.stringify / JSON.parse 4KB event                                               | 1.4 / 1.4  |
| v8-serialize ~2KB core state (KV put floor)                                         | 3.4        |
| jsonata compile / cached evaluate                                                   | 15.8 / 0.8 |
| reduce's two full-state shallow copies                                              | 0.05       |

The append turn is a single synchronous DO thread, so per-event CPU sums directly into the throughput ceiling. Today's synchronous per-event work (validate ~20µs + reduce ~1µs + stringify/encode/chunk ~5µs + 2 sql.exec ~10µs + 2 KV puts ~10–20µs + reconcile SQL ~10–20µs) is roughly **60–80µs/event before fan-out**, and fan-out (re-reads, re-stringify, RPC serialization) roughly doubles it. That puts the practical single-stream ceiling around 4–6k events/sec; the fixes below roughly halve per-event cost.

---

## 1. Per-call Zod schema construction on three hot paths (biggest single CPU item)

**Where:**

- `stream-durable-object.ts:217` — `StreamAppendInput.strict().parse(eventInput)` builds a **new** strict schema per event, per append. Measured 19.8µs vs 0.4µs hoisted (**~50× overhead**).
- `processor-contracts.ts:480–495` (`makeContractEventParser`) → `getEventSchema`/`getEventInputSchema` (`processor-contracts.ts:296–349`) construct a fresh `z.looseObject` on **every** `contract.parseEvent(...)` call. Hits the append turn for every `events.iterate.com/stream/*` fact (`#reduceCore` at `stream-durable-object.ts:443` — and config events are parsed **twice**: once in `#reduce`, again in `#processEvent` at lines 688–716).
- `stream-processor.ts:486–489` (`#reduceRawEvent`) — every event ingested by every hosted processor rebuilds the schema. For a `consumes: ["*"]` processor (agents), that is 27µs **per event per processor**, all on the wake lane the voice plan rides.

**Why it costs:** zod v4 `.strict()`/`z.looseObject(...)` clone/build a schema object graph (8 field schemas) and recompile the parser on first parse; then it is thrown to the GC. Pure allocation + compilation, ~50–65× the cached parse cost, plus GC pressure.

**Magnitude at 1000 events/s:** append path ~20ms/s CPU (2% of a core) inside the synchronous commit turn; +27ms/s per wake-mode processor; control-fact bursts (presence churn) pay ~50µs per fact (double parse). Combined with one processor: **~5% of a core, and ~25–50µs added to every append's synchronous latency.**

**Fix:** hoist `const StrictStreamAppendInput = StreamAppendInput.strict()` to module scope (one line); memoize `getEventSchema`/`getEventInputSchema` per `(contract, eventType)` inside `makeContractEventParser` and `#reduceRawEvent` (a `Map<string, z.ZodType>` on the contract object — contracts are module singletons, so the cache is naturally bounded). No wire or semantic change.

---

## 2. Every appended event is re-read from SQLite and re-parsed once per delivery lane, then re-stringified for byte accounting

**Where:**

- Live pump: `stream-subscribers.ts:785` — after every commit, **each** live connection re-reads the just-appended events via `#hooks.readEvents` → `StreamEventLog.getRange` (`stream-storage.ts:103–148`): SQL subquery+join, chunk reassembly, `new TextDecoder()` per event (`stream-storage.ts:368–373`), `JSON.parse`, **full zod `StreamEvent.parse` per event** (`stream-storage.ts:163–166`).
- Push drain: `stream-subscribers.ts:435` (`#readBatch`) does the same read, then `stream-subscribers.ts:546–555` **re-JSON.stringifies every event** just to count bytes against `DELIVERY_BATCH_BYTE_LIMIT` — even though the `event_chunks` rows read moments earlier ARE the exact serialized bytes (`chunk_bytes.byteLength` is the answer, already in hand inside `getRange`).

**Why it costs:** each event's bytes are serialized at insert, then per lane: SQL row materialization + decode + JSON.parse (~1.4µs/KB) + zod parse + (drain only) a second full stringify (~1.4µs/KB). With 3 lanes ≈ **30–50µs/event**, all on the DO thread. Quadratic check: not quadratic — each event is stringified once per batch read; events sliced off by the byte cap are re-read + re-stringified in the next iteration, bounded at 2× worst case. But at the cap (voice: 1MB batches) the accounting alone is **~1.4ms of stringify per batch**, serialized into the drain loop's latency.

**Magnitude at 1000 events/s (4KB events):** ~30–50ms/s CPU + ~10 SQL range reads/s/lane; at byte-cap saturation, +1.4ms per push batch.

**Fix (two independent pieces):**

1. Live-tail fast path: `append()` already holds the committed `StreamEvent[]` (`newEvents`); pass it to `#subscribers.wake(newEvents)` and let a pump whose `cursor === previous maxOffset` consume it directly, falling back to storage reads only for catch-up. Safe: the appended objects are exactly what a read-back produces (append input is strict-parsed, so no key stripping differs; `path` is stamped at commit).
2. Byte accounting from the log: extend `getRange` to return per-event byte size (sum of `chunk_bytes` lengths — one extra column already materialized), and make `#readBatch` use it. Deletes the second stringify entirely.

Neither touches return-frame semantics or the synchronous append boundary.

---

## 3. Core state checkpoint written to KV on every append — twice

**Where:** `stream-durable-object.ts:268–270` → `#writeCoreProcessorState` (`stream-durable-object.ts:879–882`): `kv.put("state", state)` **and** `kv.put("stateVersion", CORE_STATE_VERSION)` on every append that commits ≥1 event.

Answering the review question directly: **yes** — every append serializes the full core state for the KV write (V8 structured-clone, not JSON.stringify, but same O(state) cost) plus a second, always-identical `stateVersion` put.

**Why it costs:** serialization is O(state size) — state carries the full `configuredSubscribersByKey` (whole config event payloads incl. selector conditions and JSONata transform strings), `processorsBySlug` announcements, `connectionsByKey` roster, unbounded `metadata`. A modest state is ~2KB (3.4µs serialize + 2 SQLite row rewrites + WAL); a busy agent stream's is easily 10–50KB → 20–100µs serialize + KB-scale write amplification **per event**. The `stateVersion` put doubles the KV statement count for zero information.

**Magnitude at 1000 events/s:** 2 extra SQLite writes/event (~2000/s) + 2–50MB/s of redundant state serialization depending on state size. This and #4 are most of the storage-op count per append.

**Fix:** (a) write `stateVersion` once (at boot / when it differs), not per append — trivial. (b) Debounce the state checkpoint: write every N events (e.g. 64) or when ≥X ms since last write, plus on alarm/idle-teardown. Safe **by existing design**: `#readCoreProcessorState` → `#catchUpCoreProcessorState` (`stream-durable-object.ts:885–898`) already folds log rows past a stale checkpoint on wake — a lagging KV state is the supported case, and committed events passed append-mode validation so replay reproduces the identical state. The event rows remain the synchronous commit boundary; append stays synchronous.

---

## 4. `#reconcileDurable` runs 2 SQL statements per configured subscription on every append

**Where:** `stream-subscribers.ts:285–318` — `wake()` runs post-commit on every append; for each configured subscription it executes `store.ensure(...)` (an `INSERT ... ON CONFLICT DO NOTHING`, `stream-storage.ts:250–257`, with a fresh `new Date().toISOString()`) and `store.get(...)` (a SELECT), even when the row exists and the subscriber is caught up or backing off.

**Why it costs:** with S subscriptions that is 2S statements per append of pure no-op overhead (b-tree probe + statement dispatch each), inside the same DO thread as the commit. The `ensure` is only genuinely needed on config events and after a state rebuild (its own comment says so).

**Magnitude at 1000 events/s, S=2:** ~4000 SQL statements/s ≈ 10–30ms/s CPU + allocation churn.

**Fix:** keep an in-memory write-through mirror of cursor rows in `StreamSubscribers` (the DO is the only writer; `reconcileSubscriptionCursorRows` at boot goes through the same store). Minimum viable: an `ensuredKeys` Set (invalidated on delete/config/rebuild) to skip `ensure`, and cache the row read per key (invalidated by ack/nack/setCursor/delete, which this class itself performs). Cuts steady-state reconcile to zero SQL when everyone is caught up.

---

## 5. Push dial mints a fresh loopback binding + itx root per delivery

**Where:** `subscriber-sinks.ts:204–219` (`acquireAuthorityRoot`), used by `push()` per batch (`subscriber-sinks.ts:262–269`) and by every poke. Each delivery: `ctx.exports.ItxEntrypoint({props})` stub creation → **awaited** `binding.get()` RPC round trip → `ItxEntrypoint.get()` (`itx-entrypoint.ts:25–36`) → `trustedInternalAuthContext()` + `itxForScope` constructing `ProjectRpcTarget` + `CapabilityHostRpcTarget` + the `withInvokeCapabilityFallback` proxy (`rpc-targets.ts:3948–3960`) → expression walk (pipelined property read + call) → dispose of root and binding.

**Why it costs:** one full awaited loopback RPC round trip plus target-graph construction and stub/session teardown per delivery — est. **0.1–0.3ms per delivery**, and it is on the delivery _latency_ path (the ack the cursor waits on). The drain loop even re-mints per iteration while draining a backlog (a 10k-event backlog at batch 100 = 100 mints back to back).

**Magnitude:** measurable exactly where batches are small: at trickle rates every append becomes a 1-event push batch → 0.1–0.3ms/event of dial overhead (at 1000/s of 1-event batches that would be 10–30% of a core; at saturated 100-event batches only ~1–3ms/s). It also adds ~0.1–0.3ms to every push delivery's append→delivered latency.

**Fix — yes, the dial can cache the root for the push/webhook lanes:** the authority is `trustedInternalAuthContext()` (ambient, non-expiring) scoped to the stream's own fixed `projectId` — there is no per-delivery freshness to re-derive; "every delivery re-derives authority from the root" is preserved as long as the cached root is the same-scope root. Cache `{root, dispose}` in the `createSubscriberDial` closure; on any delivery failure, dispose and re-mint on the next attempt (bounds a wedged chain); the DO's eviction drops the stub naturally, and the loopback chain is same-isolate so holding it pins memory only, not cross-isolate billed duration. Precedent already in-tree: the **wake** lane deliberately parks the loopback chain for the whole connection lifetime (`onDisposed: dispose`, `subscriber-sinks.ts:245–248`). Keep wake per-acquisition (its chain lifetime is tied to the returned sink); cache only for push/webhook.

---

## 6. Full core state serialized into every delivered batch, per subscriber, per hop

**Where:** live pump batch (`stream-subscribers.ts:814–822`, `state: currentState`) and push batch (`stream-subscribers.ts:500–513`, `state`). Every batch to every lane carries the complete `CoreProcessorState` — roster, full config payloads (selector/transform strings), announcements, metadata.

**Why it costs:** O(state) structured-clone per batch per subscriber per RPC hop (DO→worker, worker→capnweb client; push: DO→loopback→dynamic worker). With single-event live batches at voice rates and a 2KB state: ~2KB × 1000/s × lanes × hops ≈ **4–8MB/s of redundant serialization per subscriber** — for small PCM events the state weighs more than the event. Grows linearly as the stream accrues subs/processors/metadata.

**Fix (contract-aware, does not touch the inviolable guarantees):** the zero-return-frame and synchronous-append guarantees are unaffected — `state` is payload, not a return frame. But "every batch carries state-at-streamMaxOffset" is the documented batch contract, so make it opt-out rather than dropping it: a `state: false` (mirror of the existing `events: false`) subscription/config option for event-only consumers (voice sinks, cross-post ingest — `buildIngestAppendInputs` reads only `configuredEvent.payload.params`, never `batch.state`), and/or deliver state only when `state !== previousDeliveredState` by reference (the fold already returns a new object only when something changed). Flag: any receiver relying on per-batch state must keep receiving it by default.

---

## 7. `events` table AUTOINCREMENT + `event_chunks` FK: extra b-tree writes on every insert

**Where:** `stream-storage.ts:37–43` (`offset integer primary key autoincrement`) and `stream-storage.ts:44–54` (`foreign key (offset) references events(offset)`).

**Why it costs:** offsets are ALWAYS supplied explicitly (`workingState.maxOffset + 1`), so AUTOINCREMENT's only effect is maintaining the `sqlite_sequence` row — an extra row **write** per event insert. The FK adds a parent-key probe per chunk insert (and the log is append-only through this one class, so it enforces nothing the code doesn't already guarantee).

**Magnitude at 1000 events/s:** ~1000 extra row writes/s + ~1000 probes/s inside the synchronous commit turn; est. 5–15ms/s.

**Fix:** drop `autoincrement` (plain `INTEGER PRIMARY KEY` keeps identical semantics with explicit offsets) and the FK for new tables; `create table if not exists` means existing streams keep the old shape harmlessly. Also worth folding in: reuse a module-level `TextDecoder` in `decodeChunks` (a fresh one is allocated per event read; the decode sequence is synchronous, so sharing is safe) and consider one multi-row insert per batch in `insert()`.

---

## 8. Selector compile per drain batch + isolate-global jsonata cache with wholesale clear

**Where:** `stream-subscribers.ts:567` (`#applySelector` calls `compileEventSelector(config.selector)` per batch — new Set + closure each time; the jsonata condition hits the shared cache), and `event-selector.ts:54–71`: `compiledExpressions` is a **module-global** map shared by every stream in the isolate, capped at 200, evicted by `clear()` — wholesale.

**Why it costs:** jsonata compile measured at ~16µs. The cache key space is every selector condition + every ingest transform across **all** streams in the isolate; past 200 distinct expressions the map clears entirely and every stream recompiles its condition on its next batch — a synchronized recompile burst, repeating every ~200 insertions (steady-state thrash: ~16µs per batch per conditioned subscription). The per-batch Set/closure churn is minor (~0.1µs) but free to remove.

**Magnitude:** zero until the fleet crosses 200 distinct expressions per isolate, then up to ~16µs/batch/subscription forever. Silent, load-dependent.

**Fix:** LRU eviction (delete oldest entry — Map iteration order gives this for free) instead of `clear()`; optionally cache the `CompiledEventSelector` on the `StreamSubscribers` instance keyed by `(subscriptionKey, latestConfiguredEvent.offset)` so the per-batch path does zero compile work.

---

## 9. Core-state rebuild reads the entire backlog in one unbounded `getRange`

**Where:** `stream-durable-object.ts:885–898` (`#catchUpCoreProcessorState`): `limit: highestOffset - next.maxOffset` in a **single** `getRange`, whose `.toArray()` (`stream-storage.ts:137`) materializes every chunk of every event in the window into memory at once. Hit on every version-bump wake and whenever KV state is missing/behind (`#recoverCoreProcessorStateFromEventLog`).

**Why it costs:** a voice stream at 1000 events/s × 4KB accrues ~14GB/day of log. One CORE_STATE_VERSION bump later, the next wake tries to hold the whole log in a 128MB DO heap → OOM-abort loop or multi-second wake stall; even benign cases (KV lag from finding #3's debounce, or today's crash-between-gates window) pay a spike proportional to the gap.

**Magnitude:** not per-event; per-wake. Unbounded memory, potentially fatal on exactly the high-volume streams this system is being aimed at.

**Fix:** page the replay — loop `getRange({ afterOffset: cursor, limit: 500 })` until caught up (identical fold semantics; `#reduce` replay mode is already per-event). ~5 lines.

---

## 10. Answered checks + minor items (each <1% but on the hot path)

- **Does the pump re-read coreState per batch?** No — `coreState()` is `() => this.#coreProcessorState` (`stream-durable-object.ts:93`), an in-memory field read. The pump's real per-batch cost is the event re-read (finding #2) and the state payload (finding #6).
- **Cursor-ack churn** (`stream-storage.ts:259–266`): one UPDATE (+`new Date().toISOString()` for `updated_at`) per acked batch is the ack itself — necessary. The webhook lane pays 2 SELECT/UPDATE per _event_ (`stream-subscribers.ts:466`, 492) — acceptable for an inherently slow lane. `minNextAttemptAt` scans only on alarm — fine.
- **Idle-timer churn:** `armOrClearIdleTimer` (`stream-subscribers.ts:952–959`) does clearTimeout+setTimeout plus a `#configuredConnectionKeys()` array build on **every append**. ~1–2µs/event; could rearm lazily (skip if last arm <1s ago). Only worth folding into another PR.
- **`runtimeState()`** (`stream-durable-object.ts:1062–1076` + `stream-subscribers.ts:922–944`): returns the full core state + `store.list()` per call; the stream UI polls it (`stream-state-view.tsx`). O(state) per poll — fine today, but it compounds with state growth; consider a slim variant for the poller.
- **Reduce-path copies** (`#reduceCore` + `#reduceCircuitBreaker`, `stream-durable-object.ts:442–460, 727–758`): two full-state shallow copies + breaker object + `Date.parse` per event measured at ~0.15µs total — **not worth touching** (listed to close the question; the allocation story here is fine).

---

## Wire-guarantee audit of the proposed fixes

- **Zero ephemeral return frames:** untouched — no fix changes result-pull/dispose semantics in `subscriber-sinks.ts` or the `StreamRpcTarget.subscribe` forwarder.
- **Append stays synchronous:** #1 (hoisted schema), #4 (in-memory row mirror), #7 (schema tweaks) shrink the synchronous turn; #3 removes writes from it but keeps event-row persistence exactly where it is (the commit boundary is the event rows + output gate; KV state lag is the already-supported recovery case). The live-tail fast path (#2) hands post-commit fan-out the same objects it would re-read; fan-out remains post-commit and non-failing.
- **Authority model:** #5 caches only the same-scope trusted root the dial would re-mint identically; expressions remain names, revocation by config removal is unaffected (the drain re-checks `configuredSubscribersByKey` per iteration at `stream-subscribers.ts:423`), and dispose-on-failure bounds stub staleness. Wake pokes stay per-acquisition.

# Appendix C — full abstractions report

# Deep review: unnecessary/leaky abstractions and dead code in the streams system

Branch `molten-spine` (== main post #1784). Scope: `apps/os/src/domains/streams/**`,
`src/itx/expression.ts`, streams-related `src/rpc-targets.ts`,
`src/domains/itx/itx-entrypoint.ts`, `src/domains/itx/utils.ts`.

Method: for every candidate the existing design was steelmanned first against the
inviolable constraints (synchronous append commit; the zero-return-frame /
pulled-not-awaited wire guarantees; plain-node unit-testability of the spine).
Verdicts below are only the places where the steelman loses. A "steelman wins"
appendix lists the suspects from the brief that survived scrutiny, so nobody
re-litigates them.

Ranked by LOC-deleted-per-risk (highest ratio first).

---

## 1. `processorsBySlug` — a state registry nothing reads

**Where:** `src/domains/streams/core-processor-contract.ts:315-323` (schema),
`src/domains/streams/stream-durable-object.ts:549-561` (reducer),
`src/domains/streams/rpc-types.ts:176-179` + `core-processor-contract.ts:199-203` (docs).

**Steelman:** it's the "contract documentation registry" — announcements folded into
core state so a stream can describe its own processors.

**Where it loses:** zero programmatic readers. Not the UI (the processors panel and
`example-events-panel.tsx` read announcements off _presence entries_ folded browser-side
from `subscriber-connected` events), not e2e, not tests, not `__describe`. The only way
a human sees it is the raw-JSON dump in `stream-state-view.tsx`. The same announcement
already rides every `subscriber-connected` fact (`connectionsByKey[..].subscriber
.processor.announcement`), so the information is durably in the log AND in another state
field. This is the same concept stored twice, one copy dead.

**Simpler shape:** delete the state field and the `subscriber-connected` reducer's
second `next = {...}` block; keep announcements on presence facts only.

**Deletes:** ~30 LOC + one fewer object spread on the connect fold. Requires a
`CORE_STATE_VERSION` bump (12) — the rebuild path already exists and is exercised.

**Risk:** low. Loses one raw-debug affordance; if a "which processors does this stream
know" view is ever wanted, `connectionsByKey` (which IS read by e2e and stays) carries
the same announcements for live connections, and the log has the rest.

---

## 2. `stream/metadata-updated` + core-state `metadata` — dead event type, dead field

**Where:** `core-processor-contract.ts:290` (state field), `:375-380` (event def),
`stream-durable-object.ts:511-517` (reducer case).

**Steelman:** generic metadata slot; events are the public API, so "no appender in src"
doesn't prove dead — a user could append it.

**Where it loses:** no appender, no reader, anywhere — not src, not UI, not e2e, not the
browser mirror (which parses only `createdAt`/`maxOffset`/`childPaths`/`eventCount` out
of core state, `client-libraries/browser/core-processor-state.ts:23-44`). A public
affordance whose output is observable by no surface is not an affordance; it's an
attractive nuisance in the generated contract's event catalog. Owner doctrine is
explicit: no speculative slots, clean breaks are fine.

**Deletes:** ~15 LOC + one entry out of the public event catalog + `consumes` list.
Version bump rides along with finding 1.

**Risk:** low-moderate only in the "someone in userspace appended metadata-updated on
prd" sense; the event would still commit (unknown types are legal), it just stops
folding — which is exactly what it does for every other unknown type.

---

## 3. Duplicate types: `ProcessorSnapshot`/`StreamProcessorSnapshot`, `ProcessorRuntimeState`/`StreamProcessorRuntimeState`

**Where:** `rpc-types.ts:24-27` + `:185-189` vs `stream-processor.ts:117-121` +
`:127-131`. Both pairs are structurally identical (`{offset, state}` and
`{snapshot, runtime?}`); `StreamProcessorRpcTarget` (rpc-targets.ts:4363) typechecks
only because the twins happen to stay in lockstep.

**Steelman:** rpc-types is the public wire-shape module, stream-processor is the engine;
decoupling lets them evolve independently.

**Where it loses:** they cannot evolve independently — the RPC facade implements
`StreamProcessorRpc` by delegating to `StreamProcessor`, so any divergence is a type
error at the facade, discovered anyway. Two names for one concept is exactly the
"concepts existing twice under different names" tax: every reader must check whether
`StreamProcessorSnapshot` and `ProcessorSnapshot` differ (they don't). No import cycle
blocks unification: `stream-processor.ts` can import the pair from `rpc-types.ts`
(rpc-types imports only `schemas.ts`).

**Simpler shape:** keep the `rpc-types.ts` pair (it's the published contract), delete
the `stream-processor.ts` twins, alias the exported names if churn matters.

**Deletes:** ~15 LOC + the standing "are these the same?" question.
**Risk:** near zero (structural types, compiler-checked).

Related 1-liner: `stream-processor-host.ts:44` re-exports
`StreamSubscriberWakeRequest/Response` from rpc-types — no consumer imports them from
there; delete the re-export.

---

## 4. Two single-use generics both named `latestConfiguredEvent`

**Where:** `core-processor-contract.ts:185-197` (a generic zod-record builder,
one call site) and `stream-durable-object.ts:1123-1141` (a generic record constructor,
one call site). Same name, two files, two different things.

**Steelman:** they were genuinely shared when cross-post rules were a second
configured-record kind (core state v8); the generality was load-bearing.

**Where it loses:** v10 deleted cross-post rules ("a cross-post is a push subscription"),
leaving both generics with exactly one instantiation each — vestigial generality, plus a
naming collision that makes grep results actively confusing. The DO-side function's
`as Pick<Event, ...>` cast exists only to service the unused genericity.

**Simpler shape:** inline the zod object into `configuredSubscribersByKey`'s schema;
inline the record literal into the `subscription-configured` reduce case.

**Deletes:** ~25 LOC. **Risk:** none (pure inlining).

---

## 5. The webhook branch inside `#drainPush` — a 40-line parallel drain that batch-limit-1 would erase

**Where:** `stream-subscribers.ts:458-497`.

**Steelman for webhook as a _mode_:** it is genuinely not push wearing a hat — external
receivers expect single-event svix-style POSTs, per-event acks give mid-batch resume,
`state` must not leave the deployment, and the transport is HTTP-not-expression. The
union arm itself (core-processor-contract.ts:119) earns its keep. **That steelman holds;
webhook stays a mode.**

**Where it loses:** the _implementation_ duplicates the drain. The webhook branch is a
second delivery loop inside the first: its own attempt read, its own
`withDeliveryTimeout`, its own `#onPushFailure` call, its own trailing-ack. Meanwhile the
code itself observes that "a webhook 'batch' is already its own poison isolate" — i.e.
the branch is behaviorally the push path pinned to batch size 1.

**Simpler shape:** pin webhook subscriptions' read limit to 1 (one line where `limit` is
computed, or in `#reconcileDurable`), and reduce the mode difference to the dial call:
`config.delivery.mode === "webhook" ? dial.webhook(url, envelope) : dial.push(expr,
batch)` at the single delivery point. `matched.length` is then always ≤1 for webhook, so
bisect/`SKIP_CONFIRM` degenerate correctly with no special casing, per-event ack falls
out of the ordinary batch ack, and `deliveryId(key, o, o)` falls out of the general
formula.

**Deletes:** ~30-35 net LOC and one of the two delivery loops.

**Risk:** moderate. A backlogged webhook does one SQL read per event instead of per 100
(network POSTs dominate, but it's real); the per-event `attempt` bookkeeping shifts from
"read row per event" to the loop's row re-read — needs the existing
`stream-subscribers.test.ts` webhook scenarios to pin behavior. Wire guarantees
untouched (this is all stream-side).

Related honesty nit, same area: `StreamWebhookDelivery.projectId: string | null`
(`rpc-types.ts:136`) is a lie — webhooks are rejected on global streams at append
(`stream-durable-object.ts:370`) AND at dial (`subscriber-sinks.ts:284`). Type it
`string`.

---

## 6. Seek is spelled three ways: `deliver` on a replacement config, `subscription-cursor-set`, `subscription-resumed {afterOffset}`

**Where:** `core-processor-contract.ts:422-429` (cursor-set event),
`stream-durable-object.ts:639-643` + `:711-718` (fold + side effect),
`stream-subscribers.ts:737-740` (`onCursorSet`), vs `onResumed` at `:743-753`, vs
"an explicit deliver policy on a REPLACEMENT config is a seek" at `:718-720`.

**Steelman:** they are three intents — declarative initial position (config-time,
deterministic under replay), operator seek (audited runtime act), and un-park-with-
redrive. The park/resume pair is doctrine ("park and resume are facts") and must stay.

**Where it loses:** `subscription-resumed {afterOffset}` already fully subsumes
`subscription-cursor-set`: on an unparked subscription the resume fold is a no-op and
`onResumed(key, afterOffset)` does _exactly_ `setCursor + wake` — the same body as
`onCursorSet`. Two public operator verbs, one behavior. And a third spelling (re-append
config with `deliver`) also moves the cursor. Each extra spelling is contract surface,
a fold case, a side-effect case, a spine method, and a doc row.

**Simpler shape:** delete `subscription-cursor-set`; document `subscription-resumed`
as "make delivery go, optionally from here" (it is already "the redrive" per its own
docstring). Keep `deliver`-on-replacement (config-time initial position is genuinely a
different act and is replay-deterministic).

**Deletes:** ~30-35 LOC (event def, reduce case, processEvent case, `onCursorSet`,
README/table rows) plus one concept.

**Risk:** moderate-low. Semantics preserved (verified against the fold: resume on
unparked = counts + clears nothing; `onResumed` with afterOffset = setCursor). The cost
is naming: "resumed" on an active subscription reads oddly in an audit log, and the
park/cursor distinction in `subscriptionRuntimeState` stays unchanged. If the audit-log
verb distinction is judged load-bearing, the finding inverts to: make `cursor-set`
also clear parked state and delete the `afterOffset` arm of `resumed` — either way,
two verbs, not three.

---

## 7. `LiveStreamSubscriberDescriptor` — the live capability rides in two different positions on the two lanes

**Where:** `core-processor-contract.ts:245-257` (the Live/serializable descriptor
split), `stream-durable-object.ts:957-959` (the cast + projection dance),
`rpc-types.ts:169-183` (wake response).

**Steelman:** the descriptor must be serializable (it lands on presence facts) while
`getRuntimeState` is a live stub, so a runtime-only superset type keeps the subscribe
arg honest.

**Where it loses:** the wake lane already solved this differently — the poke response
carries `getRuntimeState` as a _sibling field_ next to the serializable `subscriber`
(`rpc-types.ts:182`), not inside it. Only the ephemeral `subscribe()` lane buries the
live capability inside `subscriber.processor.getRuntimeState`, which forces: the
`LiveStreamSubscriberDescriptor` type, the `as` cast in `subscribe`, the "parse the
serializable projection, pass the live bit separately" comment block, and an `Omit<>`
gymnastic. One concept (live sidecar to a serializable identity), two encodings.

**Simpler shape:** `subscribe({ ..., subscriber, getRuntimeState? })` — sibling field,
matching the wake handshake. Delete `LiveStreamSubscriberDescriptor`; `subscriber`
becomes plainly `StreamSubscriberDescriptor`-shaped on both lanes.

**Deletes:** ~20 LOC + one type + the cast.

**Risk:** low. `Stream.subscribe`'s public contract types `subscriber` as `unknown`, so
the wire change touches exactly one first-party caller
(`client-libraries/browser/stream-browser-store.ts:642-648`) and the generated contract
text.

---

## 8. Write-only `incarnationId` on the subscriber descriptor + a docstring that promises consumers that don't exist

**Where:** `core-processor-contract.ts:226-231` (field),
`stream-processor-host.ts:120-124` + `:227-231` (producer), and the
`subscriber-connected` description at `core-processor-contract.ts:432` ("Reconciling
processors treat this as 'someone's runtime state was reset'").

**Steelman:** the reconcile-on-presence pattern is real doctrine (contract files say
processors that reconcile on presence facts list core as a `processorDeps`), and the id
is cheap.

**Where it loses:** grep the tree — nothing reads `subscriber.incarnationId`, no
processor reconciles on it, the browser presence UI ignores it. The docstring describes
a consumer that was designed but never built. That's the precise "doc promises a simpler
(here: richer) model than the code delivers" failure, in both directions: dead plumbing
plus an overclaiming doc.

**Simpler shape:** either delete the field + the host's `hostIncarnationId` (~12 LOC,
descriptor shrinks) or keep it and rewrite the docstring to say what's true today
("carried for future reconcilers; nothing consumes it yet"). Given owner doctrine
(no speculative slots), delete; the core state's own `incarnationId` (from `woken`)
is unaffected and IS load-bearing.

**Risk:** low. Presence facts get one field smaller; e2e doesn't assert it.

---

## 9. `StreamPushEventBatch.state` — core reduced state leaks to userspace on every push delivery

**Where:** `rpc-types.ts:108-126` (push batch extends the state-carrying envelope),
`stream-subscribers.ts:500-513` (state attached per drain batch), vs the explicit
carve-out at `rpc-types.ts:129-134`: webhook is "deliberately WITHOUT the `state` other
lanes carry — core reduced state is internal and has no business leaving the
deployment."

**Steelman:** "the same envelope for browsers, hosted processors, and the project
worker" is THE unification claim of the redesign, and live lanes genuinely need
state-at-streamMaxOffset (browser paints from it).

**Where it loses:** the doctrine is already broken — webhook strips state because it's
"internal", but the push lane delivers the _identical_ internals (delivery expressions,
park errors, the whole `configuredSubscribersByKey`) into the project worker, which is
_userspace code in the user's repo_. Either core state is internal or it isn't. Also a
real cost: the full, growing core state is serialized per push batch (per delivery, per
retry) to receivers that ignore it — `ingest` never reads it, and no template worker
does.

**Simpler shape:** push batches carry events + the at-least-once fields; drop `state`
(and arguably `streamMaxOffset` stays for lag awareness). `StreamPushEventBatch` stops
extending `StreamEventBatch` and states its own five fields — the "one envelope" claim
narrows to the _live sink_ lanes, which is what's actually true.

**Deletes:** ~5 LOC + a per-delivery serialization of unbounded state; mostly this is a
leak fix, not a LOC fix.

**Risk:** moderate: it's a breaking change to the worker-feed envelope
(`domains/workers/schemas.ts:229` types `processEventBatch(batch: StreamEventBatch)`),
so template + deployed project workers see a narrower batch. No known reader of
`batch.state` in templates; owner doctrine favors the clean break. If any userspace
worker does fold on `state`, it breaks — audit template + prd repos first.

---

## 10. Doc/code honesty: the "transport-free and clock-free" module calls `Math.random()` and `new Date()`

**Where:** `stream-subscribers.ts:25-29` (the claim: "everything it touches arrives
through `StreamSubscribersHooks` (storage, log reads, the dial, time, the alarm)") vs
`:657` (`computeBackoffMs(attempt, Math.random())`), `:807` and `:832`
(`new Date().toISOString()` for delivery metrics). Also `subscriber-math.ts:4-5` claims
"no clocks, no randomness (both are parameters)" — true of the math module, but the
spine injects real randomness at the one place it matters (jitter), so tests cannot
script it through hooks.

**Steelman:** the timestamps are debug-only metrics and the jitter is ±20% noise the
tests tolerate; adding `random()` to the hooks is a port for a port's sake.

**Where it loses:** only barely — but the claim is the module's headline and it is
false as written, and this module is the one place where the claim is a _load-bearing
testing contract_. Two honest fixes, either fine: (a) route the three call sites through
`hooks.now()` and add `random()` to the hooks (+4 LOC, claim becomes true), or (b)
soften the comment to "storage/transport/alarm-free; wall-clock is used only for debug
metrics and jitter" (0 LOC).

**Risk:** none.

---

## 11. Micro-cruft (batch these; ~35 LOC total, zero risk)

- `src/domains/itx/utils.ts:103-109` — dangling docstring ("Builds the Worker Loader
  cache key component…") for a function that no longer exists. Delete.
- `src/domains/itx/utils.ts:185-186` — doubled `/**` opener on the
  `rejectBuiltinCollision` docstring. Delete one.
- `stream-durable-object.ts:76-82` — dangling duplicate docstring above
  `#subscriptionCursorStore` (it documents `#subscribers`, which has its own copy of
  the same text at :77-82 vs the class doc at :64-66; the field's real docstring is
  :83-88). Delete the first block.
- `stream-durable-object.ts:813-824` — `#appendToStreamCoordinate` (private, one
  caller) + `appendToStreamPath` (public, zero external callers, used only by
  `#announceToAncestors`). Collapse to one private method (~8 LOC).
- `rpc-targets.ts:482-492` — `ingest`'s parameter type restates `StreamPushEventBatch`
  field-by-field. The generator does emit named rpc-types types (`StreamEventBatch` is
  in the generated contract), so annotate with the named type (~10 LOC, and the inline
  copy can't drift). (Contrast: `runtimeState()`'s inline type at :416-436 is a
  _deliberate narrowing_ — `connections: Record<string, unknown>` — leave it.)
- `stream-subscribers.ts:296-299` vs `:713-721` — the wake-rows-start-at-0 /
  push-rows-start-at-initialCursor policy is spelled twice in one file. One
  `initialCursorFor(config, offset)` helper in subscriber-math (~6 LOC net, and the
  policy gets table-tested).
- `core-processor-contract.ts:153-170` — `deliver`/`onPoison` are accepted-and-ignored
  on wake-mode configs (doc says "Ignored for wake mode"). A `superRefine` rejecting
  them on wake makes the config honest at append time (~6 LOC added, not deleted — an
  honesty spend, optional).

---

## Appendix: steelman wins (checked, not findings)

- **`StreamSubscribersHooks` earns its 8 ports.** `stream-subscribers.test.ts` (974
  LOC) drives the full spine — backoff, park, poison bisection, watermarks, idle
  teardown — in plain node against `FakeCursorStore` + a scripted dial. That is the
  inviolable unit-testability constraint made real; every port is exercised. The DO does
  not smuggle policy through it: `appendFact`'s must-not-throw and `armAlarm`'s
  move-earlier-only are documented at the seam, and edge-triggered config side effects
  (`onSubscriptionConfigured` etc.) vs level-triggered reconcile are both load-bearing
  (the seek-on-replacement rule cannot be derived from watermark lag).
- **`SubscriberDial` is honest.** Three verbs, one addressing grammar for two of them;
  retention and expression-walking quarantined in `subscriber-sinks.ts` — the "only
  streams file that knows RPC exists" claim checks out (stream-subscribers imports only
  the transport-agnostic `RetainedProcessEventBatch` _type_).
- **`processorSlug` on the wake arm** is the simpler shape, not a wart: the itx surface
  exposes one `processor` node per host, so a multi-processor host's slug cannot ride
  the expression without either per-slug surface nodes or breaking the property-step
  tail rule that keeps invocation receiver-bound (subscriber-sinks.ts:320-326, the
  live-proven thermo blocker). A typed, validated field beats args smuggled into the
  expression.
- **`params` bag** — one loosely-typed receiver-owned bag, interpreted only by named
  receivers (`ingest`'s `transform`), per "selectors filter; receivers transform".
  Conventions-over-frameworks as stated; not a spec-object.
- **`connection` vs `subscription` vs `configured-record` vs `cursor-row`** — each
  distinction is load-bearing: live pump state vs desired state vs the fact-vs-storage
  doctrine (park is a fact; acks are storage). e2e consumes `connectionsByKey` as the
  wire-visible truth.
- **`retainGetProcessorRuntimeState` (subscriber-sinks.ts:151-172)** — single caller,
  but it lives in the retention quarantine where that knowledge belongs;
  inlining would move dup/dispose rules into the transport-free module. Keep.
- **`withDeliveryTimeout`'s `onLateResolve`** — single-use option, but the late-settling
  poke's retained sink is a real leak class (thermo round 2, blocker 4b) and the option
  documents exactly why it exists. Keep.
- **`projectStateChangeCallback` (rpc-targets.ts:4566-4593)** — single caller
  (secrets' `publicState`), but the secrets detail page subscribes `onStateChange`
  through it in production (`routes/.../secrets/$secretId.tsx:56`), and dropping the
  retention-forwarding would silently break projected subscriptions' lifecycle. Keep.
- **`at()`/`resolveStreamPath`** — three real processor callers (repo/slack/email
  routing) that hold a `Stream`, not a `streams` collection; the escape guard is the
  capability boundary. Keep.
- **`events: false` state-only subscriptions** — one real caller
  (`lib/stream-navigation.ts:61`) and genuinely different semantics (coalesced state
  tails); can't be expressed as a selector. Keep.
- **Ephemeral/wake/push as distinct lanes** — the offset-ownership criterion ("the
  offset lives with whoever owns the state it must be transactionally consistent with")
  is real and each lane's ack semantics differ irreducibly. The README's axes table
  matches the code.
