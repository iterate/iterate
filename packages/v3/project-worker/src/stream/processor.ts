// stream/processor.ts — THE PROCESSOR: two classes. `StreamProcessor` is what an author writes — a
// PURE class (a contract and three hooks: `reduce` / `processEvent` / `projectLiveState`, no
// constructor arguments, no storage, no stream), so `new PresenceProcessor().reduce({ event, state })` is a
// unit test. `ProcessorEngine` drives ONE such instance against a stream and a storage (serial
// chain, checkpoint, gap repair, at-head pass, version re-reduce, live-state publishing); the SDK's
// `StreamProcessorDurableObject` (sdk/) builds one per hosted facet. The author surface mirrors
// apps/os (`blockProcessorWhile`/`runInBackground`, `delivery.caughtUp`) so processors port both
// ways. Node-testable; bundled with zod into every loaded isolate as `processor.js` via
// sdk/index.ts (build-sdk.mjs). Runtime imports: lib/, stream/live-state.ts, stream/reduce-checkpoint.ts.
//
// THE CONCURRENCY CONTRACT:
//   1. ONE SERIAL CHAIN per processor — batches never interleave.
//   2. ONE EVENT AT A TIME inside a batch: this event's `blockProcessorWhile` work completes
//      before the next event's `processEvent` starts (a FIFO chain, awaited per event).
//   3. `runInBackground` work is deliberately NOT awaited — it may overtake later events; it is
//      a droppable attempt whose outcome must be recoverable from state at the next at-head pass.
//   4. ONE DURABLE COMMIT PER BATCH, after every event's blocking work settled — persist BEFORE
//      advancing past the last DURABLE offset. A failed batch persists nothing, retried whole.
//   5. The at-head pass: the last consumable event of a batch that reaches the stream head
//      carries `delivery.caughtUp: true`; a batch that reaches the head without one gets a single
//      extra `processEvent({ event: null, delivery: { caughtUp: true } })` call.
//
// DELIVERY IS PUSH-FIRST with a SCANNED-RANGE PROOF. The stream pushes
// `processEventBatch(events, range)` after every commit — the proof of the contiguous range scanned
// (`after` exclusive → `through` inclusive), so ephemeral holes, consumes-filters, and reboot gaps
// are all the same non-event — the cursor advances on the RANGE, never by counting events. A
// non-contiguous push triggers GAP REPAIR: read durable rows from the own cursor up to the push
// start, then process the push. Ephemeral events ride pushes ONLY (reads are durable-only; an
// ephemeral missed while a facet rebuilds is gone by design — nothing can redeliver it) and NEVER
// trigger a checkpoint write: an ephemeral-only range advances the cursor in memory alone, so a
// pure-ephemeral flood costs this class ZERO storage writes.
//
// `reduce` is a PURE reduce (new object out, its arguments immutable). The reduced state is
// CHECKPOINTED (reduce-checkpoint.ts) with the offset it was reduced through and the contract version
// it was reduced under; bumping `contract.version` re-reduces from offset 0 through `reduce` only
// (never re-running side effects) — and a re-reduce reads durable rows only, which is why durable
// product truth must never be derived from an ephemeral event.

import type { z } from "zod";
import { reportIssue } from "../lib/errors.ts";
import { LiveState } from "./live-state.ts";
import type { ReduceCheckpointStore } from "./reduce-checkpoint.ts";
import type { StreamEvent, StreamEventInput } from "./events.ts";

/** One owned event type: its payload schema (and prose for humans/docs). Shipped in the SDK
 *  too — userspace contracts carry real zod schemas, same as built-ins. */
export type EventDefinition = {
  description?: string;
  payloadSchema: z.ZodType;
};

export type ProcessorContract<State = unknown> = {
  slug: string;
  /** Bumping this re-reduces state from offset 0 (reduce only — side effects never re-run). */
  version: string;
  description?: string;
  /** What it reacts to: type strings, or "*" for every DURABLE event. Ephemeral events are
   *  delivered ONLY when their type is named here — `"*"` never sweeps them. */
  consumes: readonly string[];
  /** What its `append` is allowed to emit. */
  emits: readonly string[];
  /** The schema-initial state ("{} with every field defaulted" for zod contracts). */
  initialState: () => State;
};

