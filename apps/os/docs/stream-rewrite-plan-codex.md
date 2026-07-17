<!--
Independent planning artifact generated on 2026-07-17 by a Codex subagent at maximum reasoning effort.
It received the same frozen evidence brief as the Claude Fable planner and could not read that planner's output.
The body below is the subagent's standalone response.
-->

# Stream Durable Object Big Bang Rewrite Plan

Performance labels used throughout:

- **Proven**: directly measured or established by source/runtime evidence.
- **Inferred**: follows from evidence but has not been measured in this exact design.
- **Hypothetical**: requires implementation and benchmark validation.

## 1. Executive Decision and Smallest Coherent Architecture

Replace the existing Stream implementation with one synchronous-SQLite kernel, one delivery engine, one processor receiver protocol, and direct typed transports. Do not preserve the current class graph, KV checkpoint projection, generic Itx-expression delivery, returned RPC capabilities, compatibility surfaces, or dual runtime.

The rewrite has four durable owners:

1. **`StreamObject`**
   - Owns the public append/subscribe boundary.
   - Holds activation-local head, live sessions, and a demand-bound fresh tail.
   - Delegates every durable mutation to `StreamSql`.
   - Does not await downstream processor completion.

2. **`StreamSql`**
   - Sole owner of Stream SQLite.
   - Owns journal rows, chunks, normalized control projection, delivery cursors, claims, retry state, recovery staging, retention floor, and generation fences.
   - Exposes synchronous, transaction-shaped operations rather than repositories or cursor abstractions.

3. **`DeliveryEngine`**
   - Owns bounded scans, live delivery, durable outbox delivery, processor-link scheduling, retries, and the single Stream alarm.
   - Uses distinct cursor semantics for processor links and outboxes; it does not hide them behind a generic pump.

4. **`ProcessorReceiver`**
   - Runs at the target processor host.
   - Owns authoritative processor progress, exact pending claims, projection commits, retries, and revival.
   - Commits processor projection and progress atomically.

Two stateless boundaries complete the design:

- **Typed direct transports** return plain structured acknowledgements. They do not return capabilities or interpret arbitrary Itx expressions.
- **Recovery and client utilities** implement cold restore, `read`, and `waitForEvent` without joining the hot kernel.

This is deliberately smaller than the roadmap’s proposed owner graph. `AppendKernel`, `CoreProjection`, `TailWindow`, `CursorStore`, and `ProcessorLinks` do not justify independent stateful abstractions. Their durable state belongs either in `StreamSql` or `ProcessorReceiver`; their activation-local state belongs in `StreamObject` or `DeliveryEngine`.

The journal remains canonical, but normalized control rows are updated atomically with control events. Eliminate the KV core checkpoint, `woken` facts, presence facts, replay-to-reconstruct-hot-state, and checkpoint cadence entirely.

**Proven:** the optimized candidate at `0e1e944699ecfec83a3ed9f73e36389a7934bfea` improved equal-workload aggregate p50/p95/mean by approximately 30.9%/19.6%/28.2% over exact main `8a10191f4d50055f263d61b6acd5c81d4da7013d`; the conservative comparison was 30.7%/29.7%/30.6%.

**Inferred:** retaining no-result append, synchronous SQLite, demand-bound ownership, selection-before-hydration, direct scan coordinates, bounded batching, and disciplined activation work should preserve most of those gains without preserving the candidate’s size.

**Hypothetical:** deleting the checkpoint/replay machinery and capability-returning delivery boundary will reduce activation work and operational errors without creating a new hot-path regression. This requires the acceptance gates in section 10.

---

## 2. Evidence Ledger

### Proven mechanisms to retain

| Mechanism                                         | Qualification                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synchronous SQLite                                | **Proven:** won every serious local and deployed comparison. Legacy DO KV regressed p50 by roughly 2.3%–36.6% across measured lanes and required segmentation, index, chunk, retention, and asynchronous consistency machinery. `storage.sync()` did not recover the loss. |
| One append with default no-result acknowledgement | **Proven:** avoiding response construction and serialization was a primary candidate gain. Keep explicit `offsets` and `events` projections only when requested.                                                                                                           |
| Demand-bound fresh-tail ownership                 | **Proven:** versus main, p50/p95/p99/mean improved 31.8%/47.8%/42.7%/34.8%, with 10.8% lower post-GC heap. Versus unconditional candidate retention, post-GC heap fell 43.8%.                                                                                              |
| Selection before hydration and RPC                | **Proven:** sparse exact-type selection and direct scan coordinates avoid parsing and transmitting rejected rows.                                                                                                                                                          |
| Direct scan progress                              | **Proven:** `scannedAfter`, `scannedThrough`, and `head` are required so selector misses and physically absent ephemeral rows still advance.                                                                                                                               |
| Public singular callback over private batching    | **Proven:** deployed measurements were near-neutral when the public `processEvent(event)` contract was adapted behind one private bounded batch.                                                                                                                           |
| Never one Workers RPC per event                   | **Proven:** the PCM lane measured 69.0 ms batched versus 488.2 ms singular, 7.07x p50 and 8.25x p95, with roughly twice the JS-RPC calls and nearly four times the dynamic Worker calls.                                                                                   |
| Await callback promises before acknowledgement    | **Proven:** deliberately discarding callback promises lost durable completion by iteration 25 of a 60-second test.                                                                                                                                                         |
| Persist exact claim before effect                 | **Proven:** durable push requires an output-gated claim, stable delivery identity, and receiver idempotency.                                                                                                                                                               |
| Activation checkpoint discipline                  | **Proven:** flushing caught-up state once per activation improved pooled p50/p95/mean by 7.45%/5.82%/4.56%. The rewrite retains the discipline by removing lagging checkpoint state rather than carrying it forward.                                                       |
| Bounded chunking                                  | **Proven:** inline payloads must remain at or below 1 MiB, with 512 KiB chunks for oversized events because workerd bindings/cells fail around 2.2 MiB.                                                                                                                    |
| Exact idempotency comparison                      | **Proven:** compact key lookup followed by hydration of actual hits avoids unnecessary parsing while detecting conflicts. Preserve the candidate’s logical equality rules, including deliberate exclusion of processor deployment provenance from retry identity.          |
| Atomic schema bootstrap                           | **Proven:** fresh schema creation must use `transactionSync`. Marker absent permits replacement of partial fresh tables; marker present plus SQL failure is corruption and must be rethrown.                                                                               |
| Offset floor                                      | **Proven:** offsets must never be reused after physical eviction.                                                                                                                                                                                                          |
| Processor cursor/projection atomicity             | **Proven:** the receiver must persist authoritative progress with its projection, keep reducer cache distinct from effect progress, process in order, and reconcile at head even when a frame contains no selected event.                                                  |
| Append/downstream separation                      | **Proven:** recursive project bootstrap deadlocked when append completion waited for downstream processors. Append completion means source durable commit only.                                                                                                            |

