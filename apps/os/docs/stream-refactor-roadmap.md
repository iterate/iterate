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

### 1. Measure the integrated scanned-through runner (broad gate complete)

The current-main semantic merge has implemented the compact private frame:
selected events plus `scannedAfterOffset`, `scannedThroughOffset`, and
`streamMaxOffset`. A successful frame durably advances both progress cursors
through scanned selector gaps. An empty or filtered frame that reaches head
runs the event-less reconciliation pass required to keep obligations live.
Main's acknowledged-cursor fast return also remains, so an already-covered
readiness barrier makes no Stream RPC.

Do not delete the runner's remaining self-pull indiscriminately. It now serves
explicit read-your-writes waits and cold registry catch-up when no delivery
frame exists; those are availability and recovery paths. The duplicate work
that has been removed is the pull that merely rediscovered a scanned-through
boundary already supplied by a frame.

The exact-current-main broad gate is complete. Candidate `b2712ad09` versus
main `7495c6802` improved the conservative equal-workload p50/p95/mean by
30.568%/27.018%/31.619% across 50 passing fresh processes and 35,750
host-timed observations. This proves the merged implementation retained a
large cumulative win; it does not isolate the compact frame's contribution.

The remaining focused attribution should cover warm and cold agent,
capability-host, repo, scheduler, secret, and full project births from a Node
host, plus sparse selected frames, an empty head-reaching frame, continuous
writers, forced kills, and receiver failure. Record Stream reads/RPC turns as
well as end-to-end readiness. Do this only if deciding whether to simplify the
runner before landing; it is no longer a blocker for the broad performance
claim.

Only then compare cold barriers that scan to the captured head with a
target-bounded variant. A target-bounded fold must not report a false head or
run at-head reconciliation while later events exist, and deferred
reconciliation must be provably re-driven. Agent and repo reconciliation has
consequential side effects, so a smaller read is not worth ambiguous liveness.
Require at least 5% p50 and mean improvement with no greater than 2% p95/p99
regression for any additional mechanism.

### 2. Flush activation catch-up, then decide whether to pack the record

Store canonical Stream name and the optional core checkpoint in one physical
KV record. The measured ceiling is about 0.26-0.28 ms, roughly 11%-12% of the
observed 2.2-2.5 ms activation path. Reject it if the full cold-activation suite
does not improve p50 and mean by at least 5% without a material p95 regression.

Checkpoint 16 found forced-reactivation head p50 neutral at 0.62% slower and
p95 66.69% slower (2.735 ms to 4.559 ms). The immediate mechanism was not the
number of point reads. A lagging core checkpoint survived abrupt restarts while
every incarnation appended another `woken` fact, so constructor replay grew
until the 64-event threshold.

The bounded correction flushes caught-up state once at activation, then starts
a fresh debounce window for the new `woken` fact. A clean five-process-per-arm,
300-sample-per-process A/B improved pooled p50/p95/mean by
7.45%/5.82%/4.56%; all five paired p50s improved. One noisy process left p99
inconclusive. Ship this correction after deployed proof. Packing one record is
now optional and still has only a 0.26-0.28 ms ceiling; keep it only if a
separate cold suite improves p50 and mean at least 5% without p95/p99 loss.

### 3. Typed post-commit deltas

The source-owned and transactional-outbox redesigns both make the append
reducer emit a typed control delta alongside the committed event. The current
kernel validates and parses subscription control events in the reducer, then
parses them again in post-commit processing. Preserve one parsed result through
the commit boundary instead. This should delete code and parser work without
changing persistence, RPC, or recovery ownership. Accept only if the diff is a
net simplification and all control-event/recovery tests remain exact.

This is the best clarity-first change after activation diagnosis: it should be
roughly tens of lines, removes duplicate work, and does not add a state machine
or consistency boundary.

### 4. Keyed homogeneous insert

A derived keyed insert reduces statements and bindings for large uniformly
keyed batches, but its only positive result is a host-SQLite microbenchmark.
The measured write-stage p50 improvement was 14%-17.5%; there is no end-to-end
proof. Run it after the latency-path experiments and keep it only with workerd
and deployed evidence at 500 and 1,000 events. It must preserve idempotency
input alignment, byte-boundary rebinding, chunk transactions, and same-batch
duplicate behavior exactly.

### 5. Integrated sparse scan and durable claim

The transactional-outbox spike's strongest result was a 55.0% local reduction
for sparse selection plus claim construction. Its query establishes the raw
scan boundary, selected offsets, byte bound, and persisted one-frame claim as
one storage-owned operation instead of materializing the same decision through
separate planner and claim stages. Port the smallest version into the current
source-owned outbox, preserving output-gate ordering, poison bisection, epochs,
chunk hydration, and event-less scanned-through progress. The result is not a
shipping claim until a deployed sparse Worker-consumer lane improves by at
least 5% without singleton, dense, or p95/p99 regression.

This is higher upside than the keyed insert but also higher risk. Do not start
it until the landing branch is either frozen or copied to an isolated
experiment worktree.

### 6. Flatten internal expression dispatch

The current Stream dial calls `ItxEntrypoint.get()`, retains the transient
authority root, and walks a persisted expression over that RPC session. The
latest preview emitted 3,248 error-level `get` invocations, mostly during E2E.
Current workerd source says orderly capability release resolves the JS-RPC
session as `OK`; cancellation or actor abort maps to an exception. The cached
push root is therefore both a latency opportunity and a telemetry suspect.

Add one internal scoped entrypoint method that evaluates the complete
expression and payload server-side. Push calls then return only an
acknowledgement and retain no session; wake calls may return the live sink and
tie only that returned capability to the existing idle-teardown lifetime. This
preserves generic expressions and removes more RPC turns than the older direct
Project Worker special case.