/** The stream a processor reduces. `read` answers durable rows plus the scanned-offset-range proof:
 *  `scannedThroughOffset` is how far the read is CONTIGUOUSLY known (the last row when the page was
 *  CUT — by `limit` or by the server's byte budget — the stream's DURABLE mark when it was complete;
 *  never the in-memory head, whose ephemeral offsets a later incarnation may reuse), and `atHead`
 *  says which — a page's length says nothing (a budget cut is short of `limit` and not at head). */
export type ProcessorStream = {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]> | StreamEvent[];
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number; atHead: boolean }>;
};

/** The contiguity proof a delivery carries: the half-open offset window `(after, through]`. A chain
 *  of these (each `after` === the previous `through`) is how a subscriber proves it missed nothing. */
export type ScannedRange = { after: number; through: number };

export type ReduceArgs<State> = { event: StreamEvent; state: State };

export type ProcessEventArgs<State> = {
  /** The consumed event — or `null` for the eventless at-head pass. */
  event: StreamEvent | null;
  state: State;
  previousState: State;
  /** Emit (validated against `emits`, provenance-stamped) onto this processor's own stream. */
  append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>;
  /** Hold the cursor until `work` settles; FIFO with other blockers of the SAME event. */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** Fire-and-forget attempt; may overtake later events; outcome must be state-recoverable. */
  runInBackground: (work: () => Promise<unknown>) => void;
  delivery: { caughtUp: boolean };
};

/** THE ONE consumes rule — the processor engine, the subscription delivery loop, and the inline
 *  reduces all call this; there is no second copy to drift. `consumes` undefined = every durable event
 *  (a subscriber's default). "*" = every durable event. A NAMED type opts that type in, INCLUDING
 *  ephemerals ("*" NEVER sweeps ephemerals) — so a live-state watcher spells
 *  `consumes: ["events.iterate.com/live-state/changed"]` and filters `payload.key` itself. */
export function consumesEvent(
  consumes: readonly string[] | undefined,
  event: { type: string; ephemeral?: boolean },
): boolean {
  if (event.ephemeral) return consumes?.includes(event.type) ?? false;
  return consumes === undefined || consumes.includes("*") || consumes.includes(event.type);
}

/** What the ENGINE reduces: the contract's consumes, minus the one type no processor may ever reduce or
 *  react to — a live-state delta. Deltas are notifications ABOUT state; letting one feed a reduce is
 *  the feedback-loop class, made unspellable here rather than discouraged. */
const reducesEvent = (consumes: readonly string[], event: { type: string; ephemeral?: boolean }) =>
  event.type !== "events.iterate.com/live-state/changed" && consumesEvent(consumes, event);

/** THE AUTHOR CLASS. A processor is a contract, three hooks and one helper (`idempotencyKey`),
 *  nothing else: no constructor arguments, no stream, no storage — a plain object a unit test
 *  constructs with `new` and calls `reduce` on. Deps an effect needs (a client, a binding) arrive
 *  through the subclass's own constructor, exactly as they would for any class. One instance lives as
 *  long as its host; a field on it is RUNTIME state (gone with the host), which `projectLiveState`
 *  may reduce into the live view. */
export abstract class StreamProcessor<State> {
  abstract readonly contract: ProcessorContract<State>;

  /** Pure reduce. Return the NEXT state (a new object) — or null/undefined to keep the current. */
  reduce(_args: ReduceArgs<State>): State | null | undefined {
    return undefined;
  }

  /** Side-effect hook. Synchronous by design: register async work via the two helpers on args. */
  processEvent(_args: ProcessEventArgs<State>): undefined {}