### Rejected mechanisms

- **Legacy DO KV and `storage.sync()`**: **Proven rejected** by all serious storage lanes and by added correctness complexity.
- **Generic append coalescing**: **Proven rejected for the generic path** despite burst wins; singleton overhead was approximately 8.8%–16.3% and transaction semantics changed.
- **Generic RPC flattening**: **Unproven and held**. It added 148 lines, confidence intervals crossed zero, one 4.678-second sample reversed the batch mean, and the evaluation emitted 117 exceptions plus 8 cancellations.
- **Synchronous capability-returning Itx `get`**: **Proven rejected**. workerd routes both sync and async JavaScript RPC returns through `js.toPromise`; the sync form did not eliminate exceptions.
- **Actual singular RPC delivery**: **Proven rejected** by the 7.07x PCM regression.
- **Unconditional tail retention**: **Proven rejected** by memory evidence.
- **JSON, columnar, or segmented journal replacements**: **Proven rejected** by local and deployed deep-JSON gates.
- **Direct cross-post dial, exact-type wake preselection, one retained capability session, larger hosted frames, checkpoint cadence 501, KV activation snapshots, insert-first idempotency, and packed JSON insert**: **Proven rejected or held** in the chronology.
- **Source-side acknowledgement of reentrant cross-post cycles**: **Proven rejected** because it deadlocked.
- **Generic receiver credit/pull**: **Proven rejected as the general protocol**. It was approximately 16.9%–23.4% slower locally and turned a singleton from one call/three writes into three calls/seven writes.
- **Discarded callback promises**: **Proven rejected** by lost completion.
- **Stateless Worker-field cursors**: **Proven rejected** because the entrypoint is recreated for each RPC.
- **Production HMR workarounds**: **Rejected by scope**. Vite can overlap old and new objects on one storage instance; local development must restart after Durable Object edits rather than tax production.

### Unproven hypotheses to test

- **Hypothetical:** normalized control rows can replace the KV checkpoint and core replay without regressing append or activation lanes.
- **Hypothetical:** plain-data direct transports can eliminate capability-returning `ItxEntrypoint.get` exceptions and cancellation ambiguity.
- **Hypothetical:** one in-flight private live batch per session provides bounded backpressure while remaining near candidate live-subscription latency.
- **Hypothetical:** persisting one observational processor-link acknowledgement per frame is affordable. It adds a source write absent from some candidate paths.
- **Hypothetical:** removing poison-frame bisection in favor of typed per-event permanent failures reduces code and retry work without weakening required recovery.
- **Hypothetical:** a closed target union covers all required delivery destinations. If arbitrary Itx expressions remain a product requirement, this design must stop rather than grow a compatibility dispatcher.
- **Hypothetical:** omitting the built-in token bucket and retaining only pause plus static append limits is product-correct. This requires human confirmation.

---

## 3. Exact External Contract and Private Details

```ts
type AppendProjection = "offsets" | "events";

interface Stream {
  append(...events: StreamEventInput[]): Promise<void>;

  append(options: { return: "offsets" }, ...events: StreamEventInput[]): Promise<number[]>;

  append(options: { return: "events" }, ...events: StreamEventInput[]): Promise<StreamEvent[]>;

  subscribe(options: {
    afterOffset?: number;
    selector?: StreamSelector;
    expectedGeneration?: number;
    processEvent(event: StreamEvent): void | Promise<void>;
  }): Promise<SubscriptionHandle>;
}

interface SubscriptionHandle extends AsyncDisposable {
  readonly generation: number;
  readonly scannedThroughOffset: number;
  ping(): Promise<{
    generation: number;
    scannedThroughOffset: number;
    headOffset: number;
  }>;
  close(): Promise<void>;
}
```

Contract rules:

- There is one public append operation. No `appendAck`, `appendOffsets`, or method aliases.
- Default append resolves after the source transaction passes the Durable Object output gate.
- Explicit projections are input-aligned. Idempotent retries return the originally committed offsets/events.
- A conflicting idempotency key rejects the whole append before any write.
- Append never waits for processor, webhook, cross-post, or project-worker completion.
- Public subscribers receive singular, ordered `processEvent` calls.
- Subscription callback failure closes the live session with a typed terminal result; it does not mutate durable delivery state.
- Ephemeral events are visible only to live sessions that existed before their append began. Durable subscribers and replay exclude them.

Public utilities:

```ts
read(stream, {
  afterOffset,
  beforeOffset,
  selector,
  maxEvents,
  maxBytes
}): Promise<{
  events: StreamEvent[];
  nextAfterOffset: number;   // raw scan coordinate, not last matched event
  observedHeadOffset: number;
  complete: boolean;
}>;

waitForEvent(stream, {
  afterOffset,
  selector,
  predicate,
  signal
}): Promise<StreamEvent>;
```

