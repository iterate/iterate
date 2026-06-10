---
state: todo
priority: high
size: large
dependsOn: []
---

# packages/streams review: fixes & cleanup

In-depth adversarial review of `packages/streams` (June 2026). Findings were
produced by four parallel reviewers (browser runtime, workers/RPC, processors,
docs) and the load-bearing ones independently re-verified against source. Three
of the four reviewers converged on the same top bug (the failed-batch desync),
which is why it leads.

This task is organized into **stages** ordered so that safety nets land before
behavioural changes, and structural changes land before cleanup. Each finding
has a stable id (`Cn` / `Mn` / `Pn` / `En` / `Dn`) so PRs can reference them.

Severity legend: **CRITICAL** = data loss / security; **MAJOR** = wrong
behaviour under realistic conditions; **MINOR** = edge-case or quality;
**NIT** = cosmetic.

Owner intent driving this work (from the review request):

- The whole package should be **as short and concise as possible**.
- Storage and the initial `created` event should **not** be initialized until
  the first `append` (lazy init). See Stage 2.
- `stream.ts` specifically should get **cleaner and shorter**.

---

## Stage 0 — Regression tests first (safety net)

The ~1000-line Stream DO has **zero always-on tests**: append, idempotency
keys, the pause gate, >512 KB chunking, and subscription replay/cursor live only
in `example-app/e2e/*`, which is `it.skip` unless `STREAM_STAGING_E2E=true`
(`example-app/e2e/vitest/stream-capnweb.test.ts:9`). Land tests that pin current
intended behaviour and fail on the bugs below, so the Stage 1–2 changes have a
net.

Write these first (all unit-testable with stubs, no deployed worker needed).

**Status (2026-06-10): Stage 0 COMPLETE.** All 8 tests landed and proven red
against current code (the four bug-pins are `it.fails` ratchets — flip to `it`
when the matching fix lands; T7/T8 are coverage and pass now). `pnpm test` stays
green: 58 passed + 4 expected-fail (node) and 6 passed + 2 expected-fail
(workers).

Files added:

- `src/stream-review-regressions.test.ts` — node tests T1, T2, T5, T6. Proven red:
  T1 `{total:7}` vs `12`; T2 nothing persisted on retry; T5 `-99996` tokens; T6
  `0` pauses.
- **vitest-pool-workers harness** (the structural gap): `vitest.workers.config.ts`
  - `vitest.workers.jsonc` (wrangler, compat date `2026-04-28` — the bundled
    workerd's newest supported date) + `src/workers/test-entry.ts` (exports the
    Stream + StreamProcessorRunner DOs). Node config now excludes
    `**/*.workers.test.ts`; `package.json` `test` runs both pools (`test:node`,
    `test:workers` split out). `@cloudflare/vitest-pool-workers` added as a devDep.
- `src/workers/durable-objects/stream.workers.test.ts` — DO tests T3, T4, T7, T8.
  Proven red: T3 `PublicStreamRpcTarget.prototype` includes
  `writeCoreProcessorState`; T4 append with `source` throws `Unrecognized key:
"source"`.

Harness notes for whoever picks up Stage 1+ (informed by how cloudflare/agents +
the workers-sdk rpc fixture test DOs):

- **Prefer `runInDurableObject(stub, (instance, state) => …)`** over RPC-stub
  calls. It calls the DO instance directly (no RPC boundary), so thrown errors
  are ordinary local throws — `expect(() => instance.append(...)).toThrow()`
  works with no unhandled-rejection noise — and `state.storage.sql` can be
  inspected directly (the >512KB test asserts the event really spans multiple
  `event_chunks` rows this way). Subscribing with a _local_ callback under
  `runInDurableObject` also makes replay deterministic (the pump drains in a few
  microtasks; no cross-isolate RPC, no long polling). One test deliberately
  stays on the stub to cover the production RPC boundary — note the stub
  promisifies the method's `MaybePromise` return into an awkward type, so those
  calls need `as StreamEvent` casts that the in-instance calls do not.
- For alarm-driven code, use `runDurableObjectAlarm(stub)` to fire alarms
  deterministically instead of advancing time. (The Stream DO's delivery pump is
  microtask-driven, not alarm-driven, so no alarm tests yet — relevant if the
  reconnect/backoff work in Stage 3/4 adds alarms.)
- The DO seeds `created` (offset 1) + `woken` (offset 2) on first touch, so user
  appends start at offset 3 (tests assert relative offsets). `cloudflare:test`
  types come from `/// <reference types="@cloudflare/vitest-pool-workers/types" />`.

