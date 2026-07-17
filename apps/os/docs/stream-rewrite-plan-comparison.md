# Independent Stream Rewrite Plan Comparison

Date: 2026-07-17

Independent inputs:

- [Claude Fable plan](./stream-rewrite-plan-claude-fable.md)
- [Codex plan](./stream-rewrite-plan-codex.md)

Both planners received the same frozen evidence brief. Neither could read the
other plan. This document is a third-pass adjudication, not another independent
proposal.

Performance labels in this document:

- **Proven**: directly established by the recorded benchmark, source, or fault evidence.
- **Inferred**: follows from that evidence but has not been measured in this architecture.
- **Hypothetical**: requires a new implementation and measurement.

## Decision

Use a hybrid, with the following order of preference:

1. Keep Fable's scope: rewrite the source Stream Durable Object kernel, but keep
   the existing `StreamProcessorRunner`, registry, processor contracts, and
   browser mirror.
2. Preserve the optimized candidate's append, journal, frame, batching, and
   demand-bound payload mechanisms as implementation constraints, not code that
   must be copied literally.
3. Adopt Codex's main simplification: replace synthetic lifecycle facts, KV
   checkpoint debounce, and activation replay with normalized SQLite control
   state updated in the same transaction as the canonical control event.
4. Do not adopt either delivery topology unchanged. Keep three explicit owners
   sharing one frame reader: activation-local live sessions, source-owned durable
   outboxes, and links to the existing receiver-owned processor runner.
5. Target direct, operation-specific transports returning plain data. Freeze the
   choice only after the pending capability-versus-plain-data lifecycle probe.
   A capability-returning boundary that reports successful work as native
   exceptions is not acceptable.
6. Keep poison isolation until a deployed experiment proves that typed
   per-event permanent failures can replace it without skipping healthy work.
7. Make `waitForEvent` a reset-safe client utility over read plus subscribe. Do
   not persist waiters, and do not make correctness depend on isolate-local time.
8. Cut over once, destructively, after explicit erase approval. A schema mismatch
   must fail closed; it must not erase state merely because an object was touched.

This recommendation is **inferred**, not a performance claim. Its uncertain
pivot is the normalized SQLite control projection. Prove that pivot in a bounded
vertical slice before building the rest of the replacement.

## Fixed Evidence

- Exact main: `8a10191f4d50055f263d61b6acd5c81d4da7013d`.
- Optimized runtime candidate: `0e1e944699ecfec83a3ed9f73e36389a7934bfea`.
- Documentation head supplied to both planners: `f4da96d2c`.
- **Proven:** Checkpoint 18 used 50 fresh processes and 35,750 validated,
  host-timed observations. Conservative p50/p95/mean improvement over exact main
  was 30.718%/29.691%/30.566%; the unmodified suite was
  30.871%/19.578%/28.221%.
- **Proven:** actual one-Workers-RPC-per-event PCM delivery was 7.07x slower at
  p50 and 8.25x slower at p95. Public singular `processEvent(event)` over one
  private bounded frame was near-neutral.
- **Proven:** legacy Durable Object KV lost every serious storage lane and added
  segmentation, indexing, recovery, and consistency work. Keep synchronous
  SQLite.
- **Proven:** all three whole-kernel spikes regressed singleton append locally.
  Their useful mechanisms are evidence donors, not replacement candidates.
- **Proven:** the recursive bootstrap defect came from equating durable append
  completion with downstream processor completion. The two boundaries must stay
  separate.
- Direct physical recount for the same eight coordination files is 5,980 lines
  on exact main and 8,483 on the candidate. Older roadmap totals refer to an
  earlier integrated snapshot and must not be mixed with this comparison.

## Qualifications On The Independent Outputs

The independent plans are preserved as written, but several statements need
qualification before implementation:

- Fable calls the candidate deployable. It is a proven performance and
  correctness oracle, but it is not release-ready: the exact preview remains
  blocked by capability exceptions, expected probes emitted as errors,
  cancellations, and warning classes.
- Fable's requirement to retain "at least 25%" of the roughly 30% gain is
  ambiguous and could mean only 7.5 percentage points. This comparison uses a
  24-point p50/mean floor, which means retaining about 80% of the candidate's
  aggregate improvement.
- Fable's automatic drop of a foreign schema is a proposal, not an accepted
  consequence of the no-compatibility doctrine. Explicit erase authorization
  still controls destructive state changes.
- Codex's normalized control rows, direct target union, replacement receiver,
  simplified poison policy, and 4,250-line cap are all hypothetical. None has a
  feature-complete deployed result.