`waitForEvent` advances its cursor before awaiting an asynchronous predicate, reconnects after handle loss from the last scan coordinate, and uses `ping()` as real I/O. A timeout is a client-side `AbortSignal` convenience, not a Stream correctness mechanism.

Private details:

- `_scanPage` with raw and selected limits.
- `_openLiveBatch`, `_deliverProcessorBatch`, and `_deliverOutboxBatch`.
- Frame coordinates, batch limits, delivery IDs, claims, retry attempts, alarms, recovery staging, target routes, and telemetry classifications.
- Direct target addressing and processor receiver methods.
- No returned sink capability and no capability-returning Itx `get`.

---

## 4. Ownership Model

| Owner               | Durable authority                                                                                                                        | Ephemeral authority                                                                    | Must not own                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `StreamObject`      | None independently; all writes go through `StreamSql`                                                                                    | Current generation, head, live sessions, fresh tail, activation reconciliation promise | Durable cursors, retry truth, downstream completion |
| `StreamSql`         | Journal, chunks, stream metadata, normalized subscriptions, outbox state, processor-link observations, retention floor, recovery staging | Prepared statements only                                                               | Timers, RPC capabilities, callback promises         |
| `DeliveryEngine`    | Transitions state only through `StreamSql`                                                                                               | Scheduling, one in-flight operation per key, hydrated frame, bounded live queues       | Independent cursor copies or generic mode state     |
| `ProcessorReceiver` | Processor progress, exact pending claim, reducer state, domain projection, retry/revival state                                           | Hydrated processor and one active execution                                            | Source outbox cursor or source journal ownership    |
| Live session        | None                                                                                                                                     | Singular callback, one in-flight private batch, at most one bounded queued frame       | Durable replay guarantees                           |
| Processor link      | Source stores observed progress; receiver stores authoritative progress                                                                  | Current call and frame                                                                 | Source-side authoritative effect acknowledgement    |
| Durable outbox      | Source stores authoritative cursor and exact claim                                                                                       | Current transport call                                                                 | Target processor projection                         |
| Waiter              | None                                                                                                                                     | Client cursor, predicate, abort state                                                  | Persisted waiter rows or correctness timers         |
| Recovery            | Staging rows and a generation-fenced session                                                                                             | Bounded page buffers                                                                   | Hot-path compatibility or migration                 |
| Transport           | None                                                                                                                                     | Direct binding/fetch call and explicitly scoped capability if unavoidable              | Retries, cursor advancement, capability retention   |

Transport targets are a closed typed union:

```ts
type DeliveryTarget =
  | { kind: "processor"; host: ProcessorHost; processor: string }
  | { kind: "project-worker"; projectId: string; receiver: string }
  | { kind: "stream"; projectId: string; path: string }
  | { kind: "webhook"; url: string; secretRef: string };
```

Each target returns plain data such as `{ generation, scannedThroughOffset, deliveryId }`. Configuration validation rejects unknown target kinds before a subscription becomes active.

---

## 5. SQLite Schema and Transaction Boundaries

### Stream database

```sql
stream_meta (
  singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version         INTEGER NOT NULL,
  generation             INTEGER NOT NULL,
  project_id             TEXT NOT NULL,
  path                   TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  evicted_offset_floor   INTEGER NOT NULL DEFAULT 0,
  paused                 INTEGER NOT NULL DEFAULT 0,
  pause_reason           TEXT,
  last_control_offset    INTEGER NOT NULL DEFAULT 0
);

events (
  offset                 INTEGER PRIMARY KEY,
  type                   TEXT NOT NULL,
  idempotency_key        TEXT,
  ephemeral              INTEGER NOT NULL CHECK (ephemeral IN (0, 1)),
  event_json             BLOB,
  chunked_json_bytes     INTEGER,
  CHECK (
    (event_json IS NOT NULL AND chunked_json_bytes IS NULL) OR
    (event_json IS NULL AND chunked_json_bytes IS NOT NULL)
  )
);

CREATE UNIQUE INDEX events_idempotency_key
  ON events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX events_type_offset ON events(type, offset);

event_chunks (
  event_offset           INTEGER NOT NULL REFERENCES events(offset) ON DELETE CASCADE,
  chunk_index            INTEGER NOT NULL,
  chunk_json             BLOB NOT NULL,
  PRIMARY KEY (event_offset, chunk_index)
) WITHOUT ROWID;

subscriptions (
  subscription_key       TEXT PRIMARY KEY,
  config_offset          INTEGER NOT NULL,
  epoch                   INTEGER NOT NULL,
  kind                    TEXT NOT NULL,
  selector_json           TEXT NOT NULL,
  target_json             TEXT NOT NULL,
  start_after_offset      INTEGER NOT NULL,
  poison_policy           TEXT NOT NULL,
  parked_at_offset        INTEGER,
  terminal_error_json     TEXT
);

processor_links (
  subscription_key       TEXT PRIMARY KEY
                           REFERENCES subscriptions(subscription_key) ON DELETE CASCADE,
  observed_offset        INTEGER NOT NULL,
  attempt                 INTEGER NOT NULL DEFAULT 0,
  next_attempt_at         INTEGER,
  last_error_json         TEXT
);

outboxes (
  subscription_key       TEXT PRIMARY KEY
                           REFERENCES subscriptions(subscription_key) ON DELETE CASCADE,
  acked_offset           INTEGER NOT NULL,
  attempt                 INTEGER NOT NULL DEFAULT 0,
  next_attempt_at         INTEGER,
  last_error_json         TEXT,
  claim_after             INTEGER,
  claim_through           INTEGER,
  claim_head              INTEGER,
  claim_offsets_json      TEXT,
  claim_digest            TEXT,
  claim_delivery_id       TEXT,
  claim_recovery_at       INTEGER,
  CHECK (claim_after IS NULL OR (
    claim_through IS NOT NULL AND
    claim_head IS NOT NULL AND
    claim_offsets_json IS NOT NULL AND
    claim_digest IS NOT NULL AND
    claim_delivery_id IS NOT NULL AND
    claim_recovery_at IS NOT NULL
  ))
);

recovery_sessions (
  restore_id              TEXT PRIMARY KEY,
  source_generation       INTEGER NOT NULL,
  target_generation       INTEGER NOT NULL,
  through_offset          INTEGER NOT NULL,
  evicted_offset_floor    INTEGER NOT NULL,
  phase                   TEXT NOT NULL,
  next_offset             INTEGER NOT NULL,
  event_count             INTEGER NOT NULL,
  digest                   TEXT NOT NULL
);

recovery_events (...same event columns..., PRIMARY KEY (restore_id, offset));
recovery_chunks (...same chunk columns..., PRIMARY KEY (restore_id, event_offset, chunk_index));
recovery_outboxes (...progress columns..., PRIMARY KEY (restore_id, subscription_key));
```

