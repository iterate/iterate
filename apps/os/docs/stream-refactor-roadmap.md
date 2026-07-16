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

### 1. Scanned-through frames in `StreamProcessorRunner`

Explicit domain-object birth makes append-to-processor-readiness a common
latency path. Project creation waits for four sibling processors in parallel,
so this path is no longer obscure.

Main's #2002 runner already implements the important warm fast path:
`waitUntilEvent({ offset })` loads progress and returns immediately when the
acknowledged cursor already covers the target. Keep that implementation; do
not add a second barrier state machine or an ignored final snapshot.

The integration gap is the private frame contract. This branch's Stream pump
advances a configured connection across selector gaps and sends:

- selected events,
- `deliveryThroughOffset`, the highest contiguous raw offset scanned, and
- `streamMaxOffset`, the immutable head observed for that frame.

The pre-merge runner receives only selected events plus the raw head. Whenever
its acknowledged cursor remains below that head it compensates with a trailing
type-unfiltered self-pull, re-reading and hydrating journal rows the Stream just
scanned. That is avoidable RPC, SQLite, parsing, and payload work on sparse
processors and birth barriers.

Port `deliveryThroughOffset` into `StreamProcessorRunner`. A successful frame
must reduce/process selected events, durably advance both progress cursors
through the scanned offset, and treat `deliveryThroughOffset >=
streamMaxOffset` as at-head. If no consumed event carries the at-head pass, run
the event-less reconciliation that production proved necessary; otherwise an
obligation can strand forever behind an unconsumed tail. Only after those
invariants are green may the trailing unfiltered self-pull be removed.

Then compare cold barriers that scan to the captured head with a target-bounded
variant. A target-bounded fold must not report a false head or run at-head
reconciliation while later events exist, and deferred reconciliation must be
provably re-driven. Agent and repo reconciliation has consequential side
effects, so a smaller read is not worth ambiguous liveness.

Measure warm and cold agent, capability-host, repo, scheduler, secret, and full
project births from a Node host, including continuous writers and forced kills.
Require at least 5% p50 and mean improvement with no greater than 2% p95/p99
regression. This remains the first experiment because the common case can
remove all Stream RPCs and the cold case can remove RPC turns.

### 2. Packed activation record

Store canonical Stream name and the optional core checkpoint in one physical
KV record. The measured ceiling is about 0.26-0.28 ms, roughly 11%-12% of the
observed 2.2-2.5 ms activation path. Reject it if the full cold-activation suite
does not improve p50 and mean by at least 5% without a material p95 regression.

### 3. Keyed homogeneous insert

A derived keyed insert reduces statements and bindings for large uniformly
keyed batches, but its only positive result is a host-SQLite microbenchmark.
The measured write-stage p50 improvement was 14%-17.5%; there is no end-to-end
proof. Run it after the latency-path experiments and keep it only with workerd
and deployed evidence at 500 and 1,000 events. It must preserve idempotency
input alignment, byte-boundary rebinding, chunk transactions, and same-batch
duplicate behavior exactly.

### 4. Direct Project Worker delivery

Re-run the preserved direct Project Worker path only after the merged baseline
is stable. The first deployed PCM run improved p50 throughput but regressed
p95; later evidence was contaminated by preview stalls and a storage reset. Its
prototype was also about `+542/-206` lines, so it is not a 100-200-line landing
candidate.

Use generic and direct source Durable Objects in one deployment, randomized
ABBA pairs, fresh projects, and Node-host end-to-end timing. Require at least
5% paired p50/capacity improvement, no more than 2% p95/p99 regression, exact
recovery, and no source-DO duration or hibernation regression.

## Post-2038 Integration Gates

The merge is semantic, not a choice of conflict sides:

- Keep main's `StreamProcessorRunner`, registry, two-cursor progress model,
  and deletion of `StreamProcessorHost`; do not resurrect the old host to make
  conflicts easier.
- Port the compact `deliveryThroughOffset` frame into the runner and retain
  event-less at-head reconciliation before deleting its fallback self-pull.
- Keep one public `append`; explicit births request offsets-only results and do
  not reintroduce default full-event responses or a public `appendAck`.
- Do not publish overloads or a conditional generic `append`: Cap'n Web proxy
  projection cannot preserve either result-selection shape. Keep the wire
  union and put any type-narrow convenience in generated client code.
- Reimplement recovery through schema-v8's chunk-aware journal APIs. Recovery
  must preserve oversized rows, `evicted_offset_floor`, explicit offset
  assignment, and the packed `coreState` checkpoint envelope; it must not port
  `AUTOINCREMENT`, `sqlite_sequence`, or the older checkpoint keys.
- Invalidate the subscription cursor store's cached rows and staged progress
  after atomic replacement. A restored subscription must not silently reuse a
  deleted row or update zero rows.