- Neither plan gives the durable form of `subscribe` a complete user-level
  lifecycle. That API decision precedes schema and transport implementation.
- All target line counts are design budgets. Only the exact-main and candidate
  source counts are observations.

## Side-by-Side

| Question              | Claude Fable                                                               | Codex                                                                                           | Adjudication                                                                                     |
| --------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Rewrite scope         | Source Stream kernel only; retain runner and browser mirror                | Replace source kernel and introduce a new `ProcessorReceiver` protocol                          | Fable wins. Reusing the now-integrated runner deletes risk and work.                             |
| Canonical journal     | Event log is truth                                                         | Event log is truth                                                                              | Agreement.                                                                                       |
| Core/control state    | Fold event log, cache in KV, append `woken` and presence facts             | Materialize normalized SQL rows in the append transaction; delete KV replay and lifecycle facts | Prefer Codex, subject to a singleton/activation proof.                                           |
| Append implementation | Preserve candidate hot-path shape                                          | Introduce a pure `AppendPlan`                                                                   | Preserve candidate shape. A pure plan is welcome only if it adds no allocation or statement tax. |
| Live delivery         | Parameterized `LiveSession` inside a large unified delivery module         | Separate live module with one in-flight and one queued frame                                    | Separate owner, but preserve the candidate's zero-return synchronous fast path.                  |
| Generic durable push  | Source-owned exact claim                                                   | Source-owned exact outbox                                                                       | Agreement.                                                                                       |
| Processor progress    | Existing runner remains authoritative                                      | New receiver persists claim, progress, projection, and retries                                  | Keep the existing runner. Add no second processor protocol without a measured need.              |
| Delivery unification  | One 1,450-line delivery spine and mode-specific settle rules               | One engine, but distinct live, outbox, and processor semantics                                  | Use shared scheduling and frames, not one mode-branching state machine.                          |
| Transport             | Retain trusted Itx expression/capability wake path and classify outcomes   | Closed typed targets, plain-data acknowledgements, no capability-returning `get`                | Codex is the target; the lifecycle probe chooses direct RPC versus fetch.                        |
| Poison handling       | Retain confirmation, bisection, skip cap, and audit facts                  | Remove bisection; permit only typed permanent per-event skip                                    | Retain Fable behavior until the simpler alternative is proven.                                   |
| `waitForEvent`        | In-DO, incarnation-bound; client retries                                   | Reset-safe client utility using scan progress, ping I/O, and `AbortSignal`                      | Codex wins and matches the accepted reset-safety invariant.                                      |
| Public append         | One public method, private raw result specializations                      | One public method and private projection mode                                                   | Agreement in substance. Do not expose `appendAck` as a concept.                                  |
| Public subscribe      | Primarily an ephemeral session; durable subscriptions remain control facts | Live callback contract; durable target configuration remains separate                           | Neither fully resolves the requested append/subscribe-centered API. Decide before coding.        |
| Rollback              | Pre-built binary may drop an unknown schema on touch                       | Explicit stop, erase, then old binary                                                           | Codex wins. Automatic destructive mismatch handling violates explicit erase approval.            |
| Source-kernel budget  | 5,440 lines, eight total machines including receiver                       | 4,250 lines, five machines, but includes a replacement receiver                                 | Treat 4,250 as a stretch and 5,440 as a stop signal, not competing exact forecasts.              |
| Test budget           | About 9,500 lines, heavily ported                                          | 6,000 focused lines plus existing e2e                                                           | Do not cap tests by line count. Delete duplication, not fault coverage.                          |

## Shared Consensus

The independent convergence is strong on the following decisions:

1. One Big Bang runtime cutover, no dual kernel, compatibility shim, migration,
   fallback, or gradual rollout.
2. One public append operation, defaulting to durable acknowledgement without a
   returned payload; explicit offsets/events projections only where required.
3. One synchronous, await-free source commit turn. No downstream completion is
   part of append acknowledgement.
4. Synchronous SQLite with inline small events, chunked oversized events,
   indexed idempotency, and a monotonic offset floor.
5. Selection before hydration and transport, with raw scan coordinates that
   advance through selector misses and ephemeral gaps.
6. Public singular `processEvent(event)` and private bounded frames. Actual
   singular wire RPC remains rejected.
7. Demand-bound parsed payload memory with explicit byte and event limits.
8. Source-owned exact claims for generic durable delivery, persisted before
   outbound I/O and fenced by generation and subscription epoch.
9. Receiver-owned authoritative progress for processors. The disagreement is
   whether to retain or replace the existing receiver implementation.