### Processor host database

```sql
processor_progress (
  processor_key           TEXT PRIMARY KEY,
  source_project_id       TEXT NOT NULL,
  source_stream_path      TEXT NOT NULL,
  source_generation       INTEGER NOT NULL,
  subscription_epoch      INTEGER NOT NULL,
  acknowledged_offset     INTEGER NOT NULL,
  reduced_offset          INTEGER NOT NULL,
  reducer_version         TEXT NOT NULL,
  reducer_state_json      TEXT,
  pending_after           INTEGER,
  pending_through         INTEGER,
  pending_head            INTEGER,
  pending_digest          TEXT,
  pending_delivery_id     TEXT,
  attempt                 INTEGER NOT NULL DEFAULT 0,
  next_attempt_at         INTEGER,
  last_error_json         TEXT
);
```

The processor host’s domain projection tables and `processor_progress` must share the same SQLite transaction. A host that cannot provide that atomicity must explicitly provide idempotent effects and accept at-least-once replay; it cannot claim exactly-once projection progress.

### Transaction boundaries

1. **Schema bootstrap**
   - Create all tables and marker in one `transactionSync`.
   - Marker-present schema failure is corruption and aborts activation.
   - There is no migration path from the old schema.

2. **Append**
   - Parse and validate the complete input first.
   - Resolve compact idempotency hits, hydrate only hits, and compare logical identity.
   - Allocate offsets above `max(head, evicted_offset_floor)`.
   - Insert every event and chunk in one transaction.
   - Apply control projection mutations in that same transaction.
   - Return only after the output gate.
   - Ordinary inline append should remain one generated multi-row insert where binding limits permit. **Proven:** avoiding generic coalescing and unnecessary statements protects singleton performance.

3. **Chunking**
   - Inline up to 1 MiB.
   - Split oversized serialized events into 512 KiB chunks.
   - Validate full serialized size before the first write.
   - A singleton larger than a frame may occupy a frame alone so scanning always progresses.

4. **Outbox delivery**
   - Read and hydrate a bounded frame.
   - Compute digest and stable delivery ID.
   - Persist the exact claim synchronously.
   - Cross the output gate.
   - Perform outbound I/O.
   - Persist ack, nack, backoff, or park in a generation-and-epoch-fenced transaction.

5. **Processor receiver**
   - Validate source generation, subscription epoch, coordinates, and digest.
   - Persist exact pending claim before processor effects.
   - Process events sequentially.
   - Commit domain projection, reducer state, acknowledged cursor, and claim clearing atomically.
   - Return a plain acknowledgement only after that commit’s output gate.

6. **Retention**
   - Initial release performs no automatic durable-event compaction.
   - Ephemeral eviction and any explicit future compaction update `evicted_offset_floor` atomically with deletion.
   - Durable deletion may not cross any active outbox cursor or claim, processor receiver progress, or recovery export pin.
   - Reads below the floor advance to the floor without reusing offsets.

7. **Alarms**
   - Due rows are canonical; no timer object is durable truth.
   - The single Stream alarm is scheduled for the minimum due link, outbox, or recovery operation.
   - Every durable transition recomputes the next alarm.
   - Alarm invocation re-reads state and repairs scheduling.
   - Persisted timestamps request platform scheduling; local elapsed wall time never proves progress.

8. **Recovery**
   - Export pins generation, head, floor, journal, chunks, and authoritative outbox progress.
   - Import writes bounded pages into staging and incrementally validates count, order, chunks, idempotency, and digest.
   - Final replacement uses one SQLite transaction with `DELETE` plus `INSERT ... SELECT`, rebuilt control rows, reset in-flight claims, and a generation increment.
   - Processor-link observations may be restored as hints, but the receiver remains authoritative.
   - All pre-recovery live sessions and asynchronous completions fail their generation fence.

---

## 6. Operational Flows

### Append

1. Parse the overload and event inputs without I/O.
2. Enforce event count, aggregate byte, and individual event limits.
3. Look up only supplied idempotency keys.
4. Hydrate and compare actual hits; reject any conflict.
5. Build one immutable append plan with new offsets and control-row mutations.
6. Commit the plan synchronously.
7. Publish committed events to the demand-bound tail.
8. Notify `DeliveryEngine` that head changed.
9. Resolve the requested projection without waiting for downstream work.

### Read

1. Clamp `afterOffset` to the eviction floor.
2. Query exact event types in SQL when the selector permits it.
3. Limit raw rows and bytes before hydration.
4. Hydrate only selected rows and required chunks.
5. Return `nextAfterOffset` from raw scan progress, even when no event matched.
6. Report observed head and whether the page reached the requested boundary.