- [x] **T1 — failed-batch redelivery / desync** (pins C1). Drives the real
      `createStreamProcessorHost` with a fake pump that mimics `stream.ts`
      (advance cursor before delivery, fire-and-forget the result); a batch fails
      once, the next succeeds, and the first batch's events must survive in
      reduced state. _Done — red._
- [x] **T2 — `writeState` failure persistence** (pins C2). `writeState` throws
      once; re-ingest the same batch; assert a snapshot is eventually persisted.
      _Done — red._ (`stream-processor-class.test.ts:380` covers the
      `readState`-failure half only.)
- [x] **T3 — `PublicStreamRpcTarget` surface** (pins C3). Asserts the generated
      target prototype does not expose `writeCoreProcessorState` /
      `readCoreProcessorState`. Today it does. _Done — red._
- [x] **T4 — append with `source` field** (pins M2). Appends an event with a
      valid `source` and reads it back. Today it throws `Unrecognized key:
"source"`. _Done — red._
- [x] **T5 — circuit-breaker clock regression** (pins M3). Spend a token with
      `createdAt` 1 s earlier than `lastRefillAtMs`; assert tokens decrement by
      ~1, not by 100k. _Done — red._
- [x] **T6 — circuit-breaker post-anchor flood** (pins M4). Trips at/below the
      anchor during replay, then feeds live events past the anchor; assert ≥1
      `paused` append. Today: 0. _Done — red._
- [x] **T7 — idempotency keys** (was untested anywhere). DO-level test: a
      repeated `idempotencyKey` is a no-op that returns the existing event, and
      an `offset` precondition that disagrees with the hit throws. _Done —
      passes (behavior is already correct; this is the coverage that was
      missing)._
- [x] **T8 — DO smoke suite, always-on.** Covers append + consecutive offset
      assignment, `getEvents` afterOffset/limit paging, a >512 KB chunked event
      round-trip, and subscribe replay from `replayAfterOffset: 0`. _Done —
      passes._ (`subscribeOutbound` handshake deferred — it needs the runner DO
      wired in; left for the M1/M3 outbound-reconnect work which exercises that
      path anyway.)

---

## Stage 1 — Critical correctness & security

### C1 — A single failed batch permanently desyncs a subscriber (CRITICAL)

_Found independently by the browser, workers, and processor reviewers._

The delivery pump advances its cursor **before** delivering, then
fire-and-forgets:

- `stream.ts:646` — `cursor = lastOffset` (before delivery).
- `stream.ts:660-666` — `disposeIgnoredRpcResult(pendingBatch)`, never awaited.

Every consumer swallows its own failure with no redelivery:

- Hosted processors: `stream-processor-host.ts:201-203` —
  `ingest(batch).catch(err => console.error(...))`. Checkpoint isn't written,
  but the _next_ successful batch advances `checkpointOffset` past the hole
  (`stream-processor.ts:338-341`), so the gap is unrecoverable even across DO
  restart (replay starts from the advanced checkpoint).
- Browser mirror: `stream-browser-store.ts:380-391` — same shape, but the
  SQLite continuity trigger (`RAISE(ABORT, 'offsets must append
continuously')`, see ADR 0002 / `browser-raw-events/implementation.ts:106-125`)
  then makes **every subsequent batch fail too**. The mirror freezes,
  `connectionStatus` stays `"subscribed"`, and nothing resubscribes until the
  user reloads.

