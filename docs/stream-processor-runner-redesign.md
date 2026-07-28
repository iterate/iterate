# Stream Processor Runner — Redesign Spec & Implementation Plan

**Status:** implemented; the phase list below is the historical cutover sequence.
**Design record:** [`stream-processor-runner-design-conversation.md`](./stream-processor-runner-design-conversation.md) (raw transcript — this file is the distilled spec; build from this one).

---

## Why

Over the last weeks, three unrelated concerns accreted onto the processor model:

1. **`reconcile` became a third mandatory hook** — but it only exists to centralize an "only act at the maximum durable offset" guard that was needed after refold semantics changed. A processor is not inherently a reconciler.
2. **`processEventBatch` became five things** — a transport batch doubles as a reduce batch, a concurrency group, an effect-failure group, a checkpoint transaction, and an observation that the scan reached the highest offset known to the runner. It started as a browser-SQLite optimisation; 6 of 8 overrides compensated for missing runner guarantees.
3. **The host is the star, processors are anonymous** — `createStreamProcessorHost(ctx)` hosts N processors via `host.add(factory)`, hand-fed `ctx`. The processor instance should be the star; the host should recede into plumbing.

Root fault: **one `{offset, state}` cursor means two incompatible things** — "my fold cache is valid through E" _and_ "all external work is acknowledged through E". A routine state-schema deploy therefore refolds _and re-runs `processEvent`_ across history, re-driving vendor calls.

---

## Settled semantic model

### The processor interface

```ts
abstract class StreamProcessor<Contract> {
  abstract readonly contract: Contract; // schema + slug + consumes
  protected validate?(args): void; // OPTIONAL, sync — throw to reject (inline/pre-commit only)
  protected reduce(args): State; // OPTIONAL, pure fold, default identity
  protected processEvent(args): undefined; // OPTIONAL, SYNCHRONOUS, event is null only for an eventless caught-up call
  // operator/inspection: snapshot(), getRuntimeState(), waitUntilEvent(), reReduce(), reprocessFrom(), skipThrough()
}
```

- **No public `reconcile`.** Reconciliation is ordinary `processEvent` logic under `delivery.caughtUp`. It normally rides the last consumed event in a caught-up scan; if that scan contains no consumed event, the runner makes one eventless call (`event: null`) over the final fold. Per-event dispatch guards `event !== null`.
- **No author-overridable `processEventBatch`.** It survives only as the internal Stream-DO→runner _wire callback_.
- A **stateless** processor implements only `processEvent`. A **pure fold** implements only `reduce`.

### The two block primitives are duals of one concept

"Refuse to let this event through until you're satisfied" — expressed at whichever commit position the runner occupies:

|                   | pre-commit (inline / core)                                            | post-commit (hosted processor)                            |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| **block**         | `validate` throws → **rejects the append**                            | `blockProcessorWhile(work)` awaits → **holds the cursor** |
| timing            | synchronous, before persist                                           | async, after commit                                       |
| `runInBackground` | shared — register thunk, arm keepalive, advance; author owns recovery | shared                                                    |

`processEvent` stays **synchronous**; the author explicitly picks `blockProcessorWhile` (order barrier) or `runInBackground` (overtaking, recovery-owned). `blockProcessorWhile` is a strict **per-event** barrier — event N+1 does not start until N's blocking work resolves. Transport batching never changes this.

### Two durable positions (progress)

```ts
type Progress<State> = {
  reduction: { reducerVersion: string; reducedThroughOffset: number; state: State };
  processing: { acknowledgedThroughOffset: number; cursorRevision: number };
};
// invariant (persisted): reducedThroughOffset <= acknowledgedThroughOffset
```

- **Core is the "reduction only, no processing cursor" case; hosted has both.** Graceful degradation — same structure, same re-reduce.
- Checkpoint **cadence is a runner policy** (every event / N / 50ms / idle / size / txn). In memory the runner tracks `completedThroughOffset`; it durably persists `acknowledgedThroughOffset` per policy. The gap is the deliberate at-least-once replay window.

### Operator controls (each appends an audit event to the journal)