10. One alarm derived from durable due rows; local timers and elapsed isolate
    time are never correctness authorities.
11. Cold staged recovery, generation fencing, deterministic capability disposal,
    bounded retries, durable parking, and no silent cursor movement on failure.
12. Exact-main and exact-candidate comparisons using a Node host clock around
    completed network work, followed by deployed Worker-to-Worker acceptance and
    telemetry inspection.

## Evidence-Weighted Disputes

### 1. Rewrite boundary

Fable's narrow boundary is more defensible. Main already contains the integrated
runner, registry, two-cursor progress model, and explicit birth behavior. Codex
replaces that receiver with a new claim/projection protocol whose strongest
benefit is atomic projection plus cursor, but the credit/pull experiment showed
that moving generic ownership to the receiver adds calls, writes, and recovery
coordination.

Recommendation: retain the runner and give it one plain-data private frame
operation. Its durable checkpoint remains authoritative. The source stores only
observational progress needed for lag, retention, redial, and diagnostics.

### 2. KV checkpoint and lifecycle facts

Fable is safer because it preserves measured candidate behavior. Codex is
cleaner because it removes `woken`, connection-presence replay, checkpoint lag,
the debounce state machine, repeated activation folds, and delivery facts that
re-enter public append.

The clean design is a materialized SQL projection:

- control events remain immutable audit facts;
- normalized configuration and runtime rows change in the same SQLite
  transaction as the control event;
- activation reads rows directly and reconciles obligations;
- restore rebuilds projection rows from staged events before atomic replacement;
- delivery-produced terminal facts use an internal transaction, not recursive
  public append;
- no KV state or synthetic `woken` event is required.

This is **hypothetical**. It earns inclusion only if a focused workerd slice
matches the candidate on singleton append, control append, clean/cold activation,
forced reactivation, and journal rebuild properties.

### 3. Delivery topology

Fable's single spine risks recreating the current problem in one 1,450-line
file: live sessions, wake redial, source claims, webhooks, poison isolation,
teardown, retry, and alarms still have different durable meanings. Codex keeps
the meanings clearer but introduces a new receiver and more modules than needed.

Recommended owners:

```text
StreamObject
  |-- StreamSql            journal + normalized config + transaction verbs
  |-- Frames               one bounded scan/hydration model + demand tail
  |-- LiveSessions         incarnation-local, no durable cursor
  |-- Outboxes             source-owned claim/cursor/retry/poison/alarm
  |-- ProcessorLinks       direct redial to existing receiver checkpoint
  |-- Transports           direct RPC/fetch, classification, disposal
  `-- Recovery             cold staging, validation, atomic replacement