The comment at `stream-processor.ts:369` ("The checkpoint is not written; the
batch retries") is the false claim: the base class is retry-_safe_ but nothing
retries. The test at `stream-processor-class.test.ts:235` only passes because
the test redelivers by hand.

- [x] **Fixed (Stage 1) — hosted-processor path.** On ingest failure the host
      (`createStreamProcessorHost`) re-handshakes from the durable checkpoint and
      the stream replays the batch. Two subtleties the fix had to handle:
  - **Continued delivery race:** the pump is fire-and-forget, so while a failed
    batch recovers the stream keeps delivering _later_ batches; ingesting one
    would advance the checkpoint past the gap. The host now tags each
    subscription with a `generation` and runs ingest through a per-processor
    serial chain that re-checks the generation **between** batches — batches from
    the superseded connection are dropped, and the post-recovery replay is the
    single source of truth.
  - **Poison policy (your call):** after `MAX_CONSECUTIVE_INGEST_FAILURES` (3)
    consecutive failures the host appends a `stream/error-occurred` event
    (idempotency-keyed by checkpoint offset) and disconnects, leaving it to the
    subscriber/processor (or a later re-dial) to decide — no hot loop.
  - Covered by T1 (transient recovery under continued delivery) + T1b (poison),
    both passing.
- [x] Updated the `stream-processor.ts` "batch retries" comment to describe the
      real host-driven recovery.
- [ ] **Still TODO — browser-store path** (`stream-browser-store.ts:380-391`).
      The browser mirror swallows ingest failures the same way and wedges on the
      SQLite continuity trigger. Apply the same resubscribe-from-checkpoint
      recovery there (separate consumer; tracked under Stage 4 alongside the
      other browser-runtime fixes).

### C2 — `writeState` failure advances in-memory checkpoint, persists nothing (CRITICAL)

`stream-processor.ts:374-376`:

```ts
this.#state = state;
this.#checkpointOffset = checkpointOffset;
await this.#saveSnapshot(); // throws AFTER the two lines above
```

A `writeState` throw rejects `ingest` _after_ the in-memory checkpoint advanced.
The redelivered batch then filters out entirely at `stream-processor.ts:339` and
returns at line 349 (`if (events.length === 0) return;`) without reaching
`#saveSnapshot` again — a host trusting "failed ⇒ retries" gets a silent success
that persisted nothing. (Verified with a runtime repro.)

- [x] **Fixed (Stage 1):** `#ingest` now `await this.#writeState({ offset, state })`
      **before** assigning `#state` / `#checkpointOffset`; the single-use
      `#saveSnapshot` helper was inlined and removed. T2 flipped to `it` and
      passes.

### C3 — `PublicStreamRpcTarget` leaks `protected` methods → state injection → arbitrary callable dispatch (CRITICAL, security)

`makeRpcTargetClass` (`shared/rpc-target.ts:49-66`) copies **every** own
prototype method except those in `exclude`. The exclude lists at
`stream.ts:789` / `stream.ts:794` only remove `subscribe` / `subscribeOutbound`.
TypeScript `protected` is compile-time only, so these `Stream` methods are
proxied and callable:

- `readCoreProcessorState` (`stream.ts:119`), **`writeCoreProcessorState`**
  (`stream.ts:135`), `reduce`, `reset`, `kill`.

`PublicStreamRpcTarget` is served unauthenticated in the example app
(`example-app/src/worker.ts`) and to any project member in prod OS
(`apps/os/src/domains/streams/project-stream-rpc.ts`). `writeCoreProcessorState`
accepts schema-valid state: an attacker can inject a `subscriptionsByKey` entry
whose `latestConfiguredEvent.payload.subscriber.callable` is attacker-chosen, and
on the next `#reconcile` → `#connectOutboundConnection` (`stream.ts:769`) the DO
`dispatchCallable`s it with the worker's full `env` as context — turning a
client-reachable RPC into arbitrary same-account binding/DO dispatch. Rolling
back `maxOffset` also bricks future appends (PK conflicts).

- [x] **Fixed (Stage 1):** `makeRpcTargetClass` gained an `include` allowlist
      option; both `StreamRpcTarget` and `PublicStreamRpcTarget` now pass an
      explicit `STREAM_RPC_METHODS` list (`satisfies readonly (keyof StreamRpc)[]`
      so it can't drift), plus `subscribeOutbound` on the internal target only.
      `readCoreProcessorState` / `writeCoreProcessorState` are no longer proxied.
      T3 flipped to `it` and passes.
- [ ] Follow-up (Stage 6 E7): fold `installSubscribeRpcTargetOverride` into the
      allowlisted generator now that the surface is explicit.

---

## Stage 2 — Lazy initialization (owner-requested) + the `woken` event

**Status (2026-06-10): ABANDONED.** Lazy init was prototyped (PR #1467) but
backed out: #1460's subscriber-presence model appends a `subscriber-connected`
fact on every `subscribe()`, which fundamentally conflicts with "don't
initialize storage until the first `append()`" (connecting would now have to
initialize). The owner chose to drop the lazy-init goal entirely rather than
unwind the presence model. `created` and `woken` are kept as eager appends. The
analysis below is retained for history only.

Currently the constructor (`stream.ts:49-82`), on **every** incarnation:

1. `#ensureStorageSchema()` — two `CREATE TABLE` execs.
2. reads/recovers core state.
3. appends `created` on first boot **and `woken` on every wake** (`stream.ts:72-77`).
4. `#reconcile()`.

So merely _reading_ a stream (a `getEvents`, an RPC probe, a reconcile dial)
instantiates the DO and writes a `woken` event. Consequences:

- The log grows one `woken` per restart forever — unbounded; each triggers a
  full reduce + KV write + connection fan-out.
- A pure reader can never be side-effect-free; any touch mutates durable state.

- [ ] **Defer schema + `created` to the first `append`.** Move
      `#ensureStorageSchema()` and the `created` append into the append path
      (`#appendBatchHere`), guarded so it runs once.
- [ ] **Reconsider `woken` entirely.** Almost nothing consumes it (only the
      circuit-breaker's pass-through list and the paused-gate exception). Prefer
      making incarnation id a piece of runtime/core state rather than a logged
      event, or drop it. If kept, it must not be what initializes a stream.
- [ ] **Couplings to handle when init goes lazy:**
  - `getEvents` / `runtimeState` / `getEvent` on a never-appended stream must
    return empty / initial state rather than throw.
  - `#reconcile()` on boot (`stream.ts:81`) currently assumes state was read in
    the constructor; rework so boot reconcile works from recovered-or-empty
    state.
  - The `created`-must-be-offset-1 special case
    (`processors/core/implementation.ts:108-113`) gets simpler once `created` is
    the deterministic first append.
- [ ] This is also the single biggest length win in `stream.ts`: it collapses
      the constructor and the offset-1 branch.

---

## Stage 3 — Major correctness bugs

### M1 — `onRpcBroken` is (almost certainly) never wired → broken connections never detected (MAJOR)

_Confirm with a quick test before acting — rests on capnweb/Workers-RPC stub internals._

`rpc-lifecycle.ts:31` guards with `Object.hasOwn(retained, "onRpcBroken")`.
capnweb proxy stubs expose no own descriptors (so `Object.hasOwn` is always
false even though `typeof stub.onRpcBroken === "function"`), and native Workers
RPC stubs have no `onRpcBroken` at all. If confirmed:

- Outbound (hosted processors): when a runner DO is evicted/redeployed/aborted,
  the broken connection stays in `#connections`; the pump keeps advancing
  `cursor` into a dead stub with rejections discarded; `#reconcile` skips keys
  already in `#connections` (`stream.ts:742`) so it never re-dials. Delivery
  stalls silently until the Stream DO incarnation itself restarts. The docstring
  "Triggered … on outbound connection loss" (`stream.ts:720`) is then false.
- Inbound (capnweb clients): a client that drops without `unsubscribe` leaks the
  DO connection for the incarnation lifetime and shows phantom connections in
  `runtimeState()`.

- [x] **Verify:** test whether `onRpcBroken` fires for (a) a capnweb stub and
      (b) a native RPC stub. Drop the `Object.hasOwn` guard and use
      `typeof retained.onRpcBroken === "function"`. _Fixed: `Object.hasOwn`
      guard dropped; the wiring is defensive because property access on a
      native RPC stub can fabricate a pipelined method (`rpc-lifecycle.ts`,
      unit tests in `rpc-lifecycle.test.ts`)._
- [x] **For the native outbound path** (no `onRpcBroken`): add liveness — observe
      the delivery result and `connection.close()` + `#reconcile()` on rejection.
      Note this overlaps with the C1 fix; design them together. _Fixed:
      `retainProcessEventBatch` takes `onDeliveryError`; the Stream DO drops the
      connection and re-dials on a rejected delivery, and the subscriber
      re-handshakes from its checkpoint (C1's generation gate drops stragglers).
      End-to-end abort/re-dial regression tests in
      `stream-redial.workers.test.ts`._

### M2 — Any event with a `source` field crashes the whole `appendBatch` (MAJOR)

_Verified with a runtime repro: ZodError `Unrecognized key: "source"`._

`StreamEventInput` advertises `source?: StreamEventSource` (`event.ts:18-26,
43-62`) and the DO accepts it (`stream.ts:375`, `.strict()` includes it). But
`getEventSchema` (`stream-processors.ts:582-589`) is a `strictObject` **without**
`source`, so the committed event hits the inline core reduce
(`consumes: ["*"]`) → `reduceRawEvent` → strict parse → throws, rejecting the
whole batch. Latent only because nothing currently sets `source`
(`apps/os/tasks/migration-notes/project-repo.md:26` records this as a known
trap). Same family: `idempotencyKey` is `z.string()` at input (`event.ts:59`)
but `.trim().min(1)` in `getEventSchema` — a whitespace key passes input
validation then explodes in reduce.

- [x] **Fixed (Stage 3):** kept `source` (the migration note shows OS wants it).
      Extracted a shared `StreamEventSourceSchema` + `streamEventIdempotencyKeySchema`
      in `event.ts` and used them in both `getEventSchema` and
      `getEventInputSchema`, so input and reduce schemas agree. `idempotencyKey`
      is now `trim().min(1)` on input too (a blank key can no longer pass append
      and then fail in reduce). T4 flipped to `it` and passes.

### M3 — Circuit-breaker token bucket subtracts on a backwards clock (MAJOR)

_Verified: `availableTokens === -99901` after a 1 s regression._

`circuit-breaker/contract.ts:78-82` computes refill as
`(createdAtMs - lastRefillAtMs) * (refillRatePerMinute / 60_000)`; a negative
delta drains tokens. `createdAt` is per-event wall clock
(`stream.ts: new Date().toISOString()`); DO migration / clock skew can regress
it. At the default refill, −1 s = −100,000 tokens → instant false trip → stream
paused for no reason.

- [x] **Fixed (Stage 3):** `spendCircuitBreakerToken` clamps the elapsed time with
      `Math.max(0, …)`. T5 flipped to `it` and passes.

### M4 — Circuit-breaker edge-trigger misses sustained floods after replay (MAJOR)

_Verified: 0 paused appends for live post-anchor events._

`circuit-breaker/implementation.ts:54-56` is edge-triggered:
`if (shouldTripCircuitBreaker(args.previousState)) return;`. If the
not-tripped→tripped transition lands at an offset `<= sideEffectsAfterOffset`
(skipped on replay by `stream-processor.ts:282`), every later live event sees
`previousState` already tripped and returns — so during sustained overload the
breaker is silently disabled. Also no retry if the background `stream/paused`
append fails (`stream-processor.ts:324-327` only logs).

- [x] **Fixed (Stage 3):** the trip is now level-triggered — `processEvent` fires
      whenever `shouldTripCircuitBreaker(state)` on a live event (the base class
      only calls `processEvent` for events past the anchor), dropping the
      `previousState` edge guard. The pause append is idempotency-keyed per offset
      and self-limits (once paused, ordinary appends are rejected). T6 flipped to
      `it` and passes. _(The "failed pause append never retried" sub-point is
      subsumed by the C1 ingest-failure recovery and is not separately handled
      here — noted for Stage 3 follow-up if it proves necessary.)_

### M5 — `eventTypes` is silently dropped by the subscribe override (MAJOR / decision)

`installSubscribeRpcTargetOverride` (`stream.ts:822-826`) forwards only
`subscriptionKey` / `replayAfterOffset` / `processEventBatch`. Yet
`StreamRpc.subscribe` advertises `eventTypes` with the doc "Only deliver these
event types" (`types.ts:49-55`), while `types.ts:46-48` _simultaneously_ says
filtering "is planned, but not part of this shape". Every remote inbound
subscriber therefore receives the full firehose and filters client-side, after
the data crosses the socket. The only remote caller that passes `eventTypes`
(`example-app/e2e/.../stream-processor-node.test.ts:41`) is masked because the
echo processor re-filters in `ingest`. The hosted **outbound** path uses
`subscribeOutbound` directly, so its filter _does_ work.

- [ ] **Decide and do one:** (a) thread `eventTypes` through the override (one
      line at `stream.ts:825`) — also fixes the firehose bandwidth waste (P3); or
      (b) delete `eventTypes` from the public `subscribe` signature. Either way,
      reconcile the contradictory `types.ts:46-48` comment.

---

## Stage 4 — Browser-runtime correctness (lower blast radius than C1, but real)

**Status (2026-06-10): COMPLETE (branch `streams-review-stages-4-7`).** All seven
findings fixed: C1-browser (self-heal — `ingestWithSelfHeal` resubscribes from
the persisted checkpoint with bounded backoff on ingest failure), B1 (connection
epoch guard on the status callback), B2 (`whenStreamReady` — `appendBatch`/
`runtimeState` await readiness instead of throwing during reconnect), B3
(rollback in its own try/catch so `withBusyRetry` sees the real error), B4
(incarnation guard via server `createdAt` + `mirror_meta` table — rebuild on
incarnation change instead of trusting offsets), B5 (`AbortSignal` on the web
lock + surfaced rejection), B6 (arm query GC at creation, skip listenerless
queries, equality-check before notify). Verified against current main (#1460 only
touched the server core, not these browser paths).

### B1 — Stale `close` event tears down the replacement connection (MAJOR)

`stream-browser-store.ts:314-321`: each `connect()` installs a status callback
that mutates the **shared** `stream` / `subscriptionHandle` / `writerRole`
without checking the event belongs to the current connection (contrast the
election path, which guards with `stream !== election.connection` at lines
369/386). A late `close` from a disposed connection A can land after connection
B is live — most reachable via `clearLocalDatabase()` (line 487): dispose A →
`discardLocalMirror()` → `reconnectNow()` assigns B → A's close arrives → B's
writer lock released, subscription unsubscribed, `stream = undefined`, B's socket
leaked. Plus a spurious reconnect 1 s later.

- [ ] **Fix:** capture the connection in the callback closure (or a per-connection
      `disposed` flag) and early-return for non-current connections.

### B2 — `appendBatch` / `runtimeState` / `kill` / `reset` throw during reconnect (MAJOR)

`stream-browser-store.ts:477-486`: `reconnectNow()` only assigns `stream` in a
later microtask, so synchronously after a drop (and through the whole 1 s
backoff window) `stream === undefined` and every call throws
`"stream connection is disposed"` — wrong message, healthy runtime.

- [ ] **Fix:** await the in-flight connection (return a promise that resolves
      once `stream` is set), or at minimum throw a "reconnecting, retry" error.

### B3 — Worker `ROLLBACK` masks the original error, defeating `withBusyRetry` (MAJOR)

`stream-db.worker.ts:125-140`: on a statement/commit failure the catch block does
`await sqlite3.exec(db, "ROLLBACK;")`; if that rollback itself rejects (e.g.
"cannot rollback - no transaction is active"), the rollback error **replaces**
the original, so `isBusyError` never sees `SQLITE_BUSY` and `withBusyRetry`
gives up. Combined with C1 this wedges the mirror on one transient busy error.

- [ ] **Fix:** wrap the rollback in its own try/catch; always rethrow the
      original error.

### B4 — Server reset-then-regrow silently splices two stream incarnations (MAJOR)

`stream-browser-store.ts:290-306`: reconcile only checks
`coreProcessorState.maxOffset >= localMaxOffset` and keeps the local suffix. If
the stream was `reset()` out-of-band and regrown past the old max while this tab
was offline, the check passes and `subscribe({replayAfterOffset: oldCheckpoint})`
splices new-incarnation events onto stale rows. Offsets stay continuous so the
trigger never fires — permanent, undetectable desync.

- [ ] **Fix:** add an incarnation/epoch marker, or verify the event at
      `localMaxOffset` matches the server's before trusting the suffix.

### B5 — Web Locks request can't be cancelled; rejection swallowed (MINOR)

`stream-leader.ts:24-39`: `release()` resolves `held` but the queued
`navigator.locks.request` (no `AbortSignal`) stays queued and later transiently
grabs/releases the lock; `void navigator.locks.request(...)` also swallows
rejections, so `whenWriter` never resolves and the tab becomes a silent
permanent follower.

- [ ] **Fix:** pass an `AbortSignal` aborted by `release()`.

### B6 — Query registry leaks orphans and re-runs every query on every change (MINOR, perf)

`stream-browser-db.ts:216-261, 312-316`: `query()` inserts into `#queries`
immediately but the GC timer is only armed in `unsubscribe`, so a query created
but never subscribed (e.g. a discarded React render — `useStreamQuery`'s
`useMemo` calls `db.query` during render) stays forever, and `#onChange` runs
`#runQuery` for **every** entry on every change (a worker round-trip per orphan).
A GC'd-then-resubscribed handle goes permanently stale (m2 in the review).

- [ ] **Fix:** arm GC on create-without-subscribe; re-validate the entry on
      resubscribe; add a result-equality check before swapping the snapshot
      (avoids re-render storms at ~60/s during replay).

---

## Stage 5 — Performance

**Status (2026-06-10): COMPLETE (branch `streams-review-stages-4-7`).** P1
coalesced (one op per `local_index`, O(n²)→O(n)), P2 bounded (`MAX_GROUP_EVENTS
= 200`), P3 dropped the per-event `stateSchema.parse` (state is validated only at
the KV/recovery trust boundary now). **P4 was already fixed by #1460** — the
subscribe override forwards `eventTypes`, so inbound subscribers get server-side
filtering. Note: #1460 reduced P3's original cost (the per-subscription
`safeParse` transform is gone) but the structural per-event full-state parse
remained until this change.

- [x] **P1 — `browser-event-feed` O(n²) write amplification.**
      `grouping.ts:112-128` pushes a _cumulative_ `update` op per event extending
      an open group (copying the whole accumulated array), and
      `implementation.ts:50` executes all of them, each `JSON.stringify`ing the
      full list. A 1,000-event same-type batch serializes ~500k events.
      **Fix:** coalesce to the last op per `localIndex` before SQL.
- [x] **P2 — `browser-event-feed` unbounded group rows.** Groups only close on
      event-type change (`grouping.ts:112-119`), so one dominant event type grows
      a single `feed_items.data` blob forever. **Fix:** add a max-group-size
      boundary.
- [x] **P3 — Core `reduce` exit-parses the whole `stateSchema` per event.**
      The expensive `SubscriptionsByKey` transform is gone post-#1460; dropped the
      remaining blanket `stateSchema.parse(next)` on the per-event reduce return.
- [x] **P4 — Inbound firehose** — already fixed by #1460 (subscribe override
      forwards `eventTypes`; filtering is server-side).

---

## Stage 6 — Elegance / conciseness (owner wants the package as short as possible)

**Status (2026-06-10): COMPLETE (branch `streams-review-stages-4-7`), minus the
obsolete/declined items.** E1, E2, E3, E5, E6 done (~247 lines deleted). **E4 is
obsolete** — #1460 removed the `processor-registered` event and its duplicate
payload; the `packages/shared/src/streams/circuit-breaker-types.ts` duplication
is a separate, live type hierarchy (69 importers), not dead code, so it was left
alone. **E7 declined** — post-#1460 the subscribe override genuinely needs to
retain the client callback / wire `onRpcBroken`, so folding it into the generic
`makeRpcTargetClass` would pollute a shared util for no real gain (and Stage 2,
the bigger `stream.ts` win, was abandoned).

- [x] **E1 — Delete ~130 lines of verified-dead exports** in
      `shared/stream-processors.ts` (zero usages repo-wide): `createEvent`
      (506-526; its comment falsely claims test usage), `getEventInputSchema`
      (536-556), `validateProcessorContract` (700-746) + now-orphaned privates
      `addResolvedEvent` / `assertResolvedEventTypes` /
      `isProcessorContractDependency` (889-930), `getProcessorStateSchema`
      (748-753), `ProcessorStreamApiProps` (466-474). Run `pnpm knip` to confirm.
- [ ] **E2 — Delete `waitForOpen`** (`connection.ts:51`) — zero callers; the node
      connect comment explains why awaiting open is unnecessary.
- [x] **E3 — Delete unreachable branch** `circuit-breaker/implementation.ts:56`
      (`if (event.type === ".../stream/paused") return;`) — the line-54 guard
      already returned because reducing `paused` resets `availableTokens` > 0.
- [~] **E4 — OBSOLETE** (processor-registered removed by #1460; shared
  circuit-breaker-types is live, not dead). **Collapse schema duplication:**
  - `core/contract.ts` declares the `processor-registered` payload twice
    (110-123 vs 190-204) — extract one const.
  - `SupportedSubscriptionConfiguredEvent` / `HistoricalSubscriptionConfiguredEvent`
    (43-61) differ only in subscriber schema.
  - `packages/shared/src/streams/circuit-breaker-types.ts` re-declares the
    breaker payloads verbatim from the contract (cross-package drift hazard).
- [x] **E5 — `messageInbox.error()`** (`subscription.ts:114-117`) is never called;
      disposal looks like normal completion to consumers. Either wire it on
      abnormal teardown or delete it (and the `waiters` machinery if `waitForEvent`
      stays unused — confirm with owner whether it's a public surface).
- [x] **E6 — Trim circuit-breaker `consumes`** (`contract.ts:49-62`): names all
      10 core events plus `"*"`; reduce only branches on
      configured/paused/resumed/woken. The 7 extra named entries buy nothing.
- [~] **E7 — DECLINED** (override must retain the client callback / wire
  `onRpcBroken` post-#1460; folding into the generic helper isn't worth it,
  and Stage 2's bigger `stream.ts` win was abandoned). **`stream.ts` conciseness** (the owner's specific target). Biggest wins:
  Stage 2 lazy-init (collapses constructor + offset-1 branch); the C3
  allowlist letting `installSubscribeRpcTargetOverride` fold into
  `makeRpcTargetClass`; and the M5 `eventTypes` decision. The chunking
  helpers (`chunkBytes` / `decodeChunks`) are the other dense spot but are
  load-bearing — leave them.
- [ ] **E8 — Note:** `echo` + `stream-processor-runner.ts` are e2e fixtures
      shipped in `src/`. `circuit-breaker` is real (configured by
      `apps/os/.../new-stream-runtime.ts` and hosted in the runner) — keep it.
      Decide whether echo/runner belong under a fixtures path.

---

## Stage 7 — Documentation

**Status (2026-06-10): COMPLETE (branch `streams-review-stages-4-7`).** D1 (design.md
status banner + corrected offsets/subscriber/storage/replay/OPFS + superseded
banners on the never-shipped sections), D2 (README import/disposability/route map),
D3 (ADR 0001 superseded with the shipped singleton model), D4 (the two still-wrong
comments — `beforeAppend`→`validateAppend`, `afterAppendBatch`→`processEventBatch`;
the others were already fixed in earlier stages), D5 (README "Append & subscription
semantics" section).

- [x] **D1 — `design.md` is ~half fossil.** Rewrite or clearly mark
      design-of-record vs abandoned. Concrete divergences from code:
  - offsets are **1-based** (`stream.ts:398`, `core/implementation.ts:109-112`),
    design.md claims 0-based.
  - omitted `replayAfterOffset` **live-tails** (`stream.ts:624`); design.md
    claims it replays from the start.
  - the only supported subscriber is `{type:"callable"}`
    (`core/contract.ts:19-23`); design.md documents the dropped `built-in` /
    `external-url` shapes.
  - storage is **SQL + JS chunking** (`stream.ts:92-117, 25-28`); design.md
    claims async KV with `allowUnconfirmed`.
  - the processor model is the `StreamProcessor` **class**; design.md's "Resolved
    decisions" section describes a never-built `implementProcessor` /
    `afterAppend` split.
  - tech is `@journeyapps/wa-sqlite` + OPFS + `BroadcastChannel`, not "SQLocal".
- [x] **D2 — `README.md` code snippet is broken:** imports `connectStream`
      (doesn't exist) — the real export is `withStreamConnectionFromBrowser`
      (`browser/connect.ts:10`), and the connection is sync-`Disposable`, not
      `AsyncDisposable`. Fix the snippet and the stale route map (`/streams` uses
      a `?path=` search param; there is no `/streams/$splat`).
- [x] **D3 — ADR 0001 contradicts the code** (claims per-view runtimes; code uses
      module-level per-(path,slug) singletons in `stream-browser-store.ts:94-139`).
      Supersede or update. _(ADR 0002 is accurate — leave it.)_
- [x] **D4 — Comment drift:** `stream-processor.ts:369` ("batch retries" — see
      C1/C2); `circuit-breaker/contract.ts:5` says `beforeAppend` (it's
      `validateAppend`); `grouping.ts:9,86` say `afterAppendBatch` (it's
      `processEventBatch`); `types.ts:46-48` denies the `eventTypes` filter that
      exists; `event.ts:17-26` documents `source` as supported (see M2).
- [x] **D5 — Document currently-undocumented behaviour:** idempotency-key
      semantics + `offset` precondition, the auto-appended `created`/`woken`
      events (post-Stage-2), the `eventTypes` filter (if kept), relative
      `streamPath` resolution + child-stream announcements, `reset()`, the
      512 KB chunking. `CONTEXT.md` is the most accurate doc — fix only its two
      errors: the Web Lock name is keyed on **slug**
      (`stream-leader.ts:46-53`) not subscription key (H4), and view query-param
      values are full slugs not "stems" (H5).

---

## Suggested PR sequencing

1. **Stage 0** (tests) — merge first; they fail, documenting the bugs.
2. **Stage 1** (C1/C2/C3) — the data-loss + security trio; tests go green.
3. **Stage 2** (lazy init) — owner-requested, biggest `stream.ts` simplification.
4. **Stage 3 + Stage 4** — remaining correctness, can split by reviewer area.
5. **Stage 5/6/7** — perf, cleanup, docs; each independently shippable.

Stages 1–2 are the ones that change durable behaviour; review them hardest.