Initial bounds:

- Live and processor frames: 1,000 selected events or 1 MiB.
- Durable project-worker/stream frames: 8,000 events or 4 MiB.
- Webhook frames: one event.
- Raw sparse scans: bounded independently from selected count and allowed to return an eventless progress frame.
- Fresh tail: at most 1,000 events or 1 MiB; oversized events are never retained.

### Live subscribe

1. Snapshot generation and head.
2. Replay from SQLite through the private batch adapter.
3. Invoke public `processEvent` sequentially for each batch member.
4. Permit one in-flight batch and one bounded queued frame.
5. On queue overflow, close with a typed slow-consumer result.
6. After replay catches head, attach to the live tail without a gap.
7. Ephemeral events are delivered only if the session was attached before append began.
8. Close and dispose callback capability deterministically.

**Hypothetical:** one in-flight batch plus one bounded queue will preserve near-neutral public-singular performance while making memory bounds explicit.

### Processor link

1. Source reads receiver progress or starts from the configured cursor.
2. Source scans and selects before hydration.
3. Source sends one bounded private batch directly to the receiver.
4. Receiver persists its exact pending claim.
5. Receiver processes singular events in order and commits projection plus progress.
6. Receiver returns plain `{ generation, epoch, scannedThroughOffset }`.
7. Source stores the value only as an observational retention/lag cursor.
8. If source crashes before storing it, the receiver deduplicates the repeated frame.
9. Eventless selector progress is also committed by the receiver.

The source never treats its observed cursor as proof that processor effects happened. The receiver is authoritative.

### Durable outbox

1. Source scans from `acked_offset`.
2. Source persists exact selected offsets, scan coordinates, digest, delivery ID, and recovery deadline.
3. Source waits for the output gate.
4. Transport sends one private batch.
5. Adapter invokes singular target callbacks in order and awaits their returned promises.
6. Plain target acknowledgement must identify the delivery.
7. Source atomically advances `acked_offset` and clears the claim.
8. A crash before ack commit repeats the same delivery ID.
9. A crash after ack commit cannot redeliver that frame.

### Failure and retry

- Unknown errors are transient initially but remain error telemetry.
- Retry is exponential with jitter, one in-flight attempt per key, a configured maximum attempt count, and a persisted next action.
- Exhausted retries park the subscription and persist the terminal explanation.
- Only an explicit typed permanent per-event result may activate `skip`.
- Generic exceptions, cancellation, timeout, malformed acknowledgement, and digest mismatch never skip.
- Corruption, generation mismatch, and impossible cursor movement fail closed.
- Expected idempotency hits, stale fenced completions, deliberate unsubscribe, and known missing-object probes are typed non-error outcomes.
- No catch-and-log path may advance a cursor.

### Eviction and reactivation

- Activation reads only schema marker, meta, subscriptions, delivery rows, and current head.
- There is no checkpoint replay and no synthetic `woken` event.
- The engine reconciles due claims and schedules one alarm.
- Fresh tail starts empty and is populated only while demand exists.
- Ephemeral cleanup updates the floor atomically.
- Capability sessions are activation-local and disposed on close, failure, or eviction.

### `waitForEvent`

1. Start from a supplied scan coordinate.
2. Subscribe with source-side selector when possible.
3. Advance the local cursor before awaiting the user predicate.
4. Resolve on the first accepted event.
5. On reset or dead handle, ping through real I/O and resubscribe from the advanced coordinate.
6. Abort only from an external signal.
7. Never use elapsed isolate wall time to infer a stalled source.

### Recovery

1. Enter an explicit cold recovery session; reject hot mutation during final replacement.
2. Export or import bounded pages with generation and digest checks.
3. Stage without mutating canonical state.
4. Rebuild normalized control projection from staged facts.
5. Validate journal ordering, chunks, floor, subscriptions, and outbox cursor bounds.
6. Atomically replace canonical tables and increment generation.
7. Reset exact in-flight claims to retry from the last acknowledged cursor.
8. Reconcile alarms and delivery after activation.

---

## 7. State Machines and Invariants

### Persisted state machines

1. **Outbox**
   - Active: no claim, no park, retry due or absent.
   - Claimed: all claim columns present.
   - Backoff: no claim and `next_attempt_at` present.
   - Parked: subscription has terminal error/park offset.
   - Status is derived from columns; do not persist a duplicate enum.

2. **Processor receiver**
   - Idle, claimed, backoff, or parked using the same derived-column pattern.
   - Projection and acknowledged progress move only in the claim-completing transaction.

3. **Processor source link**
   - Active, backoff, or parked.
   - It has no exact source-side claim and no authoritative effect cursor.

4. **Live session**
   - Open, draining, or closed.
   - Entirely activation-local.

5. **Recovery**
   - Staging, validated, replacing, or terminal.
   - Cold-path only.

Append, frame construction, core projection, activation, and waiters are operations, not state machines.

### Derived rather than persisted

- Head offset.
- Delivery lag.
- Whether a retry is due.
- Whether a key is in flight.
- Fresh tail and live roster.
- Delivery ID from generation, epoch, coordinates, offsets, and digest.
- Demand and alarm candidate.
- Subscription status label.
- Selected frame contents.

### Invariants