```

`Outboxes` and `ProcessorLinks` may share a due-key scheduler and frame reader.
They must not share a cursor type or a mode-dependent `ackedOffset` meaning.

### 4. Transport boundary

The candidate's successful preview still produced 357 capability-returning
`ItxEntrypoint.get` exceptions, 341 expected R2 probes represented as errors, 49
cancellations, and warnings. Merely wrapping or reclassifying the sink does not
prove the native exception disappeared.

Recommendation:

1. Run the already-defined direct/forwarded capability-versus-plain-data probe.
2. Prefer an operation-specific direct RPC returning a plain acknowledgement.
3. Use fetch if forwarded plain RPC still inherits capability-session teardown.
4. Stop if a required target can only be reached through a generic,
   capability-returning dispatcher that cannot produce clean telemetry.

The target union must be closed and typed for first-party processors, Project
Worker delivery, stream cross-post, and webhooks. Whether arbitrary Itx
expressions are still a product requirement is a human decision, not an
implementation detail.

### 5. Public API

The user-level model should be exactly:

```text
append
subscribe
read
waitForEvent
```

Recommended rules:

- `append(...events)` returns no payload by default.
- `append({return: "offsets" | "events"}, ...events)` is the same operation.
- Internal result specialization is one private commit mode, not public
  `appendAck` or `appendOffsets` methods.
- `subscribe` has explicit ephemeral and durable forms. The ephemeral form owns
  a callback capability; the durable form owns a stable key, selector, target,
  start coordinate, and failure policy.
- Durable subscribe/replace/remove must be one coherent command surface. It may
  emit internal audit events, but callers should not need to know control-event
  type names.
- Subscribers implement singular `processEvent(event)`. Private transports send
  bounded frames and adapt them synchronously until the first thenable.
- `read` exposes scan progress and observed head; convenience point/head helpers
  are library utilities rather than additional kernel concepts.
- `waitForEvent` composes read and ephemeral subscribe, advances its cursor
  before async predicate work, rebinds after reset, and accepts an external
  `AbortSignal`.

The exact durable subscription lifecycle shape is the highest-priority human API
decision. Do not start runtime code while it is still represented indirectly as
an event-schema accident.

### 6. Rollback and data erase

Fable's automatic drop-on-version-mismatch is rejected. It can erase production
state during an ordinary first touch and turns a missed rollout step into silent
data destruction.

Forward and reverse procedure:

1. Stop Stream writes.
2. Obtain explicit human erase approval.
3. Run the enumerated erase operation and verify every estate.
4. Deploy the chosen binary, which creates only its own schema.
5. Run state, trace, log, metric, and acceptance checks.

An unexpected schema marker fails activation with a classified release-blocking
error. Rollback repeats the same explicit erase process. No binary contains a
data-compatible fallback or automatic destructive migration.

## Recommended Kernel

### Durable ownership

| Fact                                                   | Authority                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Event, offset, idempotency, floor                      | Source `StreamSql` journal                                                  |
| Subscription configuration and epoch                   | Source normalized config row, atomically projected from command/audit event |
| Ephemeral replay/live cursor                           | Session memory only                                                         |
| Generic push/webhook/cross-post cursor and exact claim | Source outbox row                                                           |
| Processor effect progress                              | Existing receiver runner checkpoint                                         |
| Processor source observation/retry                     | Source processor-link row                                                   |
| Fresh parsed payload                                   | Demand-bound frame cache only                                               |
| Retry deadline and terminal park                       | Mode-specific durable row                                                   |
| Alarm target                                           | Derived from due rows                                                       |
| Recovery generation                                    | Source metadata row                                                         |
| Wait progress                                          | Client utility memory                                                       |

### SQLite shape

Use explicit tables rather than one row whose fields change meaning by mode:

```text
stream_meta
events
event_chunks
subscription_config
outbox_state
processor_link_state
recovery_sessions + bounded staging tables
```

Important constraints:

- Schema bootstrap is one synchronous transaction.
- Ordinary append does not write delivery rows.
- A control command writes its event and materialized configuration in one
  transaction.
- Exact outbox claim commit precedes RPC/fetch.
- Acknowledgement advances only the source-owned outbox cursor.
- Processor acknowledgement updates only observational source state; receiver
  progress is authoritative.
- Generation and epoch fence every delayed completion.
- Offset allocation uses `max(journalHead, evictedFloor) + 1`.
- No durable-event compaction ships in the first rewrite.
- Ephemeral deletion and floor advancement are one transaction.
- Recovery stages and validates before one atomic replacement.

### State-machine budget

Count only externally meaningful lifecycle state:

1. Live session: opening, pumping, caught-up, closed.
2. Source outbox: ready, claimed, backoff, parked, derived from columns.
3. Processor link: ready, dialing, backoff, parked; receiver checkpoint remains
   external authority.
4. Recovery: staging, validated, replacing, terminal.
5. Existing runner progress/revival, retained rather than rewritten.

The alarm selector, append turn, frame reader, control projection, fresh tail,
and waiter are operations or derived state, not additional machines.

## Size Budget

Use one scope and one revision for every count.

- Exact-main comparable source-kernel set: about 5.0K physical lines.
- Candidate source-kernel replacement set: 8,207 physical lines in Fable's
  reproducible table; the broader eight-file coordination set is 8,483.
- Recommended target: 4,600-5,000 source-kernel lines.
- Hard stop: 5,200 lines unless a named required invariant explains the overrun
  and an equal amount of complexity is deleted elsewhere.
- Expected reduction: roughly 39%-44% versus the candidate source kernel and
  near parity to modestly smaller than main while retaining most candidate gain.
- Structural caps: no more than five rewritten-kernel machines, 35 mutable
  private fields, or one file above 1,100 lines.

The 4,250-line Codex target is a useful stretch goal, but it assumes a receiver
rewrite and several product deletions. The 5,440-line Fable target is a credible
fallback design but leaves the complete checkpoint/lifecycle mechanism intact.

Do not impose a test line cap. Preserve the candidate's property and fault
coverage, port deployed acceptance verbatim, and delete only duplicated harness
or assertion code.

## Acceptance Gates

### Performance

- **Improvement over main:** at least 24% aggregate p50 and mean improvement and
  at least 20% aggregate p95 improvement on the frozen equal-workload corpus.
- **Candidate retention:** no proven strong-win lane more than 10% slower at p50
  than the candidate; stable lanes within 5% or 0.15 ms, whichever is larger.
- **No hidden trade:** no lane more than 5% slower at p50 than main, and no
  meaningful p95/p99 regression without a bounded cause and explicit approval.
- **Wire:** singular public callback over private batching no worse than 1.25x
  the candidate batched PCM median. Actual singular wire RPC is forbidden.
- **Memory:** post-GC idle memory within 10% of the candidate demand-bound result,
  with payload release after demand disappears.
- Use fresh processes, immutable revisions, raw archives, process-cluster
  confidence intervals, and Node-host clocks around awaited network work.

### Correctness and operations

- Pure model/property tests for offset monotonicity, atomic variadic append,
  idempotency identity, materialized-projection equivalence, selector progress,
  exact claims, epoch/generation fences, poison isolation, and recovery.
- Kill points around append, claim, outbound call, receiver commit, source ack,
  alarm mutation, and final replacement.
- Existing runner integration with eventless at-head frames and scanned-through
  coordinates.
- Full local Stream and cross-domain matrices.
- Deployed cumulative, wire, lifecycle, recovery, security, ancestor, and
  storage suites with zero measurement or correctness retries.
- Zero unexplained errors, cancellations, warnings, stuck claims, divergent
  cursors, retry storms, or retained capabilities in preview telemetry.
- Frozen-clock tests where local `Date.now()` does not advance between I/O.

## Build Sequence

Testable slices do not imply a dual runtime. New modules may exist dark under
tests, but the shipping shell switches once and deletes the old kernel in the
same commit.

1. Freeze API decisions, exact baselines, benchmark corpus, telemetry taxonomy,
   and state-machine/line-count method.
2. Run two bounded decision probes:
   - materialized SQL control projection using the candidate append shape;
   - direct plain-data transport versus forwarded capability and fetch.
3. Stop or freeze the architecture from those results. Do not carry two options
   into production code.
4. Implement journal/read and append projections against a pure reference model.
5. Implement one frame reader and activation-local live subscriptions.
6. Implement source-owned outbox claims, retry, poison, alarm, and one real
   durable target.
7. Integrate the existing runner through the processor-link boundary.
8. Add remaining typed transports, reset-safe waits, retention floor, and cold
   recovery.
9. Wire the new shell, delete the old kernel and schema, regenerate contracts,
   and run the complete local gate in the same swap commit.
10. Deploy one preview version and pass the exact candidate/main comparison,
    complete acceptance matrix, and telemetry gate.
11. Obtain explicit production erase approval, erase, deploy, and verify. Do not
    merge this documentation PR as an implementation release.

## First 100-200 Lines

The first implementation artifact should settle the one uncertain architectural
pivot, not optimize a known hot path:

1. Define `stream_meta`, `subscription_config`, `outbox_state`, and
   `processor_link_state` DDL with all mode and claim invariants.
2. Define a typed `ControlDelta` emitted by the existing candidate-shaped fold.
3. Implement one synchronous `applyControlDelta(sql, delta)` transaction helper.
4. Add a model test proving `fold(events) == normalizedRows` across random
   configure, replace, remove, seek, pause, park, and resume sequences.
5. Benchmark ordinary singleton append, control append, and cold/reactivated
   activation against exact candidate and main.

Keep this slice below 200 production lines. If it cannot preserve candidate
singleton and activation behavior, discard the normalized-projection hypothesis
and use Fable's checkpoint design. That is a design-time collapse, not a runtime
fallback or compatibility path.

Deliberately wait on transport integration, retry tuning, frame-size changes,
fresh-tail refinements, sparse scan-plus-claim, keyed insert, recovery UI, and
runner refactoring.

## Human Decisions

Resolve these before implementation:

1. Does `subscribe` directly create both ephemeral and durable subscriptions,
   and what is the durable replace/remove handle shape?
2. Are arbitrary Itx delivery expressions still a product requirement, or can
   the rewrite use a closed first-party target union?
3. Can every required processor host be addressed directly and return plain
   data without the exception-producing capability boundary?
4. Is the built-in token bucket a product requirement, or can pause plus static
   append/backpressure limits replace it?
5. Must poison skip remain configurable, and which typed outcome may authorize
   skipping exactly one event?
6. What durable and ephemeral retention policies ship on day one?
7. Is reset-safe client-side `waitForEvent` the canonical utility contract?
8. What is the minimum introspection/metrics surface consumed by product UI and
   operations?
9. Who approves forward erase, reverse erase, the cutover window, and the
   post-cutover acceptance evidence?

Until those answers and the two decision probes exist, implementation would be
premature. The plans are sufficient to begin those decisions without
rediscovering the evidence.
