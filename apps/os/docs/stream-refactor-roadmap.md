# Stream Refactor Roadmap

This roadmap starts from the measured implementation described in
[Stream performance handoff](./stream-performance-handoff.md). It assumes a
destructive production cutover: no old storage format, compatibility facade,
dual-write period, or side-by-side kernel survives the replacement. Production
Stream state is erased for rollout and again for rollback to an older binary.

The objective is not another collection of isolated optimizations. It is one
smaller Stream kernel that preserves the mechanisms already proven to matter,
removes duplicated delivery coordination, and makes the common append and
delivery paths easier to benchmark and reason about.

## Product Surface

The fundamental public operations remain:

- `append`
- `subscribe`
- `read`
- `waitForEvent`

`append` is one operation. It defaults to a durable acknowledgement with no
returned payload and can explicitly request input-aligned offsets or committed
events. Raw Durable Object methods may specialize those result modes to avoid
an options envelope and response serialization, but they are private transport
details. There is no public `appendAck` operation.

Subscribers implement `processEvent(event)`. Bounded batching remains a private
RPC transport detail because deployed measurements rejected one RPC per event
by up to 13x while proving public per-event callbacks can retain batch
throughput.

Processor methods such as `waitUntilProcessed` are orchestration utilities,
not additional Stream fundamentals. Domain-object birth belongs in domain
creation code, outside the Stream kernel.

## Starting Decisions

Keep these mechanisms unless an equal-workload replacement beats them in
local workerd and a deployed Worker-consumer test:

- Synchronous SQLite journal writes in one Durable Object turn.
- No `await` between append validation, offset assignment, insert, and core
  reduction.
- No append-result serialization unless the caller asks for offsets or events.
- Inline small payloads and bounded chunk rows for oversized payloads.
- Demand-bound reuse of freshly committed parsed events.
- Selector-aware frame construction before payload hydration and RPC.
- Private bounded batch delivery behind public `processEvent(event)`.
- Output-gated exact durable claims before outbound RPC.
- Durable alarms for retry and recovery, never correctness-critical local
  timers.
- Node-host timing around network or RPC work because Worker-local time may be
  frozen without network I/O.

Do not restart the legacy KV journal, generic append coalescer, per-event RPC,
unconditional tail retention, or segmented journal experiments without a new
mechanism. They lost either throughput, singleton latency, memory, or code
clarity in the existing evidence.

## Immediate Performance Tranche

These are the only incremental experiments worth considering before the
replacement. Each change must remain independently revertible and must not add
another long-lived state machine.

### 1. Target-offset processor catch-up

Explicit domain-object birth makes append-to-processor-readiness a common
latency path. A generic `catchUp()` to the Stream head followed by
`waitUntilProcessed(offset)` can fetch unrelated tail events, perform an empty
lookahead read, and take an ignored final snapshot.

Add a bounded internal read/catch-up result that stops once the requested
offset has been scanned. It should carry:

- selected events,
- `deliveryThroughOffset`, and
- `streamMaxOffset`.

The processor advances through `deliveryThroughOffset`, including selector
gaps, and returns as soon as the target is durable. Measure warm and cold agent,
capability-host, repo, scheduler, and secret births from a Node host. This is
the first experiment because it can remove work and RPC turns while simplifying
the new barrier semantics.

### 2. Packed activation record

Store canonical Stream name and the optional core checkpoint in one physical
KV record. The measured ceiling is about 0.26-0.28 ms, roughly 11%-12% of the
observed 2.2-2.5 ms activation path. Reject it if the full cold-activation suite
does not improve p50 and mean by at least 5% without a material p95 regression.

### 3. Direct Project Worker delivery

Re-run the preserved direct Project Worker path only after the merged baseline
is stable. The first deployed PCM run improved p50 throughput but regressed
p95; later evidence was contaminated by preview stalls and a storage reset.

Use generic and direct source Durable Objects in one deployment, randomized
ABBA pairs, fresh projects, and Node-host end-to-end timing. Require at least
5% paired p50/capacity improvement, no more than 2% p95/p99 regression, exact
recovery, and no source-DO duration or hibernation regression.

### 4. Keyed homogeneous insert

A derived keyed insert reduces statements and bindings for large uniformly
keyed batches, but its only positive result is a host-SQLite microbenchmark.
Run it after the latency-path experiments and keep it only with workerd and
deployed end-to-end proof. It must preserve idempotency input alignment and
same-batch duplicate behavior exactly.

## Replacement Architecture

```text
StreamDurableObject shell
  |-- StreamJournal
  |     `-- synchronous SQLite event log
  |-- CoreProjection
  |     `-- reducer and checkpoint
  |-- FreshTailCache
  |     `-- demand-bound parsed payload ownership
  |-- DeliveryFrameReader
  |     `-- byte bounds, selectors, scanned-through offsets
  |-- EphemeralDelivery
  |     `-- incarnation-local sessions
  |-- DurableDelivery
  |     |-- CursorStore
  |     `-- claims, poison, retry, and alarm policy
  |-- RecoveryService
  |     `-- segmented export and atomic replacement
  `-- narrow transports
        `-- Workers RPC, itx, webhook, ownership/disposal