1. Offsets strictly increase and are never reused.
2. An append is entirely visible or entirely absent.
3. Append results remain input-aligned across mixed fresh and idempotent inputs.
4. Control event and normalized control mutation share one transaction.
5. Durable subscribers never consume ephemeral events.
6. Scan progress follows raw coordinates, not only matched events.
7. Each durable mode has exactly one authoritative progress owner.
8. Any externally visible durable effect has a persisted exact claim first.
9. An acknowledgement is accepted only after the target’s promised work is complete.
10. Cursor movement is monotonic within a generation and subscription epoch.
11. Generation and epoch fence every delayed completion.
12. No live session or hydrated frame can grow without a fixed count and byte bound.
13. At most one attempt per durable delivery key is active.
14. Append completion never implies downstream completion.
15. Retry exhaustion produces a durable parked explanation.
16. Alarms, not local clock passage, guarantee future retry work.
17. Recovery replacement invalidates every old capability and asynchronous result.
18. Corruption never falls back to alternate storage or reconstructed guesses.
19. Every cancellation and expected failure has an explicit telemetry classification.
20. The eviction floor never passes data still required by an authoritative durable cursor or recovery pin.

---

## 8. Module Layout, Dependency Direction, and Size Budget

### Proposed runtime layout

```text
apps/os/src/domains/streams/
  stream.ts                    Public Stream Durable Object facade
  stream-contract.ts           Public types and append overloads
  append-plan.ts               Pure append/idempotency/control planning
  stream-sql.ts                Schema, prepared statements, transactions
  stream-frames.ts             Bounded scan, selection, hydration, coordinates
  stream-live.ts               Live sessions and private batch adapter
  stream-delivery.ts           Alarm, outbox, processor-link scheduling
  stream-transports.ts         Direct typed target calls and disposal
  processor-receiver.ts        Receiver claim/progress/projection protocol
  stream-recovery.ts           Cold export/import/replacement
  wait-for-stream-event.ts     Client utility
  stream-errors.ts             Typed outcomes and telemetry classification
  schemas.ts                   Event/config validation
```

Dependency direction:

```text
contract/schemas/errors
        ↓
append-plan   stream-frames
        ↓          ↓
           stream-sql
        ↓          ↓
stream-live  stream-delivery → stream-transports
        ↓          ↓
             stream.ts

processor-receiver ← private transport contract
stream-recovery → stream-sql
wait utility → public Stream contract only
```

`stream-sql.ts` imports no delivery, transport, callback, or Durable Object facade code. `stream-transports.ts` imports no SQLite implementation. `processor-receiver.ts` does not import the source Stream implementation.

### Runtime line budget

| Module group                          | Target physical lines |
| ------------------------------------- | --------------------: |
| Facade and public contract            |                   350 |
| Append planner and control projection |                   350 |
| SQLite schema and operations          |                   800 |
| Frame scanning/hydration              |                   300 |
| Live sessions                         |                   280 |
| Durable delivery and alarms           |                   650 |
| Processor receiver                    |                   550 |
| Recovery                              |                   300 |
| Direct transports                     |                   250 |
| Wait utility                          |                   120 |
| Shared errors/types                   |                   100 |
| Contingency                           |                   200 |
| **Hard cap**                          |             **4,250** |

Exact eight-file runtime baseline:

- Exact main: 5,980 physical lines.
- Optimized candidate/current code: 8,483 physical lines.
- Target: at most 4,250 lines.
- Reduction: 28.9% versus main and 49.9% versus candidate.

Focused test budget:

- Exact main: 6,447 physical lines.
- Candidate: 11,494 physical lines.
- Target: at most 6,000 focused unit/property/fault-test lines.
- Existing deployed e2e coverage is retained and adapted outside this budget.
- Combined target is 10,250 runtime/test lines, 17.5% below main and 48.7% below candidate.

Additional structural caps:

- At most five explicit state machines.
- At most 30 mutable private runtime fields across facade, live, and delivery owners.
- No new e2e file over 500 lines without deleting or consolidating equivalent coverage.
- No abstraction with only one implementation unless it isolates a direct external boundary.

### Deletion list

Replace or delete the current implementations of:

- `stream-durable-object.ts`
- `stream-storage.ts`
- `stream-delivery-frame-reader.ts`
- `subscription-cursor-store.ts`
- `stream-subscribers.ts`
- `subscriber-sinks.ts`
- `stream-processor-runner.ts`
- `stream-processor-registry.ts`
- KV core checkpoint and schedule code
- ordinary event-run/ack cache where it duplicates the normalized projection
- `woken` and subscriber presence facts
- retained sink capability/session machinery
- generic Itx expression transport
- source wake handshakes and idle capability teardown
- overloaded cursor-store modes and cursor caches
- poison-frame bisection
- append aliases and split acknowledgement methods
- candidate-only compatibility branches, checkpoint cadence logic, and generic mode pumps

The three experiment trees remain evidence only and do not ship. Extract their best tests, then remove them from the landing change.

The result is smaller because it deletes mechanisms rather than renaming them: no dual storage, no checkpoint projection, no presence replay, no generic dispatcher, no returned sink capabilities, no cursor-mode class hierarchy, no frame-cache matrix, no generic credit protocol, and no compatibility API.

---

## 9. Build Sequence and Big Bang Cutover

1. **Freeze the oracle**
   - Record exact main and candidate hashes, benchmark commands, lane definitions, raw-output format, schema limits, and telemetry queries.
   - Finalize the new contract and typed target union before runtime code.

2. **Append/read vertical slice**
   - Implement pure append planning, SQLite schema, atomic append, chunks, idempotency, floor, and bounded read.
   - Test against a pure reference model and real workerd SQLite.

3. **Live subscription slice**
   - Implement singular public callback over private bounded batches.
   - Prove replay/live handoff, ephemeral semantics, reset handling, ordering, and bounded slow-consumer collapse.

4. **Durable outbox slice**
   - Implement one direct target first, preferably stream cross-post.
   - Add exact claims, stable delivery IDs, output gating, retries, alarm recovery, and typed parking.

5. **Processor receiver slice**
   - Implement direct bounded push, receiver-owned progress, exact pending claim, projection/progress transaction, eventless reconciliation, and duplicate-frame acknowledgement.
   - Integrate one real processor host before generalizing host descriptors.

