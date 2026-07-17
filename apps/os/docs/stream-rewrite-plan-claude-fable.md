<!--
Independent planning artifact generated on 2026-07-17 by Claude Fable at maximum thinking effort.
It received the same frozen evidence brief as the Codex planner and could not read that planner's output.
The body below is Claude's standalone response, with its one-line CLI preamble removed.
-->

# Stream Durable Object — Big Bang Rewrite: Architecture and Implementation Plan

**Context.** The `graceful-snowplow` branch (candidate `0e1e94469`, docs head `f4da96d2c`) carries a proven ~30% aggregate p50/p95/mean improvement over exact main `8a10191f4` [proven: Checkpoint 18, 50 processes, 35,750 host-timed observations; Checkpoints 16–17 independently reproduce the same ~30% central result], but the branch is materially too large: the streams-domain kernel grew from ~5.1k to ~8.2k runtime lines, with dual wake machinery, a cursor row whose `ackedOffset` means three things, twice-parsed control events, and layered fences. The task is one clean rewrite that keeps every proven mechanism and all required correctness, deletes mechanisms rather than repackaging them, and cuts over destructively (erase production Stream data after explicit human sign-off; no migration, no dual kernel, no fallback). The existing `stream-refactor-roadmap.md` is treated as one prior proposal and is challenged below, not followed.

Every performance number in this document is labeled **[proven]** (measured, recorded in the ledger/handoff with lane and method), **[inferred]** (follows from proven measurements but not directly measured), or **[hypothetical]** (unmeasured).

---

## 1. Executive decision and the smallest coherent architecture