```

The shell owns construction, public RPC, and the one synchronous append turn.
It must not accumulate delivery policy.

`StreamJournal` owns schema creation, inserts, idempotency lookup, bounded
reads, eviction, and atomic replacement. Recovery uses this interface rather
than knowing SQL table details.

`CoreProjection` owns append validation and the folded Stream configuration.
Subscription control facts are parsed once and passed to post-commit delivery
logic in typed form.

`FreshTailCache` is the sole owner of speculative parsed payload memory. It
retains only data with current demand and exposes explicit release boundaries.

`DeliveryFrameReader` owns one frame model for live, replay, and durable
delivery. It returns both selected events and the source offset scanned through
so sparse selectors cannot stall cursors.

`EphemeralDelivery` and `DurableDelivery` share frame reading but not a
mode-branching pump. Ephemeral delivery must not acquire a storage round trip or
Promise per frame. Durable delivery must persist an exact claim before RPC and
retain retry, poison isolation, and alarm recovery.

`RecoveryService` is a cold administrative path. Export segmentation and
restore generation fences must not add branches to normal append or pump loops.

## Collapse Budget

The current implementation has about 5,085 delivery-coordination lines, 88
private members, and 13 semi-independent state machines. A feature-complete
replacement should target:

| Measure                 |  Current estimate |  Replacement gate |
| ----------------------- | ----------------: | ----------------: |
| Delivery coordination   | about 5,085 lines | 3,300-3,600 lines |
| Private members         |          about 88 |        at most 45 |
| Explicit state machines |          about 13 |         at most 8 |

The old kernel is deleted in the same cutover. A dispatcher between old and new
kernels, schema migration, dual writes, compatibility aliases, or a hidden
fallback fails the collapse goal even if benchmarks are green.

## Delivery Sequence

### Phase 0: Freeze the oracle

1. Merge current main and explicit-birth behavior into the measured branch.
2. Run all Stream, processor, domain-object birth, and recovery tests.
3. Capture one exact-main cumulative baseline and deployed birth-to-ready
   baseline with immutable revisions and raw logs.
4. Freeze the public API, benchmark corpus, and correctness matrix.

### Phase 1: Build one feature-complete vertical slice

Implement, in the replacement kernel:

- append with internal no-result and offsets-only modes,
- one ephemeral `processEvent` subscriber,
- one durable claimed Project Worker subscriber,
- byte-bounded frames and demand-bound fresh payloads,
- selector scanned-through advancement,
- receiver failure, DO eviction, alarm retry, and poison isolation,
- capability disposal, and
- recovery export plus atomic restore.

Deploy this slice before porting less common transports. If it cannot match the
current kernel's latency and correctness, stop and fix the ownership model
rather than filling out more surface area.

### Phase 2: Complete modes behind the same owners

Add webhooks, itx expressions, durable reconfiguration, general selectors,
reset-safe waits, metrics, and lifecycle cleanup. Each addition extends an
existing owner; it must not create a second wake loop or cursor meaning.

### Phase 3: Destructive cutover

1. Delete the old implementation and old schema in the replacement branch.
2. Run the full local and deployed acceptance matrix.
3. Verify preview traces, logs, metrics, and resulting state have no unexplained
   errors, retries, gaps, or retained resources.
4. Keep the PR unmerged until the production erase and rollback procedure has
   explicit human approval.
5. Erase production Stream state and deploy the new binary in one controlled
   operation. Rollback also erases state; it does not invoke a migration shim.

## Acceptance Matrix

Performance comparisons use exact revisions and Node-host clocks:

- append one, 100, 1,000, and 32 concurrent singleton appends,
- dense, sparse, latest, and oversized reads,
- one and 25 live subscribers,
- dense and sparse durable delivery,
- replay memory, GC, and forced reactivation,
- warm and cold domain-object birth-to-ready latency,
- deployed durable and ephemeral Worker consumers,
- singleton and 640-byte PCM frame workloads, and
- kill, retry, alarm, and recovery lanes.

The default gate is no meaningful median regression and no p95/p99 regression.
A narrow experiment may define a stricter workload-specific gate before it
runs, but cannot trade an unbounded tail for average throughput.

Correctness must prove:

- contiguous one-time offsets and all-or-nothing variadic append,
- idempotency and input-aligned append results,
- output-gated exact durable claims,
- selector advancement through scanned gaps,
- poison isolation without skipping healthy events,
- cursor epochs and stale-session fencing,
- eviction, alarm, reset, and receiver-failure recovery,
- capability retention and disposal,
- segmented recovery export and atomic restore,
- explicit birth configuration and target-offset processor barriers, and
- bounded, observable failure with no silent fallback.

## Decision Order

1. Integrate current main and establish the post-birth baseline.
2. Implement and measure target-offset catch-up.
3. Decide whether the small packed-activation change is worth shipping.
4. Build the replacement vertical slice and compare it against the frozen
   oracle.
5. Use the direct Project Worker and keyed-insert experiments only if the
   replacement work exposes a clear need for them.

This order lands the highest-confidence latency improvement first, then moves
engineering effort toward reducing the kernel rather than adding more
coordination to an implementation already beyond its intended complexity
budget.