  /** The live-state PROJECTION — the shape clients see and the shape the diffs are computed over.
   *  DEFAULT: the reduced state verbatim, so EVERY processor's reduced state is live out of the box —
   *  a delta emits on every change whether or not anyone is watching. That is deliberate: the delta
   *  is an EPHEMERAL, unconsumable event (memory-only, no storage write, dropped at delivery if no
   *  subscriber names its key), so "always live" costs an offset and a cheap diff, nothing durable.
   *  Override to redact/trim, or to REDUCE IN RUNTIME FIELDS the reduce doesn't own
   *  (`return { ...state, lastSeenMs: this.lastSeenMs }`). The engine re-projects after EVERY batch,
   *  so a runtime field bumped inside `processEvent` publishes on its own; one changed outside a batch
   *  (an RPC method on the host) needs the host's `publishLiveState()`. */
  projectLiveState(state: State): unknown {
    return state;
  }

  /** Stable idempotency key namespaced by slug; pass the event being processed for a per-event key. */
  idempotencyKey(key: string, event?: StreamEvent): string {
    return event ? `${this.contract.slug}/${key}@${event.offset}` : `${this.contract.slug}/${key}`;
  }
}

/** THE ENGINE: drives one `StreamProcessor` against a stream and a storage. Everything below the
 *  author's three hooks lives here — the serial chain, the checkpoint, gap repair from the
 *  scanned-range proof, the at-head pass, version re-reduces, live-state publishing. Constructed by the
 *  host (`StreamProcessorDurableObject` with the facet's kv and `env.ITX`; a test with the in-memory
 *  stand-ins in test-support.ts). */
export class ProcessorEngine<State> {
  readonly processor: StreamProcessor<State>;
  readonly #contract: ProcessorContract<State>;
  readonly #stream: ProcessorStream;
  readonly #storage: ReduceCheckpointStore;

  /** Rule 1: every batch runs on this chain, one after another. */
  #serialBatchChain: Promise<void> = Promise.resolve();
  // ── THE REDUCED STATE and the offset of the durable log it was reduced through — rehydrated by the
  // constructor from the checkpoint (reduce-checkpoint.ts), advanced by every batch, checkpointed on
  // the batches that carried a durable. ──
  #reducedState: State;
  #reducedThroughOffset: number;
  /** The checkpoint the constructor found under ANOTHER contract version: the input to the one
   *  re-reduce (#rereduceIfVersionChanged) the chain runs before anything else; cleared once it ran. */
  #staleCheckpoint?: { reducedThroughOffset: number; state: State };
  /** The highest `range.through` ever SHOWN to this processor (see processEventBatch). */
  #pushedThroughOffset?: number;
  /** A refusal that can only repeat — the checkpoint over its cell (stamped `retryable: false`):
   *  LATCHED for this incarnation, so every later batch, catch-up and read verb rejects with it at
   *  once instead of re-reading the log and re-reducing into the same wall on every push and wake.
   *  A fresh incarnation (the host's quiesce, an eviction) tries once more. */
  #latchedRefusal?: Error;
  /** waitUntilProcessed's waiting callers, resolved as the cursor advances. */
  readonly #waitUntilProcessedWaiters: { offset: number; resolve: () => void }[] = [];
  /** ONE LiveState holder (stream/live-state.ts) — the revision chain and the diff→emit dance. Born
   *  with the engine, so its epoch is minted once per incarnation, seeded in the constructor. */
  readonly #liveState: LiveState<unknown>;