6. **Remaining direct transports**
   - Add project-worker and webhook targets independently.
   - Do not introduce a generic expression language to share them.

7. **Retention, recovery, and lifecycle**
   - Add ephemeral eviction/floor, generation fences, cold staged recovery, capability disposal, and alarm repair.

8. **Replace shipping integration**
   - Switch generated/public bindings directly to the new contract.
   - Delete the old implementation in the same change.
   - Adapt all call sites; do not add adapters, aliases, feature flags, or a dual kernel.

9. **Local qualification**
   - Run model, property, fault, memory, workerd, full typecheck/lint/test, and exact main/candidate benchmark comparisons.

10. **Preview qualification**
    - Only after local gates pass, deploy a single-version preview and run all Worker-to-Worker acceptance and telemetry gates.
    - There is no production rollout stage or compatibility mode.

11. **Production cutover**
    - Require explicit human approval to erase production Stream data.
    - Erase, deploy the new binary/schema, and run post-cutover state plus telemetry checks.
    - Any required preservation or migration of old Stream data cancels this plan.

Vertical slices exist only as implementation/test milestones. The runtime cutover remains one Big Bang replacement.

---

## 10. Correctness Oracle, Fault Tests, and Performance Gates

### Correctness oracle

Build a pure model containing:

- Ordered journal and floor.
- Exact logical idempotency map.
- Normalized subscription configuration.
- Authoritative outbox cursor and claim.
- Receiver cursor, claim, and projection digest.
- Generation and subscription epochs.
- Retry/park outcomes.

Generate operation sequences covering append, duplicate/conflicting append, pause/resume, configure/remove/seek, selector gaps, ephemeral eviction, claim/ack/nack, processor restart, generation replacement, and recovery.

For every step, compare SQLite/runtime observations with the model:

- Visible journal and projected configuration.
- Returned append projection.
- Raw scan coordinate and selected events.
- Durable cursor/claim state.
- Receiver projection digest.
- Alarm obligation and terminal failure.

### Fault matrix

Inject termination or rejection:

- Before and after append transaction/output gate.
- Before and after exact claim commit.
- Before RPC, during RPC, after target commit, and before source ack.
- Before receiver claim, during each event, and before projection/cursor commit.
- Before alarm scheduling, on alarm entry, and after retry state mutation.
- During every recovery page and around final replacement.
- During capability acquisition, success, failure, late completion, and disposal.

Required properties:

- No lost committed event.
- No offset reuse or reordering.
- At-least-once delivery with stable duplicate identity.
- No cursor advance without corresponding durable completion.
- Receiver convergence after arbitrary private frame partitioning.
- No stale-generation or stale-epoch mutation.
- No unbounded queue, retry loop, or retained hydrated payload.
- Every terminal path has a durable and observable explanation.

### Local performance protocol

- Use exact main `8a10191...`, candidate `0e1e944...`, and rewrite binaries.
- Use at least ten fresh processes for development gates and 50 for final qualification.
- Record raw observations and process-cluster bootstrap confidence intervals.
- Measure with a Node/host clock around completed network work.
- Never use Worker-local elapsed time for correctness or benchmark attribution.

Candidate parity gates:

- No accepted strong-win lane may regress more than 10% p50 versus candidate.
- For stable candidate lanes, p50 must be within 5% or 0.15 ms, whichever allowance is larger.
- Candidate p95 parity applies only where the evidence was stable; noisy tails are compared primarily to exact main.
- Public singular/private-batch PCM must remain a bounded batch and no worse than 1.25x candidate batched median.
- Post-GC idle memory must remain within 10% of the candidate’s demand-bound result and release payloads when demand disappears.

Improvement-over-main gates:

- Aggregate equal-workload geometric p50 improvement of at least 24%.
- Aggregate mean improvement of at least 24%.
- Aggregate p95 improvement of at least 20%.
- No individual lane worse than main by more than 5% p50.
- No statistically meaningful p95/p99 regression versus main without an identified, bounded cause and explicit human acceptance.

These are acceptance thresholds, not claims about the unimplemented rewrite.

### Deployed acceptance

Run existing cumulative, wire, lifecycle, recovery, security, stream, ancestor, and storage benchmark suites, plus:

- No-result append at 1 KiB, 100 tiny, 100×1 KiB, 1,000 tiny, and concurrent-32.
- One and 25 live subscribers.
- Dense, sparse, chunked, forced-reactivation, and replay reads.
- PCM 25×3,840-byte private batch.
- Callback-promise durability.
- Processor duplicate-frame and eventless-progress recovery.
- Exact outbox crash points.
- Capability disposal on every outcome.
- Frozen-clock simulation with alarm or real RPC progress.

Release telemetry gate:

- Zero unexplained `ItxEntrypoint.get` exceptions; the boundary should be absent.
- Expected R2 absence probes represented outside error spans.
- Zero unexplained cancellations.
- Zero retry storms, stuck claims, divergent cursors, or warning-only data loss.
- Every expected cancellation includes operation, reason, generation, and next action.
- Full acceptance must improve on the candidate preview’s remaining 357 capability exceptions, 341 expected R2 error spans, 49 cancellations, and warnings by eliminating or correctly classifying every one.

---

## 11. Cost, Risks, Collapse, Rollback, and Stop Conditions

### Cost

- Synchronous SQLite remains the primary cost center. **Proven:** it is still preferable to legacy KV.
- Normalized control and delivery rows add writes for configuration and acknowledgements, not ordinary append.
- Processor links add one observational source write per completed frame. **Hypothetical:** this is acceptable at bounded frame sizes.
- Live backpressure adds a private batch acknowledgement. **Hypothetical:** deployed latency remains near candidate parity.
- Recovery staging temporarily duplicates stored Stream data.
- Direct transports require explicit integration work for every supported host kind.

### Major risks