- Fence every poke, push, claim, timer, retained frame, and cursor completion
  with a recovery generation. A stale `finally` must not delete a new same-key
  reservation, and recovery closes sessions without appending disconnect facts
  into the replacement journal.
- Give segmented exports a journal-incarnation token. An export paused in
  `sink.write()` must abort if restore replaces the journal rather than emit an
  old prefix followed by a new suffix.
- Regenerate the OS and package ITX artifacts from the resolved source; never
  hand-merge generated API files.

## Replacement Architecture

```text
StreamDurableObject shell
  |-- AppendKernel
  |     `-- await-free validation, offsets, reduction, commit
  |-- StreamJournal
  |     `-- synchronous SQLite event log
  |-- CoreProjection
  |     `-- reducer, typed post-commit deltas, checkpoint
  |-- TailWindow
  |     `-- demand-bound parsed payload ownership
  |-- DeliveryFrameReader
  |     `-- byte bounds, selectors, scanned-through, observed head
  |-- LiveSessions
  |     `-- incarnation-local sessions
  |-- ProcessorLinks
  |     `-- receiver-owned checkpoints, wake, replay
  |-- DurableOutbox
  |     |-- CursorStore
  |     `-- exact claims, poison, retry, and alarm policy
  |-- RecoveryAdmin
  |     `-- export, validation, replacement, lifecycle generation
  `-- narrow transports
        `-- Workers RPC, itx, webhook, ownership/disposal
```

The shell owns construction, public RPC, and the one synchronous append turn.
It must not accumulate delivery policy.

`AppendKernel` owns the await-free interval from parsed input through assigned
offsets, core reduction, and SQLite commit. It emits typed post-commit deltas so
delivery code does not parse control events again.

`StreamJournal` owns schema creation, inserts, idempotency lookup, bounded
reads, eviction, and atomic replacement. Recovery uses this interface rather
than knowing SQL table details.

`CoreProjection` owns append validation and the folded Stream configuration.
Subscription control facts are parsed once and passed to post-commit delivery
logic in typed form.

`TailWindow` is the sole owner of speculative parsed payload memory. It
retains only data with current demand and exposes explicit release boundaries.

`DeliveryFrameReader` owns one frame model for live, replay, and durable
delivery. It returns both selected events and the source offset scanned through
so sparse selectors cannot stall cursors.

`LiveSessions`, `ProcessorLinks`, and `DurableOutbox` share frame reading but
not a mode-branching pump. Live delivery must not acquire a storage round trip
or Promise per frame. Processor links use the receiver's durable checkpoint as
their one cursor; the already-landed `StreamProcessorRunner` is that receiver
and should be simplified in place rather than replaced. The outbox persists an
exact claim before RPC and retains retry, poison isolation, and alarm recovery.
There is exactly one authoritative cursor owner in each mode.

`RecoveryAdmin` is a cold administrative path. Export incarnation checks,
cursor invalidation, and restore generation fences must not add branches to
normal append or pump loops beyond one lifecycle token captured at async
boundaries.

## Collapse Budget

Before #2002, the implementation had about 5,085 delivery-coordination lines,
88 private members, and 13 semi-independent state machines. #2002 deletes the
old host but adds the runner, registry, two-cursor durability, and keepalive
adapters. Recount the integrated tree before approving a replacement; do not
claim the old total as the post-merge baseline. The feature-complete target
remains:

| Measure                 | Pre-#2002 estimate |  Replacement gate |
| ----------------------- | -----------------: | ----------------: |
| Delivery coordination   |  about 5,085 lines | 3,300-3,600 lines |
| Private members         |           about 88 |        at most 45 |
| Explicit state machines |           about 13 |         at most 8 |

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
- one receiver-checkpointed processor link,
- one claimed Project Worker outbox subscriber,
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
- cursor-cache invalidation across journal replacement,
- eviction, alarm, reset, and receiver-failure recovery,
- capability retention and disposal,
- segmented recovery export with journal-incarnation fencing and atomic restore,
- explicit birth configuration and target-offset processor barriers, and
- bounded, observable failure with no silent fallback.

## Decision Order

1. Integrate current main and establish the post-birth baseline.
2. Port scanned-through frames into the runner, remove the duplicate self-pull,
   and measure birth plus sparse-delivery latency; accept target-bounded folding
   only with reconciliation proof.
3. Decide whether the small packed-activation change is worth shipping.
4. Measure the keyed homogeneous insert on end-to-end large batches.
5. Build the replacement vertical slice and compare it against the frozen
   oracle.
6. Revisit direct Project Worker delivery only if the replacement work exposes
   a clear need and its tail-latency regression is gone.

This order lands the highest-confidence latency improvement first, then moves
engineering effort toward reducing the kernel rather than adding more
coordination to an implementation already beyond its intended complexity
budget.