  constructor(
    processor: StreamProcessor<State>,
    deps: { stream: ProcessorStream; storage: ReduceCheckpointStore },
  ) {
    this.processor = processor;
    this.#contract = processor.contract;
    this.#stream = deps.stream;
    this.#storage = deps.storage;
    // The checkpoint, read synchronously — ONE row (reduce-checkpoint.ts), so cursor and state never
    // disagree; the only checkpoint that cannot be used as-is is one written under another contract
    // version. That one is kept as #staleCheckpoint: the durable log is re-reduced from offset 0
    // through its cursor (reduce only) as the chain's first work — the one-time cost of a version bump.
    const { slug, version } = this.#contract;
    const checkpoint = this.#storage.read<State>(slug);
    if (checkpoint?.reducerVersion === version) {
      this.#reducedState = checkpoint.state ?? this.#contract.initialState();
      this.#reducedThroughOffset = checkpoint.reducedThroughOffset;
    } else {
      this.#reducedState = this.#contract.initialState();
      this.#reducedThroughOffset = 0;
      if (checkpoint)
        this.#staleCheckpoint = {
          reducedThroughOffset: checkpoint.reducedThroughOffset,
          state: checkpoint.state ?? this.#reducedState,
        };
    }
    // The live-state holder, seeded with the projection of the state this incarnation starts from —
    // after a version bump the OLD version's, so the publish that follows the re-reduce emits the
    // one heal delta clients synced to the old state need (its `from` matches no rev they hold, so
    // they re-seed; an unchanged projection emits nothing, there being nothing to heal). The
    // projection is the author's code: a throw here costs the seed (the first publish then diffs
    // against `undefined`), never the engine.
    let seed: unknown;
    try {
      seed = processor.projectLiveState(
        this.#staleCheckpoint ? this.#staleCheckpoint.state : this.#reducedState,
      );
    } catch (error) {
      reportIssue("processor.live-state", error, { slug });
      seed = undefined;
    }
    this.#liveState = new LiveState(this.#stream, slug, seed);
  }

  /** THE SEED DOOR for live-state clients: `{rev, state}` read together (single-threaded ⇒
   *  atomically), which is what lets a client chain patches exactly instead of guessing which
   *  changes its snapshot already contains. */
  async liveSnapshot(): Promise<{ rev: number; state: unknown }> {
    if (!this.#reducedThroughPushedHead()) await this.catchUpFromLog();
    return this.#liveState.snapshot();
  }

  /** Emit a delta for the CURRENT projection (reduced + any runtime fields) if it changed. The engine
   *  calls this after every batch; the host calls it after a runtime field moved outside a batch. A
   *  throwing projection loses only its notification (the client re-seeds on the chain gap). */
  publishLiveState(): void {
    let projection: unknown;
    try {
      projection = this.processor.projectLiveState(this.#reducedState);
    } catch (error) {
      reportIssue("processor.live-state", error, { slug: this.#contract.slug });
      return;
    }
    this.#liveState.set(projection);
  }

  // ── the drive doors ──

  /** THE push door: the stream (or hosting facet) hands the just-committed batch with its
   *  range. Contiguous → reduce it directly (the fast path — no read); anything else → gap
   *  repair from the own cursor. Fire-and-forget safe: enqueues on the serial chain. */
  processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    // Recorded SYNCHRONOUSLY: the head this processor has been SHOWN. Read verbs skip their
    // wake when the reduce has provably reached it — the fast path that deletes one parent read
    // RPC from every capability dispatch (and every level of rule-names-rule nesting) once caught up.
    this.#pushedThroughOffset = Math.max(this.#pushedThroughOffset ?? 0, range.through);
    return this.#runOnSerialChain(async () => {
      await this.#rereduceIfVersionChanged();
      // DURABLE GAP REPAIR is the ONLY reason not to process the push immediately: a durable prefix
      // the push assumes but we haven't reduced is healed from the log FIRST — up to the push start
      // and no further, because the push carries fresh named ephemerals the log can't return (reads
      // are durable-only), so the push itself is processed afterwards, never replaced by a catch-up.
      // The repair never delivers caughtUp: the push decides at-head. The log can run out below
      // `range.after` only when that offset was handed to an ephemeral (an ephemeral-only batch
      // never moves the durable mark) — then there is nothing durable left to heal, and the push
      // is processed just the same.
      while (this.#reducedThroughOffset < range.after) {
        const after = this.#reducedThroughOffset;
        const page = await this.#stream.read(after, 500);
        if (page.scannedThroughOffset <= after) break;
        await this.#reduceAndCommitEventBatch(
          page.events.filter((event) => event.offset <= range.after),
          { after, through: Math.min(page.scannedThroughOffset, range.after) },
          false,
        );
      }
      // ALWAYS process the push — no push is ever discarded. Durables reduce iff fresh (`offset >
      // cursor`); ephemerals ALWAYS deliver (one push, unredeliverable); the cursor never regresses.
      // A wholly-behind (stale) push reduces nothing and just delivers its ephemerals. At head iff
      // this push reaches the head shown so far (set above, synchronously, before this closure runs).
      await this.#reduceAndCommitEventBatch(
        events,
        range,
        range.through >= this.#pushedThroughOffset!,
      );
    });
  }

  /** Catch up from the own checkpoint (a cold boot, the read verbs, the barrier): reduce the durable
   *  log from the cursor to the head, page by page — a failed batch, a missed push, or a fresh
   *  incarnation can never skip a durable event. A wake carries nothing. */
  catchUpFromLog(): Promise<void> {
    return this.#runOnSerialChain(async () => {
      await this.#rereduceIfVersionChanged();
      for (;;) {
        const after = this.#reducedThroughOffset;
        const page = await this.#stream.read(after, 500);
        if (page.scannedThroughOffset <= after) return; // no new contiguous events beyond the cursor: AT HEAD already
        // The page says whether it reached the head — never judge by its length: the server cuts a
        // page by `limit` OR by its byte budget (rule 5's caught-up pass rides the last page).
        await this.#reduceAndCommitEventBatch(
          page.events,
          { after, through: page.scannedThroughOffset },
          page.atHead,
        );
        if (page.atHead) return;
      }
    });
  }

  // ── the read surface ──

  /** Reduce-and-effects caught up through the log, then `{ offset, state }`. */
  async snapshot(): Promise<{ offset: number; state: State }> {
    if (!this.#reducedThroughPushedHead()) await this.catchUpFromLog();
    return { offset: this.#reducedThroughOffset, state: this.#reducedState };
  }

  /** Provably reduced through the head SHOWN so far → the read verbs skip their catch-up read. */
  #reducedThroughPushedHead(): boolean {
    return (
      this.#pushedThroughOffset !== undefined &&
      this.#reducedThroughOffset >= this.#pushedThroughOffset
    );
  }

  /** THE barrier verb (read-your-writes): resolves once processed AT LEAST through `offset`. An
   *  offset ABOVE the durable mark (an ephemeral's) is reached only if this processor was pushed it —
   *  the log cannot prove past the mark, so a wake alone never advances there. */
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    const { offset, timeoutMs = 10_000 } = input;
    return new Promise<void>((resolve, reject) => {
      if (this.#reducedThroughOffset >= offset) return resolve();
      const waiter = {
        offset,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        // A timed-out waiter LEAVES the list — otherwise every later batch re-scans it forever.
        this.#waitUntilProcessedWaiters.splice(this.#waitUntilProcessedWaiters.indexOf(waiter), 1);
        reject(
          new Error(
            `processor "${this.#contract.slug}" did not reach offset ${offset} in ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.#waitUntilProcessedWaiters.push(waiter);
      // The catch-up (and the version re-reduce it runs first) resolves the waiter as the cursor
      // moves. A rejecting self-pull (read threw) rejects THIS waiter promptly with the real error,
      // not a wait-until-timeout with a generic message.
      void this.catchUpFromLog().catch((error) => {
        const i = this.#waitUntilProcessedWaiters.indexOf(waiter);
        if (i === -1) return; // already resolved/timed-out
        this.#waitUntilProcessedWaiters.splice(i, 1);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  // ── the engine (private) ──

  /** Serialize on the chain. THE RULE: never await your own chain from inside a batch — a
   *  processor that appends during its batch would deadlock, which is why every append→drive
   *  caller is fire-and-forget. */
  #runOnSerialChain(work: () => Promise<void>): Promise<void> {
    const run = this.#serialBatchChain.then(() => {
      if (this.#latchedRefusal) throw this.#latchedRefusal;
      return work();
    });
    this.#serialBatchChain = run.catch(() => {}); // a failed batch never wedges the chain; retry via wake
    return run;
  }

  /** The one-time cost of a contract version bump: re-reduce the durable log from offset 0 through
   *  the OLD cursor — `reduce` only, never `processEvent` (those effects already ran) — and checkpoint
   *  under the new version. Never past the old cursor: events beyond it are the normal flow's work,
   *  and re-reducing to the head instead would judge an already-queued in-flight push stale and
   *  swallow its effects. Durable rows only, so (by design) it never sees dead ephemerals. */
  async #rereduceIfVersionChanged(): Promise<void> {
    if (!this.#staleCheckpoint) return;
    const target = this.#staleCheckpoint.reducedThroughOffset;
    let state = this.#contract.initialState();
    let reducedThroughOffset = 0;
    while (reducedThroughOffset < target) {
      const page = await this.#stream.read(reducedThroughOffset, 500);
      for (const event of page.events)
        if (event.offset <= target && reducesEvent(this.#contract.consumes, event))
          state = this.processor.reduce({ event, state }) ?? state;
      if (page.scannedThroughOffset <= reducedThroughOffset) break; // nothing left below the target
      reducedThroughOffset = Math.min(page.scannedThroughOffset, target);
    }
    this.#writeCheckpointOrLatch(
      this.#contract.slug,
      { reducerVersion: this.#contract.version, reducedThroughOffset: target },
      state,
      true,
    );
    this.#reducedState = state;
    this.#reducedThroughOffset = target;
    this.#staleCheckpoint = undefined;
    // The holder was seeded at the OLD version's projection (constructor): this publish is the one
    // heal delta for clients synced to it.
    this.publishLiveState();
    this.#resolveWaitUntilProcessedWaiters(target);
  }

  /** Rules 2–5 over one range (the caller has healed any durable prefix gap first).
   *  DURABLES reduce at-most-once — `offset > cursor`. EPHEMERALS ALWAYS deliver — each rides exactly
   *  one push and can never be a redelivery, so a durable-only wake that clamped the cursor PAST an
   *  ephemeral offset must not suppress it. The cursor is a DURABLE-reduce watermark and never
   *  regresses. There is no separate ephemeral path. */
  async #reduceAndCommitEventBatch(
    events: StreamEvent[],
    range: ScannedRange,
    atHead: boolean,
  ): Promise<void> {
    const reducedThroughOffsetBefore = this.#reducedThroughOffset;
    const stateBefore = this.#reducedState;
    let state = stateBefore;
    const consumableEvents = events.filter(
      (event) =>
        reducesEvent(this.#contract.consumes, event) &&
        (event.ephemeral || event.offset > reducedThroughOffsetBefore),
    );
    let caughtUpDelivered = false;
    for (let i = 0; i < consumableEvents.length; i++) {
      const last = i === consumableEvents.length - 1;
      state = await this.#reduceAndProcessEvent(consumableEvents[i], state, atHead && last);
      if (atHead && last) caughtUpDelivered = true;
    }
    // Rule 5: reached the head with no caught-up event → one eventless at-head pass.
    if (atHead && !caughtUpDelivered) state = await this.#reduceAndProcessEvent(null, state, true);

    // Rule 4: ONE persist per range, iff a DURABLE actually ADVANCED the cursor. The
    // cursor never REGRESSES (`max`), so a wholly-behind (stale) push leaves it put — and must NOT
    // re-persist (a stale durable re-push already reduced is a no-op write; a pure-ephemeral range
    // writes zero — the flood stays free). `advanced` excludes the stale re-push; `sawDurable`
    // excludes the ephemeral-only range. (This is why B's stale push delivers its ephemerals in
    // memory yet persists nothing.)
    const reducedThroughOffset = Math.max(reducedThroughOffsetBefore, range.through);
    const advanced = reducedThroughOffset > reducedThroughOffsetBefore;
    const sawDurable = events.some((event) => !event.ephemeral);
    if (sawDurable && advanced)
      this.#writeCheckpointOrLatch(
        this.#contract.slug,
        { reducerVersion: this.#contract.version, reducedThroughOffset },
        state,
        state !== stateBefore,
      );
    this.#reducedState = state;
    this.#reducedThroughOffset = reducedThroughOffset;
    this.#resolveWaitUntilProcessedWaiters(reducedThroughOffset);
    // Persist FIRST, emit the live-state delta second (a crash between loses only a notification,
    // healed by the chain gap; never state). The holder diffs against the previous projection and
    // no-ops if unchanged. Re-projected after EVERY batch, not only when the reduce moved: a runtime
    // field the author bumped inside `processEvent` (reduced in by `projectLiveState`) publishes on
    // its own.
    this.publishLiveState();
  }

  /** THE per-event primitive (rules 2–3) — the batch loop and the eventless at-head pass both come
   *  here: a GUARDED reduce, then `processEvent` with a FIFO blocker chain drained to a FIXED POINT.
   *  Returns the next state; owns NO cursor / persist / waiter — the caller does. */
  async #reduceAndProcessEvent(
    event: StreamEvent | null,
    state: State,
    caughtUp: boolean,
  ): Promise<State> {
    const { slug, version, emits } = this.#contract;
    const previousState = state;
    if (event) {
      let next: State | null | undefined;
      try {
        next = this.processor.reduce({ event, state });
      } catch (error) {
        // A malformed/hostile event must not wedge the reduce forever: record the skip, move on.
        reportIssue("processor.reduce", error, { slug, offset: event.offset });
        next = undefined;
      }
      state = next ?? state;
    }
    // FIFO blocker chain for THIS event (rule 2); background work escapes it (rule 3).
    let blockers: Promise<unknown> = Promise.resolve();
    this.processor.processEvent({
      event,
      state,
      previousState,
      // Emit onto the own stream: every event validated against the declared `emits` and stamped
      // with its provenance — this processor's slug/version, plus what it was processing.
      append: async (...emittedEvents) => {
        for (const emitted of emittedEvents) {
          if (!emits.includes(emitted.type))
            throw new Error(
              `processor "${slug}" emits ${JSON.stringify(emitted.type)} without declaring it`,
            );
          emitted.source = {
            processor: {
              slug,
              version,
              ...(event && { whileProcessing: { offset: event.offset, type: event.type } }),
            },
          };
        }
        return await this.#stream.append(...emittedEvents);
      },
      blockProcessorWhile: (work) => {
        blockers = blockers.then(() => work());
      },
      runInBackground: (work) => {
        void work().catch((error) => reportIssue("processor.background", error, { slug }));
      },
      delivery: { caughtUp },
    });
    // STRICT PER-EVENT ORDERING (rule 2): drain the blocker chain to a FIXED POINT. A
    // blockProcessorWhile called from INSIDE a running blocker extends the chain (still THIS event's
    // blocking work), so re-await until it stops growing — latching the pre-nesting snapshot would
    // let the next event's processEvent (and the batch commit) overtake it.
    for (let awaited: Promise<unknown> | undefined; awaited !== blockers; ) {
      awaited = blockers;
      await awaited;
    }
    return state;
  }

  /** The checkpoint write, with the latch: a refusal stamped `retryable: false` can only repeat. */
  #writeCheckpointOrLatch(
    slug: string,
    cursor: { reducerVersion: string; reducedThroughOffset: number },
    state: State,
    stateChanged: boolean,
  ): void {
    try {
      this.#storage.write(slug, cursor, state, stateChanged);
    } catch (error) {
      if ((error as { retryable?: unknown } | null)?.retryable === false)
        this.#latchedRefusal = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /** Resolve the waiters a cursor advance satisfies; keep the rest. */
  #resolveWaitUntilProcessedWaiters(reducedThroughOffset: number): void {
    for (const w of this.#waitUntilProcessedWaiters.splice(0)) {
      if (reducedThroughOffset >= w.offset) w.resolve();
      else this.#waitUntilProcessedWaiters.push(w);
    }
  }
}