1. Some processor hosts may not be directly addressable without the existing generic Itx/capability boundary.
2. Some processor hosts may not atomically commit their domain projection and progress.
3. Removing `woken`, presence, or token-bucket behavior may expose an unstated product dependency.
4. Source-side processor observation writes may hurt high-frame-rate workloads.
5. One queued live frame may alter the candidate’s best zero-return wire behavior.
6. Closed target types may remove an intended extensibility surface.
7. Final recovery replacement may exceed Durable Object transaction limits at maximum supported data size.
8. Removing checkpoint replay may shift work to activation SQL in an unmeasured way.
9. New telemetry classification may reveal previously hidden failures rather than immediately producing a clean gate.

### Graceful collapse

- Corrupt Stream state fails activation; it does not fall back.
- A failing delivery key backs off and then parks without blocking unrelated keys.
- Slow live consumers close without retaining unbounded data.
- Processor failure leaves an exact receiver claim and alarm obligation.
- Recovery failure leaves canonical state untouched until final replacement.
- Generation replacement invalidates old sessions rather than trying to merge them.
- Append remains available unless Stream-local corruption, pause, or hard resource bounds make safe commit impossible.

### Rollback

There is no data-compatible rollback. After cutover, rollback means:

1. Stop writes.
2. Obtain explicit human approval for destructive erase.
3. Erase the new Stream data.
4. Deploy the selected previous binary and allow it to create its own schema.
5. Re-run acceptance and telemetry checks.

Any requirement to preserve new-format data while returning to the old runtime is incompatible with this plan.

### Stop conditions

Stop implementation or cutover if:

- A required target cannot be directly addressed without a generic dispatcher or capability-returning `get`.
- Any required processor host cannot provide atomic projection/progress or an explicit idempotent at-least-once contract.
- Correctness properties fail under repeated fault injection.
- A queue, frame, retry series, or staging operation lacks a hard bound.
- Aggregate performance gates fail after two evidence-backed, localized optimization attempts.
- Runtime exceeds 4,250 lines or five state machines without explicit human approval.
- Final recovery replacement fails maximum-size workerd tests.
- Preview telemetry contains any unexplained error, cancellation, retry storm, warning, or state divergence.
- Product owners require compatibility, migration, gradual rollout, or preservation of production Stream data.
- Human approval for production erase is absent.

---

## 12. Highest-Value First 100–200 Lines

The first production code should be approximately 160–190 lines in `append-plan.ts`:

```ts
type AppendPlan = {
  expectedGeneration: number;
  previousHead: number;
  committedEvents: PlannedEvent[];
  inputResults: PlannedResult[];
  controlMutations: ControlMutation[];
};

function parseAppendCall(args: unknown[]): ParsedAppendCall;
function sameLogicalEvent(input: StreamEventInput, stored: StoredEvent): boolean;
function planAppend(
  call: ParsedAppendCall,
  snapshot: AppendSnapshot,
  idempotencyHits: Map<string, StoredEvent>,
): AppendPlan;
```

Those lines must establish:

- One append overload family.
- Default no-result acknowledgement.
- Whole-batch validation before mutation.
- Exact idempotency hit/conflict behavior.
- Mixed retry/new-event result alignment.
- Monotonic offset allocation above the floor.
- Inline versus chunked representation.
- Control mutations emitted as data, not performed by the planner.
- No asynchronous work, callback, storage, transport, clock, or cache dependency.

Immediately follow with focused model tests for atomic rejection, same-batch duplicate keys, mixed fresh/retry batches, processor-provenance equality, floor allocation, chunk thresholds, and control projection plans.

Deliberately wait on:

- Transport integrations.
- Alarms and retry tuning.
- Recovery.
- Fresh-tail caching.
- Insert packing or append coalescing.
- Capability sessions.
- Metrics dashboards.
- Frame-size tuning.
- Token buckets.
- Compatibility aliases.
- Any abstraction intended for a second implementation that does not exist.

The append plan is the highest-value starting point because it fixes the contract and atomicity model before storage and delivery mechanisms can obscure them.

---

## 13. Open Decisions Requiring Human Judgment

1. **Direct target coverage:** confirm that the closed processor/project-worker/stream/webhook target union covers the product. Recommendation: stop rather than reintroduce arbitrary Itx expressions.

2. **Processor host addressing:** select the stable direct binding or fetch route for every first-party processor host. This decision blocks transport implementation.

3. **Processor atomicity:** decide which hosts guarantee one SQLite transaction for projection plus progress, and explicitly classify any at-least-once exceptions.

4. **Circuit breaker scope:** recommendation is to retain durable pause/resume and static append/backpressure limits, but remove the built-in token bucket unless its product behavior is explicitly required.

5. **Live backpressure:** approve one in-flight private batch plus one bounded queued frame, with typed slow-consumer closure.

6. **Poison policy:** recommendation is to permit skip only for explicit typed permanent per-event failures. Decide whether project-worker and processor targets may ever issue that result; generic exceptions must not.

7. **Retention policy:** recommendation is no automatic durable-event compaction in the first rewrite. Define ephemeral eviction timing and any future operator-driven durable retention requirement.

8. **Recovery contents:** recommendation is to restore journal, floor, configuration, and authoritative outbox progress; reset in-flight claims; treat processor-link observations as hints; never restore live sessions.

9. **Performance thresholds:** approve the 24% aggregate p50/mean and 20% p95 improvement-over-main floors, plus candidate-parity lane limits.

10. **Public read shape:** approve explicit scan coordinates in the result rather than returning only an event list.

11. **Telemetry taxonomy:** assign canonical non-error classifications for deliberate unsubscribe, generation fencing, expected missing-object probes, idempotency hits, and capability disposal.

12. **Production authority:** identify who may approve destructive Stream erasure, the cutover window, the post-cutover acceptance owner, and the separate approval required for destructive rollback.