Run both paths in one deployment with randomized ABBA pairs, fresh projects,
and Node-host end-to-end timing. Require at least 5% paired p50/capacity
improvement, no more than 2% p95/p99 regression, exact retry/recovery and
capability disposal, and a clean or explicitly classified `get` telemetry
delta. Reject any design that adds a second delivery protocol or
canonical-expression branch.

## Parallel Kernel Spike Result

Three executable no-compatibility spikes tested ownership changes against
merged baseline `0128ebe73`:

- A 1,927-line source-owned kernel reduced local 100-event append work by
  11.8%-21.3%, but regressed singleton append 10.8% and sparse framing 9.0%.
- A 2,425-line receiver credit/pull kernel made the receiver authoritative for
  cursor and claim state. It added two cross-DO calls and four writes per
  caught-up burst; singleton delivery became three calls/seven writes rather
  than one/three, and local controls were 16.9%-23.4% slower.
- A 2,427-line transactional-outbox kernel reduced its local sparse
  scan-plus-claim lane 55.0%, but regressed singleton append 23.7% and sparse
  read 3.1%.

These counts exclude substantial omitted production surface and are ownership
signals, not feature-parity comparisons. Do not replace the current kernel with
any spike. Keep source ownership as the default, consider receiver ownership
only where an already-existing processor Durable Object can atomically commit
its projection and cursor, and promote only the typed-delta and integrated
scan/claim mechanisms through the normal deployed gates.

The spikes contain 60 passing focused tests and 9,923 total lines. They remain
outside the shipping diff and are archived at
`~/stream-kernel-redesign-experiments-2026-07-16.tar.gz`, SHA-256
`7ced9e22f851344f471619b8db41496d7ed1485ccdf515de8e982fa63373cf05`.

## Post-2038 Integration Result

The merge met the semantic gates:

- Main's `StreamProcessorRunner`, registry, two-cursor progress model, and
  deletion of `StreamProcessorHost` remain authoritative.
- The runner consumes the compact scan-coordinate frame and retains event-less
  at-head reconciliation. Its remaining self-pull is limited to explicit
  read-your-writes/cold catch-up, not duplicate frame scanning.
- There is one public `append`; explicit births request offsets-only results.
  Default full-event responses and public `appendAck` do not exist.
- The wire exposes one append union because Cap'n Web proxy projection cannot
  preserve overloads or a conditional generic. Shared helpers narrow an
  explicitly requested projection.
- Recovery uses schema-v8's chunk-aware journal APIs and preserves oversized
  rows, `evicted_offset_floor`, explicit offset assignment, and the packed
  `coreState` checkpoint envelope. Old `AUTOINCREMENT`, `sqlite_sequence`, and
  checkpoint formats were not revived.
- Atomic replacement invalidates cursor caches/staged progress, and recovery
  generation fences remain around pokes, pushes, claims, timers, retained
  frames, cursor completion, and segmented exports.
- OS/package ITX API graphs and examples were regenerated from resolved source.

Root typecheck, lint, formatting, and recursive workspace tests pass at the
integration snapshot. The focused Stream matrix passes 478 tests, the affected
cross-domain matrix passes 208, and the full OS suite passes 1,969 tests with
one intentional skip. Later bootstrap/idempotency fixes pass 544 Stream tests
and deployed preview proof. The exact-current-main cumulative gate is complete;
the corrected full preview and destructive rollout runbook remain before this
tree is a shipping candidate.

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
88 private members, and 13 semi-independent state machines. The integrated
eight-file journal/delivery/runner set now totals 8,437 lines, including 1,087
journal lines and 1,769 runner/registry lines. That is a reproducible file-set
count, not a claim that every line is coordination. Establish one similarly
reproducible private-member/state-machine count before approving a replacement;
do not use the old totals as the post-merge baseline. The feature-complete
target remains:

| Measure                 | Integrated evidence       |   Replacement gate |
| ----------------------- | ------------------------- | -----------------: |
| Eight core files        | 8,437 lines               | materially smaller |
| Delivery coordination   | old estimate: about 5,085 |  3,300-3,600 lines |
| Private members         | old estimate: about 88    |         at most 45 |
| Explicit state machines | old estimate: about 13    |          at most 8 |

The old kernel is deleted in the same cutover. A dispatcher between old and new
kernels, schema migration, dual writes, compatibility aliases, or a hidden
fallback fails the collapse goal even if benchmarks are green.

## Delivery Sequence

### Phase 0: Freeze the oracle

1. Completed: merge current main and explicit-birth behavior into the measured
   branch without reviving `StreamProcessorHost`.
2. Completed: root typecheck, lint, formatting, recursive tests, focused Stream
   tests, and affected cross-domain tests pass.
3. Pending: capture one exact-main cumulative baseline, the complete
   birth/recovery matrix, and a deployed
   birth-to-ready baseline with immutable revisions and raw logs.
4. Pending: freeze the public API, benchmark corpus, and correctness matrix at
   those revisions.

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

1. Establish the post-birth exact-main baseline for the already integrated
   scanned-through runner.
2. Measure birth plus sparse-delivery latency and verify the expected reduction
   in Stream reads/RPC turns; accept target-bounded folding only with
   reconciliation proof.
3. Deploy the activation catch-up flush; decide separately whether the smaller
   packed-activation ceiling is worth another format change.
4. Measure the keyed homogeneous insert on end-to-end large batches.
5. Build the replacement vertical slice and compare it against the frozen
   oracle.
6. Prove flattened internal expression dispatch; retain the direct Project
   Worker prototype only as a performance ceiling.

This order lands the highest-confidence latency improvement first, then moves
engineering effort toward reducing the kernel rather than adding more
coordination to an implementation already beyond its intended complexity
budget.