- `reReduce()` — rebuild reduction cache through the acked cursor, **no effects**. Fires automatically on `reducerVersion` change.
- `reprocessFrom(offset, expectedCursorRevision)` — CAS; sets ack = `offset-1`, **bumps `cursorRevision`**, reconstructs state, then re-runs `reduce`+`processEvent` from `offset`. Snapshot honestly rewinds while it catches up.
- `skipThrough(offset, reason)` — manual, audited, fenced escape past a poison event; advances ack without running the effect.

### Failure

`blockProcessorWhile` permanent failure → **retry with backoff, indefinitely** (no `stalled` event; a wedge shows as growing lag). `runInBackground` is the non-blocking door. `skipThrough` is the only escape. **No auto-DLQ.**

### Idempotency

`delivery.idempotencyKey(key)` is derived deterministically from `authorSuppliedKey + sourceOffset + cursorRevision`. No random id, no `effectRevision`, no implicit processor prefix. Crash retry → same key (dedupes). `reprocessFrom` → new key (genuinely re-emits).

### Revival

- One core **`stream/processor-revived`** event, with `processorSlug` in its payload, is appended by the recovery adapter. Declaring it in `consumes` is optional and is only needed when the processor reacts to the fact itself.
- **`runInBackground` requires a recovery adapter** when losing the work's outcome would matter. The revival append wakes delivery even when the fact is unconsumed.
- Reaching head guarantees the revival turn at zero lag: a consumed event receives `caughtUp: true`; otherwise the runner supplies `processEvent(event: null, caughtUp: true)`.

### Waiting / snapshot

`waitUntilEvent(offset)` — single method, means **acknowledged-through**. `snapshot()` is pinned to `reducedThroughOffset`.

### Delivery context (passed to `processEvent`)

```ts
delivery: { phase: "catching-up" | "live"; highestObservedOffset: number;
            caughtUp: boolean; cursorRevision: number;
            idempotencyKey(key: string): string }
```

---

## Runner architecture

- **`StreamProcessorRunner`** — plain, runtime-neutral object (browser / DO / test). _The name is free on current main_ (only dead comments reference the deleted DO class).
- **The processor is passed INTO the runner.** `runner.openEventBatchCallback()` returns `{ checkpointOffset, processEventBatch }`. The callback reduces/processes **one event at a time**; transport batching lives entirely inside it. A hosted processor returns this pair from `wakeStreamProcessor`; the browser mirror calls the same runner method directly and passes incoming batches to the callback.
- **`durability` (optional adapter)** = `{ progress, recovery? }`. `progress`: read/commit the two-cursor record, CAS-fenced by `cursorRevision`. `recovery`: arm keepalive + append `stream/processor-revived` + `handleAlarm`. **No Cloudflare `ctx` in the runner core.**
- **The host dies (option B — thin registry).** The DO holds its processors as **named fields** + one `StreamProcessorRunner` per processor. A deliberately thin registry owns only: the single-DO-alarm multiplex, slug→runner wake routing, and building `durability` from `ctx`. This replaces `createStreamProcessorHost` / `host.add(factory)`. If the registry grows behavior beyond those three jobs, it has failed.
- **Two ways to use the same processor contract:**
  - `StreamProcessorRunner` processes post-commit event batches (Phase 1).
  - `StreamCoreProcessor` validates and reduces synchronously in the append transaction (Phase 2).

---

## Phase 1 — hosted processors (`StreamProcessorRunner`)

This is where the net reduction lives. Deletions/migrations measured on `origin/main`:

| Site                                                      | ~lines | Fate                                                                      |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `stream-processor.ts` public `reconcile` + caught-up gate | —      | **delete**                                                                |
| overridable `processEventBatch`                           | —      | **delete** (keep one internal batch callback)                             |
| `github-agent` ordering override                          | ~30    | **pure delete** (per-event blocking is default)                           |
| `agent` reconciliation path                               | ~120   | relocate → `processEvent` under `delivery.caughtUp`                       |
| `slack-agent` reconcile + caught-up status carry          | ~107   | relocate + private debounce                                               |
| `telegram-agent` caught-up typing carry                   | ~30    | private freshness                                                         |
| `capability-host` caught-up obligation gate               | ~36    | relocate → `processEvent` under `delivery.caughtUp`                       |
| `repo` caught-up creation obligation                      | ~40    | relocate → `processEvent` under `delivery.caughtUp`                       |
| `scheduler` alarm derivation                              | ~40    | absorb into runner                                                        |
| `browser-feed` / `browser-raw-events` SQLite batch        | ~45    | private transactional committer (writes + progress in ONE txn)            |
| `{offset,state}` snapshot                                 | —      | split → two cursors + `cursorRevision` fencing; refold runs `reduce` only |
| `createStreamProcessorHost` (4 DOs, `host.add`)           | —      | `StreamProcessorRunner` per processor + thin registry                     |

Three DOs (`slack`, `telegram`, `capability-host`) carry hand-written comments explaining how they work around _concurrent blockers within a batch_ — that whole category evaporates when blocking is per-event.

**Slice order (each independently reviewable):**

1. **Additive** — new `StreamProcessor` interface, `Progress` types, `delivery` context, `StreamProcessorRunner` skeleton, `durability`/`progress`/`recovery` adapter interfaces. Nothing deleted yet.
2. `StreamProcessorRunner` per-event loop + two-cursor progress adapter (DO-KV backed) + cadence policy.
3. **In-memory test harness = the executable spec** (see below).
4. Migrate **one** processor end-to-end (`agent`) as the proof: reconciliation → `processEvent` under `delivery.caughtUp`; verify per-event ordering.
5. Migrate the rest (capability-host, repo, slack, telegram, scheduler, github).
6. Browser transactional committer (feed + raw-events); `reducerVersion`→`reReduce`, output-schema reset→`reprocessFrom(1)`.
7. Delete the host; wire the thin registry into the 4 DOs.
8. Delete the now-dead `reconcile` / `processEventBatch` / caught-up hooks.

---

## Phase 2 — core unification (`InlineRunner`) — GATED, do second

- `StreamCoreProcessor` uses `validate` + `reduce` + `processEvent` with the DO's send/alarm capabilities injected as dependencies. `validate` is the pre-commit append gate.
- `InlineRunner`: **synchronous, await-free commit path**; `validate` throws → rejects the append; `processEvent` post-commit sync; only `runInBackground` (= `ctx.waitUntil`, no keepalive); progress = **reduction cache only** (no processing cursor); `reReduce` = `reducerVersion` mismatch replay (folds core's `CORE_STATE_VERSION` discard-on-wake into the shared mechanism). Core keeps `stream/woken` as its revival.
- Deletes ~200–300 lines of bespoke DO plumbing: `#reduce`/`#reduceCore` mode dispatch, `#validateAppend`, the `#processEvent` switch scaffolding, `#readCoreProcessorState` / `#checkpointCoreProcessorState` / `#catchUpCoreProcessorState`.
- **GATE:** a commit-path benchmark (append throughput + constructor fold time) must prove **zero regression** before cutover. The append path is the crown jewel — "do not make this async, no awaits", voice-streams-from-birth, OOM-in-constructor-bricks-the-stream. Ship Phase 1 first so the shared machinery is exercised on the recoverable post-commit path before the stream's own commit point runs on it.

---

## Test harness (the spec)

In-memory runner as the semantic specification. Must pin:

- transport-batch-division **invariance** (same journal as one batch / singletons / random partitions → identical outcomes),
- strict `blockProcessorWhile` ordering; `runInBackground` overtaking,
- `crash()` at every boundary; zero-lag revival,
- refold runs `reduce` only (no `processEvent`); stale-`cursorRevision` fencing,
- atomic browser SQLite failure,
- `validate` rejects the append (inline).

---

## Non-goals

- Physically merging core into one runner — core stays **inline, pre-commit** (it assigns offsets, owns `maxOffset`, and validates appends; it cannot run after commit). Unification is at the interface and shared reduction code, not the runner.
- Changing producer or stream-delivery batching — both kept.