**Decision: rewrite the Stream DO kernel only; keep the receiver side and the browser mirror.** The rewrite replaces the DO-side kernel (shell, journal, core fold, frame model, delivery spine, transports, recovery, introspection) in one branch with a one-commit runtime swap and a destructive cutover. It keeps, frozen or lightly trimmed: `StreamProcessorRunner`/registry/keepalive (main's #2002 receiver-owned two-cursor design — the roadmap is right that this is the receiver and should be simplified in place, not replaced), the processor contract DSL, the core contract, schemas, the event selector, `subscriber-math`, `stream-unavailable` (a browser-bundle leaf, not spine code), `cross-post` helpers, and the entire browser mirror under `client-libraries/`.

**The architecture is six owners plus a shell — fewer than the roadmap's ten:**

```
stream-durable-object.ts (shell)  construction, public RPC, the one await-free append turn,
   |                              acceptCrossPost, in-DO waitForEvent, alarm routing
   |-- journal.ts                 SQLite events+chunks+meta: bootstrap, inserts, reads,
   |                              idempotency (+ acknowledged-offset cache), eviction floor,
   |                              atomic replacement
   |-- core.ts                    core contract fold: validateAppend gate, reducer,
   |                              TYPED post-commit deltas, KV checkpoint debounce
   |-- frames.ts                  ONE frame model (live/replay/durable): scan coordinates,
   |                              byte/event caps, exact-type SQL prefilter, condition
   |                              hydration, demand-bound fresh tail (policy-free cache)
   |-- delivery.ts                THE spine: subscriptions rows (cursor store inlined),
   |                              ONE retry/backoff/park machine for wake/push/webhook,
   |                              LiveSession pump (ephemeral + retained wake sinks),
   |                              IdleTeardown, poison isolation, alarm arming
   |-- transports.ts              RPC quarantine: itx-expression dial, stub retention and
   |                              disposal, windowed settlement pulls, webhook fetch,
   |                              CLASSIFIED outcomes (no raw exception telemetry)
   `-- recovery.ts                paged export, strict validation, atomic restore,
                                  persisted generation fence
   (+ introspection.ts            runtimeState, counters, latency rings, ping sampling)
```

Key structural bets, each grounded in evidence below: **(a)** one delivery machine for all three durable modes — wake's poke is the machine's dial step and its watermark is a mode-specific settle, eliminating the current split between the live pump and the poke/watermark/reconcile machine; **(b)** subscription **facts stay the configuration truth** and rows stay runtime bookkeeping (explicitly rejecting the transactional-outbox spike's config-projection columns, which came with a 23.7% singleton append regression [proven, local]); **(c)** the reducer emits **typed post-commit deltas** so control events are parsed once (the one clarity change both redesign spikes converged on); **(d)** the append hot path is preserved **shape-for-shape from the candidate** — the three whole-kernel redesign spikes all regressed singleton append (−10.8% to −23.7% [proven, local]), so the rewrite collapses coordination around the proven append turn instead of inventing a new one.

Where this challenges the roadmap: no `TailWindow` module (demand-bound payload ownership is a rule enforced inside `frames.ts` + demand-counting in `delivery.ts`, not an owner); no `AppendKernel`/`CoreProjection` split (one `core.ts`; the shell orchestrates the turn); no separate `CursorStore` boundary (inlined — the extraction was measured at +5 lines and neutral [proven]; as a public boundary it invites verb proliferation); `LiveSessions`/`ProcessorLinks`/`DurableOutbox` collapse into one `delivery.ts` because they are one machine with mode-specific dial/settle, not three; the packed activation KV record is **not** adopted (its own gate — ≥5% cold-suite win — was never met; ceiling 0.26–0.28 ms [proven]); the integrated sparse scan+claim is **explicitly deferred** to a post-cutover isolated experiment rather than left ambiguous.

---

## 2. Evidence ledger

### 2.1 Proven mechanisms retained (each has a named home)

| Mechanism                                                                                                                      | Evidence                                                                                                                                                                                                            | Home                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| No-result append acknowledgement; result serialization only on request                                                         | 1 KiB ack-only append 65.56% faster p50 vs main [proven, local checkpoint 18]                                                                                                                                       | shell + `rpc-types` union                           |
| Synchronous await-free append turn (validate → offsets → reduce → insert), output-gated                                        | foundation of every cumulative checkpoint [proven]                                                                                                                                                                  | shell + `journal.ts` + `core.ts`                    |
| 1 MiB inline / 512 KiB chunk ceiling                                                                                           | 768 KiB append 20.5% p50 faster; point/range read 66% faster [proven, sqlite+workers]; 50.05% p50 on 768 KiB lane at checkpoint 18 [proven]                                                                         | `journal.ts`                                        |
| Derived-metadata homogeneous keyless batch insert                                                                              | 34-event 6.6%/500-event 5.9% p50 faster, all rounds [proven, local workers]                                                                                                                                         | `journal.ts`                                        |
| Acknowledged-idempotency offset cache + full logical-identity compare on hit                                                   | cross-post retry 14.0% p50 faster, 16.3% throughput [proven]; identity compare is the preview-9 idempotency-loss fix [proven correctness]                                                                           | `journal.ts`                                        |
| Exact cross-post delivery-identity ack cache                                                                                   | 8,000-event redelivery 57.3% p50 faster, 2.34x throughput [proven, local workers]                                                                                                                                   | shell (`acceptCrossPost`)                           |
| Selection before hydration/RPC (exact-type SQL prefilter; byte lengths only for matches)                                       | sparse push frames 7.0% p50 / 30.5% p95 workers, 85.5% p50 on chunked host lane [proven]                                                                                                                            | `frames.ts`                                         |
| Scan-coordinate frames (`scannedAfterOffset`/`scannedThroughOffset`/`streamMaxOffset`) advancing cursors through selector gaps | integrated runner gate, part of the ~30% [proven]; runner-side contract live on main                                                                                                                                | `frames.ts` + `delivery.ts`                         |
| Demand-bound fresh-tail payload ownership                                                                                      | replay 31.8%/47.8% p50/p95 faster with 10.76% less post-GC heap vs unconditional retention (+58.6% heap, rejected) [proven]                                                                                         | `frames.ts` (cache) + `delivery.ts` (demand counts) |
| Fresh retained-tail ascending reads when provably complete                                                                     | 500×4 KiB read 12.2%/31% p50/p95 faster [proven, local workers]                                                                                                                                                     | `frames.ts`                                         |
| Bounded private batch RPC behind public singular `processEvent`                                                                | one-per-event wire RPC 7.07x slower p50 / 8.25x p95 on 25×3,840 B PCM frames (69.015 ms vs 488.241 ms) [proven, deployed]; public singular adapter parity when the wire stays batched [proven, deployed, 480 pairs] | `transports.ts` + SDK adapter                       |
| Awaiting each durable callback promise before frame ack                                                                        | discarded-promise variant lost durable completion [proven, deployed]                                                                                                                                                | `delivery.ts`                                       |
| Windowed hosted-processor settlement (pull every 8th + caught-up fence)                                                        | 9.7% p50, 10.7% throughput [proven, local workers]                                                                                                                                                                  | `transports.ts`                                     |
| Output-gated exact durable claims before dial                                                                                  | correctness foundation; crash-safe redelivery [proven by fault tests + deployed matrix]                                                                                                                             | `delivery.ts`                                       |
| Deferred quiet-tail acks (staged, checkpointed atomically with next claim; ≤1 frame lag)                                       | 7.9% p50, 8.6% throughput [proven, local workers]                                                                                                                                                                   | `delivery.ts`                                       |
| Durable alarms = f(rows) with parked/in-flight exclusions and deadline clamps                                                  | prevents both dead retries and alarm hot loops (per-parked-row permanent alarm is a documented failure mode) [proven correctness]                                                                                   | `delivery.ts`                                       |
| Activation checkpoint discipline (flush caught-up state once, fresh 64-event/1 s debounce)                                     | forced-reactivation 7.45%/5.82%/4.56% p50/p95/mean, 1,500 samples/arm [proven, clean A/B]                                                                                                                           | `core.ts`                                           |
| Raw synchronous SQLite for cursor ops                                                                                          | sparse cross-post 11.6%/14.3% faster, −104 lines [proven]                                                                                                                                                           | `delivery.ts`                                       |
| Immediate processor redial after eviction; receiver-unavailable classified to backoff (never poison)                           | retained lanes [proven]; poison-vs-unavailable split is a shipped correctness rule                                                                                                                                  | `delivery.ts` + `transports.ts`                     |
| Deployed acceptance shape                                                                                                      | 37 deployed tests + 1 skip, 336.38 s, zero retries; live callback p50 238.2 ms / p95 498.4 ms (20 samples, host clock) [proven, deployed preview_9]                                                                 | oracle (§10)                                        |

### 2.2 Rejected mechanisms (do not restart without a new mechanism)

Per-event wire RPC (7.07x [proven, deployed]); legacy DO KV journal in both sync and async forms (0.9–35.9% slower across lanes [proven]); generic append coalescing/actor queue (burst wins, 8.8–16.3% singleton tax [proven]); WebSocket frame coalescing (singleton floor +17.5–33% [proven]); generic RPC expression flattening (point estimates positive, 95% CI crosses zero, telemetry not attributable — **held** outside shipping [proven-inconclusive]); synchronous capability-returning `get()` (51/58 calls still exception-classed [proven, deployed]); one-capability delivery session objects (−8% to −13% [proven]); column-owned envelope schema (lost the deployed gate [proven]); insert-first idempotent append (8.8–15% slower [proven]); packed keyless `json_each` insert; single-type SQL predicate; split checkpoint cadence (dirty-cold p95 −76.6% [proven]); kv.list activation snapshot; direct cross-post dial + stub cache; larger hosted-processor frames; exact-type wake preselection; source-side acknowledgement of reentrant cross-post cycles (deadlocked [proven, deployed]); stateful Worker-entrypoint callbacks (instances do not persist across RPC requests [proven]); whole-kernel replacement by any of the three spikes (each regressed singleton append [proven, local]).

### 2.3 Unproven hypotheses (deferred, not designed in)

Integrated sparse scan+claim as one SQL operation (55.0% local lane win in the outbox spike [proven locally, unproven deployed]; deferred to post-cutover isolated worktree with deployed sparse/dense/singleton/poison/recovery gates); keyed homogeneous insert (14–17.5% host-SQLite write-stage only [proven host-only]); packed single activation KV record (0.26–0.28 ms ceiling [proven], gate never met); this plan's line budgets (§8) [inferred from measured decomposition of current files]; webhook claim unification cost "+1 row write per event is noise against an HTTP POST" [inferred].

---

## 3. Exact external contract

**Public conceptual surface (itx projection + generated contract): exactly four verbs plus admin.**

```ts
// One append. Default result: durable acknowledgement, nothing serialized.
append(...events: StreamEventInput[]): Promise<void>
append({ return: "offsets" }, ...events): Promise<number[]>        // input-aligned
append({ return: "events"  }, ...events): Promise<StreamEvent[]>   // committed envelopes
// One wire union (Cap'n Web cannot project overloads); shared helpers narrow.

subscribe(opts: {
  selector?: EventSelector;              // {eventTypes?, condition?} — the one filter shape
  replayAfterOffset?: number;            // durable rows only; min-member checkpoint for the mirror
  expectedIncarnation?: string;          // mirror incarnation fence
  maxReplayOffsetGap?: number;           // client-paced flow control trigger
  events?: boolean;                      // false = state-only sessions
  processEvent: (event: StreamEvent) => unknown;   // THE public callback
}): Promise<SubscriptionHandle>          // { unsubscribe() }

getEvents(opts?: { afterOffset?, beforeOffset?, eventTypes?, limit?, includeEphemeral?, order? }): Promise<StreamEvent[]>
getEvent(ref: { offset } | { idempotencyKey }): Promise<StreamEvent | undefined>
head(): Promise<StreamHead>              // { createdAt?, maxOffset } — compact liveness read

waitForEvent(opts): Promise<StreamEvent> // in-DO, NON-durable: dies with the incarnation and
                                         // rejects with the `stream-unavailable:` tag (frozen
                                         // e2e contract; clients retry)
```

**Behavioral clauses that are part of the contract:** durable subscriptions are _data_ (`stream/subscription-configured`, latest per key wins; `-removed` revokes); delivery is at-least-once with `${event.path}@${event.offset}` as the receiver idempotency idiom; ephemeral events are second-class rows (excluded from range reads unless `includeEphemeral`, never delivered durably, skip-not-defer); cross-posted copies of `stream/*` control facts are stored but INERT; `subscribe` over-delivery is free (receivers dedupe on their own cursor); append acknowledges when the journal write is durable and **never** awaits delivery.

**Private (transport details, not public API):** raw DO methods `appendAck`/`appendOffsets` (result-mode specializations that let hot callers skip the options envelope — kept because no-result append is a proven win, but absent from the generated public contract, pinned by a security e2e, §10); the batched wire envelope (`StreamEventBatch`, scan coordinates, private frame caps); the wake poke handshake (`wakeStreamSubscriber → {checkpointOffset, sink, subscriber, getRuntimeState}` — trusted-internal); webhook wire shape; recovery export/restore admin verbs; `runtimeState()` introspection.

---

## 4. Ownership model

| Concern                                                                     | Owner                                                    | Notes                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal (events, chunks, idempotency, floor, replacement, schema bootstrap) | `journal.ts`                                             | Sole SQL writer for its tables; exposes typed operations, never SQL. The acknowledged-offset cache lives here so eviction can invalidate it atomically.                                                                                                                    |
| Core projection (validate gate, fold, checkpoint, typed deltas)             | `core.ts`                                                | Parses control events **once** in the reducer; emits `CoreDelta` values (subscription configured/removed/seek, park/resume, pause, presence) consumed post-commit by `delivery.ts`. Owns the KV `{state, version}` checkpoint debounce and the activation flush-once rule. |
| Ephemeral sessions (browser tails, waitForEvent, tests)                     | `delivery.ts` (LiveSession)                              | In-memory only; zero storage calls from the pump; results disposed unpulled.                                                                                                                                                                                               |
| Processor links (wake)                                                      | `delivery.ts` (same spine) + receiver-side runner (kept) | Stream persists watermark + retry state only; the **receiver's durable checkpoint is the one cursor** [proven design, kept from main #2002].                                                                                                                               |
| Durable push/outbox (push, webhook, cross-post feed)                        | `delivery.ts`                                            | Stream-owned authoritative cursor; exact claim persisted before dial; deferred quiet-tail acks.                                                                                                                                                                            |
| Waiters                                                                     | shell                                                    | In-DO `waitForEvent` rides a LiveSession; non-durable by contract. `wait-for-stream-event.ts` (180 lines, zero production importers — dead code) is **deleted**.                                                                                                           |
| Recovery                                                                    | `recovery.ts`                                            | Cold admin path; export incarnation checks, atomic restore, persisted generation bump; adds no branches to append/pump beyond one lifecycle token captured at async boundaries.                                                                                            |
| Transports                                                                  | `transports.ts`                                          | The only module that touches stubs, expressions, fetch. Retention/disposal, windowed settlement, outcome classification. The browser-facing `stream-unavailable.ts` leaf stays separate (imported by the browser bundle; must not drag delivery code in).                  |
| Speculative payload memory                                                  | `frames.ts`                                              | The fresh tail is a bounded cache keyed by exact scan coordinates; `delivery.ts` owns demand counts and release calls. One owner for "who may hold parsed payloads without demand: nobody".                                                                                |

Exactly one authoritative progress owner per mode: ephemeral → client memory; wake → receiver checkpoint (stream row is an observational watermark); push/webhook → stream cursor row.

---

## 5. SQLite schema and transaction boundaries

Schema **v9**, fresh and destructive (no migration path by policy). Four tables, two KV records.

```sql
create table stream_meta (
  singleton            integer primary key check (singleton = 1),
  version              integer not null,          -- 9
  generation           integer not null,          -- journal incarnation; bumped by restore/replace
  evicted_offset_floor integer not null,          -- highest offset whose row was evicted
  max_epoch            integer not null           -- monotonic epoch allocator floor (survives restore)
);

create table events (
  offset                   integer primary key,   -- explicit allocation; NO AUTOINCREMENT
  type                     text not null,
  idempotency_key          text,
  ephemeral                integer not null default 0,
  event_json               blob,                  -- full envelope JSON, <= 1 MiB inline
  chunked_json_byte_length integer                -- set iff event_json is null (chunked)
);
create unique index events_idempotency_key on events(idempotency_key)
  where idempotency_key is not null;

create table event_chunks (
  offset      integer not null,
  chunk_index integer not null,
  chunk_bytes blob not null,                      -- 512 KiB pieces
  primary key (offset, chunk_index)
) without rowid;

create table subscriptions (
  subscription_key        text primary key,
  acked_offset            integer not null default 0 check (acked_offset >= 0),
  epoch                   integer not null,       -- fence: bumped by seek AND by every configure
  attempt                 integer not null default 0 check (attempt >= 0),
  next_attempt_at         integer,
  last_error              text,
  -- exact durable claim: owned-cursor modes only; never written for wake rows
  claim_through_offset    integer,
  claim_stream_max_offset integer,
  claim_attempt           integer,
  claim_recovery_at       integer,
  check ((claim_through_offset is null) = (claim_stream_max_offset is null)),
  check ((claim_through_offset is null) = (claim_attempt is null)),
  check (claim_recovery_at is null or claim_through_offset is not null),
  check (claim_through_offset is null or claim_through_offset > acked_offset),
  check (claim_stream_max_offset is null or claim_stream_max_offset >= claim_through_offset)
) without rowid;
create index subscriptions_alarm on subscriptions (next_attempt_at, claim_recovery_at);
```

Deliberate schema decisions: **no `status` column** (parked lives in the fold as `parkedAtOffset`; a row status would be a second truth to reconcile after every KV-loss rebuild); **no `mode` column** (mode derives from folded config; every configure clears claims in the same synchronous turn); **no `claim_after_offset`** (a claim atomically checkpoints the prior staged ack into `acked_offset`, so after == acked at claim time by construction); `max_epoch` in meta fixes the restore/epoch-collision hole: epochs are allocated as `max_epoch + 1` and persisted with the bump, monotonic across restores.

**KV records (two, not packed):** `canonical-name` (immutable identity; must never share a write with a churning record) and `coreState` (`{state, version}` packed checkpoint — disposable cache, rebuilt by folding the log on version skew or absence).

**Chunking and size ceilings.** Serialized envelope ≤ 1 MiB stays inline; larger spills to 512 KiB chunks; at most one chunked event per variadic batch (kept rule). **New:** `validateAppend` rejects any single serialized event above a hard ceiling (constant, 8 MiB) — today nothing prevents committing an event too large for any transport (~32 MiB Cap'n Web ceiling), which would be undeliverable on every lane and unexportable, i.e. a poison commit. Synchronous rejection replaces a latent unrecoverable state.

**Idempotency.** Partial unique index is the truth. Probe order on append: in-memory acknowledged-offset cache (bounded: 128 keys, 2,048 code units) → indexed SQL probe → on hit, hydrate and compare full logical identity (type, payload, metadata, ephemerality; provenance excluded) — conflicting payload under a reused key rejects the whole append before any write [proven correctness fix, preview-9]. Cache hits whose row was legally evicted degrade to the SQL probe (miss), never throw; the throw is reserved for a dangling key pointing at a _durable_ offset (real corruption).

**Cursors/claims.** `acked_offset` is exclusive progress: authoritative for push/webhook, observational watermark for wake. Claims persist the exact frame boundary + observed head + attempt + recovery deadline before the dial leaves, under the output gate. Store verbs are mode-explicit: `claimFrame`/`settleAck`/`skip` (owned-cursor modes) vs `observeCheckpoint` (wake; progress clears failure state, a no-progress poke clears the schedule but keeps the failure streak). Staged (quiet-tail) progress is epoch-stamped, ≤ 1 frame deep, flushed by: the next claim (atomically), any nack (before failure is recorded), alarm fire, idle teardown, and recovery reset (discarded, not flushed).

**Retention/floor.** Durable rows are never deleted outside recovery replacement. Ephemeral rows carry a pre-paid eviction license: `evictEphemeralThrough(offset)` (single synchronous operation) deletes rows, advances `evicted_offset_floor`, and invalidates the acknowledged-offset cache for swept keys; the allocator reads `max(maxOffset, floor)`; post-sweep rebuild counts surviving rows only (`eventCount` may decrease; never compared to `maxOffset`); birth detection keys on durable evidence (existence of `created@1` / meta row), never on folded counters. The sweep itself is deferred (§12); the API contract is day-one.

**Alarms.** One DO alarm. Target = min over (eligible `next_attempt_at` for rows neither parked-in-fold nor in-flight; `claim_recovery_at`, clamped for in-flight dials to `now + DELIVERY_TIMEOUT`). Arming is earlier-only in-memory; the full rescan lives on the alarm path; parking clears the row's schedule in the same turn (else: permanent per-parked-row alarm hot loop — a documented failure mode). Implemented as one named, table-tested pure function.

**Generation fences.** `stream_meta.generation` is bumped inside the restore transaction; all in-memory machinery (sessions, tasks, staged progress, retained frames, idle timer) holds the generation it was born under and goes inert on mismatch. Row `epoch` fences per-subscription staleness; **every** `subscription-configured` bumps epoch (not just seeks), which deletes the candidate's three overlapping config fences (config-offset fence, zero-read fence, delivery-row config check) at the accepted cost of one redelivered batch per config replacement (at-least-once).

**Transaction boundaries (all synchronous, output-gated):**

1. _Append turn:_ parse/validate → idempotency probe → offset assignment → fold (+ typed deltas) → `events`(+`event_chunks`) insert (single statement ≤ 33 keyless rows; derived-metadata `insert…select` for homogeneous keyless 34–8,000; `transactionSync` for mixed/chunked) → cache updates. The RPC result releases when the output gate confirms durability.
2. _Claim:_ one `UPDATE` writing claim columns + carrying staged ack into `acked_offset`.
3. _Settle/nack/skip/seek/configure:_ one write each; nack flushes staged progress first; configure/seek bump `epoch` and `max_epoch` and clear claims.
4. _Restore:_ one transaction — replace `events`+`event_chunks`, rewrite `stream_meta` (generation+1, floor, `max_epoch` preserved or raised), delete all `subscriptions` rows, write KV `coreState` — then (same turn, before yielding) discard staged progress, close sessions with `recordFact=false`, bump the in-memory generation; then append a fresh `woken` fact, whose reconcile re-establishes rows from folded config.
5. _Schema bootstrap:_ all DDL in one `transactionSync`. Policy: missing marker with partial Stream-owned tables → drop and recreate (interrupted first activation); **any non-v9 version marker → drop and recreate** (destructive doctrine made self-consistent — the candidate's "throw forever on unknown version" would brick every stream the cutover erase misses); SQL failure after the marker exists → rethrow as corruption.

---

## 6. Flows

**Append.** One synchronous turn (§5.1). Ordinary contiguous events fold as one run, flushed before every control event so validation observes exact event-by-event state; offset assertions are stripped from bodies before contract parsing and checked against both idempotency hits and fresh offsets; one `createdAt` per batch; same-batch duplicate key with identical body → skipped with input-aligned result, with different body → whole append rejects before any write. Post-commit (fire-and-forget, cannot fail the append): typed deltas applied to `delivery.ts` (row ensure/seek/park/resume), subscriber pumps woken with the fresh tail, idle timer re-armed, checkpoint debounce ticked. **Kernel law (recursive-bootstrap lesson): the append result is durability of the journal write and nothing else; no inbound path may await delivery settlement.** Readiness barriers over processing are receiver-side utilities (runner `waitUntilProcessed`), never append semantics.

**Read.** `getEvents` filters ephemeral by default, supports type filter/order/limit; ascending reads within the retained fresh tail are served from it only when provably complete (lower bound inside window, no gaps) [proven win]; point reads always return ephemeral rows.

**Subscribe (ephemeral).** LiveSession opens at `replayAfterOffset` (durable rows only during catch-up; ephemeral rows only if appended after this session opened), pumps to head, then rides the live tail. Zero storage calls; batch results disposed unpulled → zero subscriber-originated return frames [proven wire property, pinned by `stream-wire.e2e`]. Configured (wake) sessions additionally deliver **empty scan-coordinate envelopes** through sparse gaps (bounded page coalescing) so at-head reconciliation fires without events.

**Durable delivery/ack.** Per key, single-flight `DeliveryTask`: due → build frame (`frames.ts`, selector-aware, byte/event-capped, first selected event always included even if over-cap) → mode dial:

- _wake:_ evaluate poke expression → `{checkpointOffset, sink}`; retain sink (LiveSession from `checkpointOffset+1`); watermark via `observeCheckpoint`; results pulled windowed (every 8th + caught-up fence) purely as the dead-connection signal.
- _push:_ claim frame (output-gated) → evaluate expression → one awaited batch call → `settleAck` (or staged for quiet tails).
- _webhook:_ same claim machinery pinned to frame=1, one `fetch` POST per event, 2xx is the ack.

Failure classification in `transports.ts`: `receiver-unavailable` → backoff lane (never poison); rejection → attempt++ with jittered exponential backoff (min(30 m, 1 s·2^n) ± 20%), park fact at the attempt ceiling; `onPoison: "skip"` isolates via bisection (confirm attempts, consecutive-skip cap, `error-occurred` audit fact per skipped offset). A paused destination must not poison-skip healthy events (kept rule). Task exit is generation-checked: a drain exits only having observed a head ≥ every commit, else it loops (drain-exit finality).

**Eviction/reactivation.** Constructor: load KV checkpoint (rebuild by folding the log on skew/absence), reconcile subscription rows against folded config (delete orphans, clear stale failure state), re-arm the alarm from durable rows, flush caught-up checkpoint once and start a fresh debounce window [proven activation discipline], append `woken`. `woken` bumps head → reconcile re-pokes lagging wake rows → hosts replay from their checkpoints. Idle teardown (in-memory timer — never an alarm; retained stubs die with the incarnation anyway): sever idle durable connections, suppress reconcile for the teardown turn, append disconnect facts, pre-advance non-wedged wake watermarks past its own facts (wedged keys — delivered-but-unsettled — skip the ack and re-poke), flush cursors + checkpoint.

**waitForEvent.** In-DO predicate wait on a LiveSession; timeout via timer (approximate is fine — elapsed local time is never a progress proof); DO death mid-wait rejects with the `stream-unavailable:` tag and clients retry (frozen contract).

**Recovery.** Export: byte-capped pages (1 MiB soft, single-event exception) of the journal with `throughOffset` + floor, birth-certificate validated. Restore: §5.4. In-flight claims/pokes/staged acks from the pre-restore world are fenced by generation + epoch monotonicity and cannot mutate the restored world.

**Cross-post.** `acceptCrossPost` **returns after its own synchronous append** (+ ack-only path + exact-retry identity cache [proven]); its own fan-out is background. Settlement windows apply to outbound dials only — an inbound sink call never waits on outbound settle capacity (this is the structural guarantee that A↔B cycles cannot deadlock; source-side acknowledgement of reentrant cycles was tried and deadlocked [proven, deployed]). Provenance chain (cap 5, self-on-chain rejection) makes loops structurally impossible; copied `stream/*` control facts stay INERT, enforced at all three layers (validate, reduce, effect) — typed deltas must not collapse those guards into one.

---

## 7. State machines and invariants

**Eight machines total (meets the ≤8 gate), six kernel-side:**

1. **SubscriptionRow** (durable, per key): `idle-caught-up | due | backoff | claimed-in-flight` (owned modes). Verbs: ensure, configure (epoch-bump, claim-clear), seek (epoch-bump), claimFrame, settleAck (immediate|staged), skip, observeCheckpoint, nack, park (fact + schedule clear), resume (fact), delete, reconcileAfterRebuild. _Parked is fold state, not row state._
2. **DeliveryTask** (in-memory, per key, single-flight; replaces today's separate poke and drain reservations): `idle → dialing → settling → loop | exit`, generation-checked exit.
3. **LiveSession** (in-memory pump, ephemeral + retained wake sinks): `opening → pumping ⇄ caught-up → closed(reason)`; storage-free; mode parameters (durableOnly, historical-ephemeral filter, empty-envelope delivery for configured sinks, settle observer).
4. **IdleTeardown** (singleton): `disarmed → armed(deadline) → firing(reconcile-suppressed) → disarmed`.
5. **CheckpointDebounce** (`core.ts`): `clean → dirty(count,deadline) → flushing`; activation flush-once.
6. **RecoveryLifecycle**: `live(generation g) → replacing → live(g+1)`; export sessions are bounded iterators, not a machine.
   7–8. _(receiver-side, kept from main)_ Runner two-cursor progress; processor keepalive/revival.

**Derived, never persisted:** parked (fold), mode (fold config), presence roster (fold of connect/disconnect facts, cleared by `woken`), alarm target (pure function of rows), fresh tail (cache), demand counts (in-memory), core state itself (KV checkpoint is a disposable cache over the log).

**Invariants (the INVARIANTS.md content, enforced by tests §10):**

- I1 Offsets are contiguous, assigned once, never reused across eviction or recovery (allocator ≥ floor; restore validates strictly increasing offsets).
- I2 Variadic append is all-or-nothing; results input-aligned; committed state ≡ event-by-event reference fold.
- I3 An append is acknowledged iff its journal write is durable (output gate); acknowledgement never depends on delivery or downstream processors.
- I4 Exactly one authoritative progress owner per mode; the LiveSession pump makes zero storage writes; wake watermarks advance only from receiver checkpoints or clean-teardown pre-advance.
- I5 A claim is durable before its dial leaves; crash replay redelivers each frame ≥1 and ≤2 times; attempt counters are monotone across reclaims (`max(claim_attempt, attempt)+1`).
- I6 Staged progress is ≤1 frame deep, epoch-stamped, and flushed before any durable failure write.
- I7 Epoch/generation fences: no settle, ack, watermark, or retained frame born under an old epoch/generation can mutate newer state; every configure/seek bumps epoch; restore bumps generation and preserves epoch monotonicity (`max_epoch`).
- I8 Selector progress is live: any selector (including never-matching and throwing conditions) reaches head with bounded reads; scanned-through advances cursors across gaps; an event-less frame that reaches head is still delivered to configured sinks (at-head reconcile pulse).
- I9 Poison isolation is exact: bisection isolates exactly the poison offset; healthy neighbors deliver in order; skips append audit facts; parked rows arm no alarms.
- I10 Bounded memory: parsed payloads are retained only under live demand; frame byte/event caps hold except the single first-selected oversized event; append rejects events above the hard size ceiling.
- I11 No correctness decision uses elapsed isolate time; timers may be late; retries/recovery are alarm-and-row driven.
- I12 Failures are classified at the transport boundary; expected outcomes never surface as raw exception telemetry; every skipped/parked/errored offset is observable (fact or classified span).

---

## 8. Module layout, deletion list, and line budgets

Dependency direction (strict, enforceable by lint): `schemas ← journal ← core ← frames ← delivery ← shell`; `transports ← delivery` (interface: `SubscriberDial` + classified outcomes); `recovery ← journal/core`; `introspection` leafs off delivery/shell; nothing imports the shell.

**Replaced surface (candidate `0e1e94469` worktree, non-test lines) → new:**

| Current file                                                                          |     Lines | Fate                                                                              | New module                                          |           Budget |
| ------------------------------------------------------------------------------------- | --------: | --------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------: |
| stream-durable-object.ts                                                              |     1,834 | rewritten                                                                         | shell (same filename)                               |              700 |
| stream-storage.ts                                                                     |     1,118 | split                                                                             | journal.ts (events side + ack cache + eviction API) |              850 |
| stream-subscribers.ts                                                                 |     2,176 | rewritten                                                                         | delivery.ts (spine + sessions + teardown)           |            1,450 |
| subscription-cursor-store.ts                                                          |       643 | inlined                                                                           | → delivery.ts                                       |                — |
| stream-delivery-frame-reader.ts                                                       |       433 | rewritten                                                                         | frames.ts                                           |              500 |
| subscriber-sinks.ts                                                                   |       510 | rewritten                                                                         | transports.ts                                       |              480 |
| stream-runtime-metrics.ts + subscriber-metrics.ts                                     |       357 | merged                                                                            | introspection.ts                                    |              250 |
| stream-event-validation.ts + stream-ordinary-event-run.ts + stream-core-checkpoint.ts |       366 | folded                                                                            | → core.ts (with reducer/effects from the DO)        |              650 |
| acknowledged-idempotency-offset-cache.ts                                              |        83 | folded                                                                            | → journal.ts                                        |                — |
| wait-for-stream-event.ts                                                              |       180 | **deleted** (zero production importers; contradicts the frozen kill-tag contract) | —                                                   |                0 |
| recovery.ts (+ DO export/restore bodies ~200)                                         |       112 | rewritten                                                                         | recovery.ts                                         |              260 |
| rpc-types.ts                                                                          |       395 | slimmed                                                                           | rpc-types.ts                                        |              300 |
| **Replaced total**                                                                    | **8,207** |                                                                                   | **New kernel total**                                | **5,440 (−34%)** |

**Kept as-is (leaves):** schemas 112, event-selector 133, subscriber-math 111 (pure, table-tested — inlining buys nothing), stream-unavailable 67 (browser-bundle leaf), utils 82, cross-post 154 → 659. **Kept receiver side:** core-processor-contract 806, processor-contracts 718, stream-processor 594, runner 1,178, registry 591, keepalive 337, host-capabilities 96 → 4,320 (in-place trim of ~200–300 [inferred] via typed frame reuse; not counted in the budget). Browser mirror untouched.

**Honest totals** (recount reproducibly at slice 0 — the roadmap explicitly warns against stale baselines): domain runtime ≈ **10.4k** vs candidate **13.4k (−22%)** vs main ≈ **10.15k (≈ parity, +2–3%)** — while carrying the candidate's ~30% [proven] performance, the claim/scan-coordinate/recovery machinery main lacks, and the v8-era correctness fixes. Against the roadmap's own gates: eight-file core set 8,437 → **5,440 (−36%)**; delivery-coordination lines 3,873 → **~2,790 (beats the 3,300–3,600 gate)**; private members ~88 → **≤45**; explicit machines ~13 → **8**. Test budget: ~9.5k lines (port-verbatim e2e + rewritten module tests) vs candidate 11.5k.

**Why it is smaller (mechanism deletions, not renames):** one delivery machine instead of pump+poke/watermark/reconcile duals; one reservation set instead of `#pokesInFlight`+`#pushDrains`; three config fences collapsed into epoch-always-bumps; `DEFER_RECONCILE` option deleted (typed deltas leave one post-commit reconcile); control events parsed once (five re-parse sites deleted); cursor-store public boundary deleted; dead waiter deleted; two metrics modules merged; micro-files folded into their owners (files ≠ owners); comment density normalized (the candidate's 38% comment share in the spine reflects accreted caveats the collapse makes unnecessary — [inferred] ~350–450 lines).

---

## 9. Build sequence — vertical slices, one Big Bang cutover

Rule that reconciles "testable slices" with "no dual kernel": **new modules land dark with their tests (they execute for real under vitest-pool-workers/workerd), the runtime swap is exactly one commit, and the old kernel stays fully green until that commit and is deleted in it.** No hybrid wiring (new journal under old subscribers) at any point — that would be the forbidden dual kernel and would create untested states.

- **Slice 0 — freeze the seams and the oracle.** Freeze `rpc-types.ts` field names (frame coordinates, batch envelopes, subscribe args including `expectedIncarnation`/`maxReplayOffsetGap`/`events:false`), `schemas.ts`, `event-selector.ts`, `core-processor-contract.ts`; regenerate the itx contract once. Commit the port-verbatim test list (§10) and INVARIANTS.md. Take the per-fingerprint telemetry classification snapshot on the deployed candidate (without it, "no unexplained errors" is undecidable post-cutover). Run the minimal capability-vs-plain-data lifecycle probe (decides the wake dial's plan-B, §13). Produce the reproducible line/member/machine recount.
- **Slice 1 — `journal.ts`**: ported storage behavioral tests (chunk boundaries, 100-binding batching, derived-insert alignment, interrupted bootstrap) + P1/P2/P3/P8 + the v9 drop-on-mismatch bootstrap policy.
- **Slice 2 — `core.ts`**: fold parity vs a reference reducer, typed deltas, checkpoint debounce + activation flush-once, breaker/pause re-entrant append arm.
- **Slice 3 — `frames.ts`**: frame tests + the kernel-emits/runner-consumes integration property (real frames into the real runner in workerd — the runner's contract clauses are receiver-enforced and currently tested only against fakes).
- **Slice 4 — `delivery.ts`** (largest risk mass): port `stream-subscribers.test.ts` scenarios one by one (the in-memory-storage + scripted-dial harness pattern is kept), + P4–P7, P9–P11; idle teardown explicitly in scope.
- **Slice 5 — `transports.ts` + `introspection.ts`**: retention/dispose/onRpcBroken, windowed settlement, classified outcomes.
- **Slice 6 — `recovery.ts`**: restore fence tests (P10), export/restore e2e.
- **Slice 7 — the swap commit**: new shell wired; **delete** the entire old kernel file set and `wait-for-stream-event.ts` in the same commit; full local matrix green in that commit.
- **Slice 8 — deployed acceptance**: three-arm comparison (§10), telemetry diff against the slice-0 snapshot.
- **Slice 9 — destructive cutover PR**: erase runbook enumerating every estate (production, preview leases, dev `.wrangler` state, e2e persistent envs), **pre-built and pre-verified rollback binary** (old kernel + one-commit bootstrap change: drop-on-version-mismatch — without it "rollback = erase + redeploy old binary" has no working reverse gear against any v9 database the erase misses), explicit human sign-off; erase + deploy in one controlled operation.

Cross-domain regression watch during slices: project birth certificate ordering (`created(1)/subscription-configured(2)/woken(3)`) and the six-test recursive-bootstrap partial-failure matrix; agent/repo at-head reconcile side effects; browser store subscribe args and the offset-reuse hard abort; ancestor `woken` re-announce staying fire-and-forget (awaiting the parent is a documented reentrant deadlock).

---

## 10. Correctness oracle, tests, benchmarks, acceptance gates

**Port verbatim (frozen matrix — must pass unmodified):** all stream e2e files (`streams.e2e` ephemeral/cross-post contract; `stream-lifecycle.e2e` incl. kill-mid-call `stream-unavailable` tag, born worker feed, idle teardown/re-wake; `stream-wire.e2e` zero-return-frame transport oracle; `stream-ancestor-announcements.e2e`; `stream-recovery.e2e`; `stream-security.e2e`); cross-domain kernel-through-processor tests (project-processor six-test matrix, agent/repo eviction-recovery, scheduler, slack, PR-repro tests); receiver-side unit suites (runner/registry/keepalive); surviving-module tests (selector, validation semantics, recovery, rpc-types, utils, unavailable, ack-cache). **Add one security e2e**: the generated public contract exposes exactly append/subscribe/read/waitForEvent (+admin) and no raw result-mode methods.

**Rewrite per module, carrying every named scenario:** subscribers → delivery tests; cursor-store → row-verb semantic tables; storage → journal; frame-reader → frames; checkpoint tests → core; sinks → transports.

**New property/fault tests (P-series):** P1 offset immutability/non-reuse across eviction+kill+restore; P2 variadic append atomicity fuzz vs reference fold (keyed/keyless/ephemeral/control/oversized/dup-same-body/dup-different-body/offset assertions); P3 rebuild equivalence (fold(log) ≡ incremental state, incl. checkpoint lag + post-eviction gaps); P4 crash-replay bound (kill between claim/dial/settle/stage/flush ⇒ each frame 1–2 deliveries, cursor never regresses, attempts monotone); P5 epoch/seek fence soundness under in-flight deliveries; P6 selector progress liveness (never-matching + throwing conditions reach head, bounded reads, error facts not retry storms); P7 poison bisection exactness; P8 single-oversized-event delivery + append-ceiling rejection; P9 alarm economy (N failing rows ⇒ bounded firings; parked/idle arm nothing); P10 restore fence (in-flight everything cannot touch the restored world; post-restore reconcile re-establishes rows); P11 clock-freeze robustness (frozen injected `now` between I/O ⇒ no spin, no deadlock — the hooks already exist); P12 reentrant A↔B cross-post quiescence (bounded copies, no deadlock, source drain never blocks on destination fan-out); P13 birth exactly-once under concurrent first-touch + kills; P14 fresh-tail read ≡ SQL read (randomized windows/filters).

**Benchmarks.** Local: the workers-side lanes from the ledger (append 1/100/1,000/32-concurrent; dense/sparse/latest/oversized reads; 1/25 live subscribers; dense/sparse durable delivery; replay + post-GC heap; forced reactivation; cross-post dense/sparse/retry). Deployed: `stream-cumulative-benchmark.e2e.test.ts` unchanged — it is already implementation-parameterized (`STREAM_BENCH_IMPLEMENTATION`), host-clocked around awaited RPCs (worker isolate clocks freeze without I/O and are never trusted), fresh-project-per-run (so data erasure never blocks measurement).

**Deployed acceptance — parity vs improvement, staged as three arms** (a main-shaped binary cannot read v9 data and vice versa — both bootstraps reject foreign versions — so there is no shared-data comparison): three leased preview environments running exact `origin/main`, the exact frozen candidate, and the rewrite. Gates: **(a) parity vs candidate** — no meaningful median regression, no p95/p99 regression, on every lane (the bar the rewrite must meet to justify Big Bang); **(b) improvement vs main** — retain ≥25% of the ~30% [proven] aggregate p50 improvement (guards against giving the win back); **(c)** live-callback lane within the recorded deployed band (p50 238.2 ms / p95 498.4 ms [proven]) as a sanity check; **(d)** full 37-test deployed matrix green with zero retries; **(e)** telemetry: no fingerprint absent from the slice-0 classification snapshot; cancellations and expected probes modeled outside error telemetry.

---

## 11. Cost, risks, rollback, stop conditions

**Cost [inferred].** ~5.4k new runtime lines + ~9.5k test lines, of which ~40% is verbatim ports. Nine slices; the dominant one is `delivery.ts`. Rough effort: 2–3 weeks of one focused engineer, or a supervised agent fleet with per-slice review. Compute: three preview leases + benchmark runs of the same class as checkpoints 16–18 (50 processes, ~36k observations) — already-practiced cost.

**Major risks.** (1) `delivery.ts` budget optimism — the measured decomposition says 1,500±150 only with the introspection split; overrun signals a missed mechanism, not a need for more lines. (2) Silent runner-contract drift (empty at-head frames, scanned-through) — mitigated by the slice-3 integration property. (3) Wake-lane subtleties (teardown suppression, wedged-key guard, drain-exit finality) — each is a named invariant with a ported test. (4) Telemetry cleanliness inherited from the baseline (357 `ItxEntrypoint.get` exceptions, 341 R2 probe spans, 49 cancellations on the candidate) — the rewrite narrows capability returns to the wake poke and classifies outcomes at the transport boundary, but the forwarded-session teardown noise is a platform-boundary issue resolved by the slice-0 probe outcome, not by this kernel. (5) Erase completeness — any missed v9/v8 database bricks under the other binary; addressed by the drop-on-mismatch bootstrap (forward) and the rollback binary (reverse).

**Graceful collapse/rollback.** Rollback is: erase all Stream state again + deploy the **pre-built rollback binary** (old kernel + drop-on-version-mismatch bootstrap), verified on a preview before cutover day. Production Stream data is erased only after explicit human sign-off, both directions. No migration shim exists in either direction by design.

**Stop conditions.** Stop and fix ownership (do not add surface) if: the swap-commit branch fails candidate-parity on any proven lane; any P-series property is unimplementable without a new state machine beyond the eight; `delivery.ts` exceeds budget by >25%; the deployed matrix needs retries to pass; telemetry shows any new unexplained fingerprint. Abort the Big Bang (ship the candidate instead) if two consecutive stop conditions fire on the same slice — the candidate is itself a deployable, proven artifact, which is exactly what makes stopping safe.

---

## 12. Highest-value first 100–200 lines

Write the **seam file** first — it de-risks everything else and is reviewable in one sitting:

1. The `subscriptions` DDL + `stream_meta` DDL (§5) with CHECKs and the alarm index (~40 lines).
2. The `SubscriptionRow` verb signatures (ensure/configure/seek/claimFrame/settleAck/skip/observeCheckpoint/nack/park/resume/delete/reconcileAfterRebuild) with one-line semantics each (~35 lines).
3. `computeAlarmTarget(rows, inFlight, now)` as a pure function with the parked/in-flight exclusions and deadline clamp (~25 lines).
4. The append-turn signature chain: `parseAppendInputs → probeIdempotency → assignAndFold (emitting CoreDelta[]) → journal.insert` with the I1–I3 invariants as doc comments (~40 lines).
5. The frame type: `{ events, scannedAfterOffset, scannedThroughOffset, streamMaxOffset }` + the first-selected-always-included rule (~15 lines).

**Deliberately waits:** the ephemeral eviction sweep (API contract day-one, implementation later); webhook claim unification detail tuning; integrated sparse scan+claim (post-cutover isolated worktree, deployed gates); keyed homogeneous insert; packed activation KV record (gate unmet); introspection surface slimming; receiver-side runner trim; any wake-transport change beyond what the slice-0 probe decides.

---

## 13. Open decisions requiring human judgment

1. **Ship-current vs replace-now.** This plan is the replace-now case. The candidate is itself deployable [proven]; choosing it instead means landing `0e1e94469`-shaped code and stopping. The rewrite buys the collapse (−34% kernel, 13→8 machines) at 2–3 weeks and one more destructive cutover of risk.
2. **Wake dial plan-B, pending the slice-0 capability lifecycle probe.** If forwarded capability returns cannot terminate cleanly: options are (a) keep the poke capability and re-classify its teardown spans, (b) operation-specific plain-data poke + host-pushed batches through a stream-side ingress door, (c) fetch-based dial. Each changes the trusted-internal handshake; none changes the public contract.
3. **waitForEvent semantics confirmation:** keep the in-DO non-durable wait with the `stream-unavailable` rejection contract and delete the dead reset-safe waiter — confirm no product need for durable waits at the worker door.
4. **Epoch-bump-on-every-configure** (recommended): accepts one redelivered batch per config replacement to delete three fences.
5. **Webhook claim unification** (recommended): +1 row write per webhook event [inferred: noise vs an HTTP POST] for one delivery code path.
6. **`runtimeState()`/metrics minimum surface** — product question (the real-metrics UI consumes it); budget assumes the surface stays and internals shrink.
7. **Erase/rollback runbook approval**: the estates list, the rollback binary, and the explicit production-erase sign-off (both directions).
8. **Post-cutover experiment queue** (approve as isolated-worktree experiments only): integrated scan+claim (55% local ceiling [proven locally]), keyed insert, packed KV record.
