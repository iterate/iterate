// stream/processor.ts — THE PROCESSOR: `StreamProcessor`, the PURE class an author writes (a
// contract and three hooks, no constructor arguments, no storage, no stream — a unit test constructs
// it with `new`), and `ProcessorEngine`, which drives ONE such instance against a stream and a
// storage; the SDK's `StreamProcessorDurableObject` builds one per hosted facet. The author surface
// mirrors apps/os so processors port both ways. Node-testable; bundled into every loaded isolate as
// `processor.js` (sdk/index.ts), so nothing here imports cloudflare:workers. Four concepts ride with it:
//   events             — `StreamEventInput` / `StreamEvent`, the envelope, and the idempotency rules
//   reduce checkpoint  — `ReduceCheckpointTable`, THE ONE spelling of a persisted reduce checkpoint
//   live state         — `LiveState`, one value, its revision chain and the diff→emit delta
//   processor contract — `defineProcessorContract`, the zod contract helper (zod stays off the worker script)
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
// DELIVERY IS PUSH-FIRST with a SCANNED-RANGE PROOF: the cursor advances on the RANGE a push
// carries, never by counting events, so ephemeral holes, consumes-filters and reboot gaps are all
// the same non-event. A non-contiguous push triggers GAP REPAIR: read durable rows from the own
// cursor up to the push start, then process the push. Ephemeral events ride pushes ONLY (an
// ephemeral missed while a facet rebuilds is gone by design) and NEVER trigger a checkpoint write,
// so a pure-ephemeral flood costs this class ZERO storage writes.
//
// `reduce` is a PURE reduce (new object out, its arguments immutable), CHECKPOINTED
// (`ReduceCheckpointTable` below) with the offset and contract version it was reduced under; bumping
// `contract.version` re-reduces from offset 0 through `reduce` only, never re-running side effects —
// over durable rows only, which is why durable product truth must never derive from an ephemeral.

import { z } from "zod";
import { reportIssue, jsonEqual, codedError, diff } from "../lib.ts";

/** What a processor declares: its checkpoint slug and reducer version, what it consumes and emits,
 *  and its initial state (`defineProcessorContract` below builds one from zod schemas). */
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
  /** The zod payload schema for a consumed event type (owned or a dep's), or undefined if the type
   *  is unknown or the contract declares no `events` catalog. The engine validates a consumed event's
   *  payload against it before reducing (a malformed payload for a KNOWN event is skipped, never
   *  folded). Present on `defineProcessorContract` contracts; a hand-built core contract omits it and
   *  reduces unvalidated. */
  payloadSchemaFor?: (type: string) => z.ZodType | undefined;
};

/** The stream a processor reduces. `read` answers durable rows plus the proof: `scannedThroughOffset`
 *  is how far the read is CONTIGUOUSLY known (never past the durable mark — stream.ts), and `atHead`
 *  says whether the page was cut; its length says nothing (a budget cut is short of `limit`). */
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

export type ReduceArgs<State, Event = StreamEvent> = { event: Event; state: State };

export type ProcessEventArgs<State, Event = StreamEvent> = {
  /** The consumed event — or `null` for the eventless at-head pass. */
  event: Event | null;
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

/** THE AUTHOR CLASS: a contract, three hooks and one helper. Deps an effect needs arrive through
 *  the subclass's own constructor, as for any class. One instance lives as long as its host; a field
 *  on it is RUNTIME state (gone with the host), which `projectLiveState` may reduce into the live view. */
export abstract class StreamProcessor<State, Event extends StreamEvent = StreamEvent> {
  abstract readonly contract: ProcessorContract<State>;

  /** Pure reduce. Return the NEXT state (a new object) — or null/undefined to keep the current. The
   *  `Event` type param — a discriminated union of the events the contract consumes — narrows
   *  `event.payload` per `event.type` inside the body, so no cast is needed; it defaults to the
   *  untyped `StreamEvent` for processors that don't declare one. */
  reduce(_args: ReduceArgs<State, Event>): State | null | undefined {
    return undefined;
  }

  /** Side-effect hook. Synchronous by design: register async work via the two helpers on args. */
  processEvent(_args: ProcessEventArgs<State, Event>): undefined {}

  /** The live-state PROJECTION — the shape clients see and the diffs are computed over. DEFAULT: the
   *  reduced state verbatim, so every processor is live out of the box; that is deliberate — the
   *  delta is an EPHEMERAL event, so "always live" costs an offset and a cheap diff, nothing durable.
   *  Override to redact, or to REDUCE IN RUNTIME FIELDS (`return { ...state, lastSeenMs: this.lastSeenMs }`);
   *  the engine re-projects after EVERY batch, and a field changed outside a batch needs the host's
   *  `publishLiveState()`. */
  projectLiveState(state: State): unknown {
    return state;
  }

  /** Stable idempotency key namespaced by slug; pass the event being processed for a per-event key. */
  idempotencyKey(key: string, event?: StreamEvent): string {
    return event ? `${this.contract.slug}/${key}@${event.offset}` : `${this.contract.slug}/${key}`;
  }
}

/** THE ENGINE: everything below the author's three hooks — the serial chain, the checkpoint, gap
 *  repair, the at-head pass, version re-reduces, live-state publishing. Constructed by the host
 *  (`StreamProcessorDurableObject`; a test with the stand-ins in test-support.ts). */
export class ProcessorEngine<State> {
  readonly processor: StreamProcessor<State>;
  readonly #contract: ProcessorContract<State>;
  readonly #stream: ProcessorStream;
  readonly #storage: ReduceCheckpointTable;

  /** Rule 1: every batch runs on this chain, one after another. */
  #serialBatchChain: Promise<void> = Promise.resolve();
  /** The reduced state and the durable offset it was reduced through — checkpointed on the batches
   *  that carried a durable. */
  #reducedState: State;
  #reducedThroughOffset: number;
  /** A checkpoint found under ANOTHER contract version: the input to the one re-reduce the chain
   *  runs before anything else; cleared once it ran. */
  #staleCheckpoint?: { reducedThroughOffset: number; state: State };
  /** The highest `range.through` ever SHOWN to this processor (see processEventBatch). */
  #pushedThroughOffset?: number;
  /** A refusal that can only repeat — the checkpoint over its cell (stamped `retryable: false`):
   *  LATCHED for this incarnation, so every later batch, catch-up and read verb rejects with it at
   *  once instead of re-reducing into the same wall on every push and wake. A fresh incarnation
   *  tries once more. */
  #latchedRefusal?: Error;
  /** waitUntilProcessed's waiting callers, resolved as the cursor advances. */
  readonly #waitUntilProcessedWaiters: { offset: number; resolve: () => void }[] = [];
  /** Born with the engine, so its epoch is minted once per incarnation. */
  readonly #liveState: LiveState<unknown>;

  constructor(
    processor: StreamProcessor<State>,
    deps: { stream: ProcessorStream; storage: ReduceCheckpointTable },
  ) {
    this.processor = processor;
    this.#contract = processor.contract;
    this.#stream = deps.stream;
    this.#storage = deps.storage;
    // ONE row, so cursor and state never disagree; one written under another contract version is
    // kept as #staleCheckpoint for the chain's first work.
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
    // Seeded with the projection of the state this incarnation starts from — after a version bump
    // the OLD version's, so the publish that follows the re-reduce emits the one heal delta clients
    // synced to the old state need. The projection is the author's code: a throw here costs the
    // seed, never the engine.
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

  /** THE SEED DOOR for live-state clients (LiveState.snapshot), caught up first. */
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

  /** THE push door: contiguous → reduce it directly (no read); anything else → gap repair from the
   *  own cursor first. Fire-and-forget safe: enqueues on the serial chain. */
  processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    // Recorded SYNCHRONOUSLY: the head this processor has been SHOWN. Read verbs skip their catch-up
    // when the reduce has provably reached it — the fast path that deletes one parent read RPC from
    // every capability dispatch once caught up.
    this.#pushedThroughOffset = Math.max(this.#pushedThroughOffset ?? 0, range.through);
    return this.#runOnSerialChain(async () => {
      await this.#rereduceIfVersionChanged();
      // GAP REPAIR heals the durable prefix from the log FIRST — up to the push start and no
      // further, because the push carries fresh ephemerals the log cannot return, so the push
      // itself is processed afterwards, never replaced by a catch-up. The repair never delivers
      // caughtUp: the push decides at-head. The log can run out below `range.after` only when that
      // offset was handed to an ephemeral — then there is nothing durable left to heal.
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
      // ALWAYS process the push — no push is ever discarded (a wholly-behind one reduces nothing and
      // just delivers its ephemerals). At head iff this push reaches the head shown so far.
      await this.#reduceAndCommitEventBatch(
        events,
        range,
        range.through >= this.#pushedThroughOffset!,
      );
    });
  }

  /** Catch up from the own checkpoint (a cold boot, the read verbs, the barrier), page by page — a
   *  failed batch, a missed push, or a fresh incarnation can never skip a durable event. */
  catchUpFromLog(): Promise<void> {
    return this.#runOnSerialChain(async () => {
      await this.#rereduceIfVersionChanged();
      for (;;) {
        const after = this.#reducedThroughOffset;
        const page = await this.#stream.read(after, 500);
        if (page.scannedThroughOffset <= after) return; // nothing beyond the cursor: at head already
        // The page says whether it reached the head — never judge by its length (rule 5's caught-up
        // pass rides the last page).
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
      // A rejecting catch-up (read threw) rejects THIS waiter promptly with the real error, not a
      // wait-until-timeout with a generic message.
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
   *  the OLD cursor (`reduce` only — those effects already ran) and checkpoint under the new
   *  version. Never past the old cursor: re-reducing to the head instead would judge an
   *  already-queued in-flight push stale and swallow its effects. */
  async #rereduceIfVersionChanged(): Promise<void> {
    if (!this.#staleCheckpoint) return;
    const target = this.#staleCheckpoint.reducedThroughOffset;
    let state = this.#contract.initialState();
    let reducedThroughOffset = 0;
    while (reducedThroughOffset < target) {
      const page = await this.#stream.read(reducedThroughOffset, 500);
      for (const event of page.events)
        if (event.offset <= target && reducesEvent(this.#contract.consumes, event))
          // The SAME validate+normalize+fold as the live flow — a replay must reproduce it exactly,
          // else a coercion applied live but not here would make a version bump rewrite state.
          state = this.#validateNormalizeAndReduce(event, state).state;
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
    // The one heal delta for clients synced to the OLD version's projection (the constructor's seed).
    this.publishLiveState();
    this.#resolveWaitUntilProcessedWaiters(target);
  }

  /** Rules 2–5 over one range (the caller has healed any durable prefix gap first). DURABLES reduce
   *  at-most-once (`offset > cursor`); EPHEMERALS ALWAYS deliver — each rides exactly one push and
   *  can never be a redelivery, so a durable-only wake that clamped the cursor PAST an ephemeral
   *  offset must not suppress it. The cursor is a DURABLE-reduce watermark and never regresses. */
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
      const r = await this.#reduceAndProcessEvent(consumableEvents[i], state, atHead && last);
      state = r.state;
      // A skipped (malformed) last event never delivered caught-up — the eventless pass below does.
      if (atHead && last && r.processed) caughtUpDelivered = true;
    }
    // Rule 5: reached the head with no caught-up event → one eventless at-head pass.
    if (atHead && !caughtUpDelivered)
      state = (await this.#reduceAndProcessEvent(null, state, true)).state;

    // Rule 4: ONE persist per range, iff a DURABLE actually ADVANCED the cursor — `advanced`
    // excludes a stale re-push (a no-op write), `sawDurable` the ephemeral-only range (the flood
    // stays free).
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
    // Persist FIRST, emit the live-state delta second: a crash between loses only a notification,
    // healed by the chain gap, never state. Re-projected after EVERY batch, not only when the reduce
    // moved, so a runtime field bumped inside `processEvent` publishes on its own.
    this.publishLiveState();
  }

  /** THE GUARDED REDUCE, shared by the live flow and the version replay. A reducer that throws on an
   *  event (malformed, or one an OLDER version accepted) must never wedge the processor: on a version
   *  replay it would fail the catch-up before the new checkpoint is written, every incarnation. */
  #reduceOrKeep(event: StreamEvent, state: State): State {
    try {
      return this.processor.reduce({ event, state }) ?? state;
    } catch (error) {
      reportIssue("processor.reduce", error, { slug: this.#contract.slug, offset: event.offset });
      return state;
    }
  }

  /** Validate a consumed event's payload against the contract's declared schema, then reduce it — or,
   *  for a malformed payload, skip the fold and report (it must never corrupt reduced state, the
   *  exported view a live client parses). Returns the next state AND the event to carry onward,
   *  NORMALIZED to the schema's `z.output` (coercions/defaults applied) when it validated — so the
   *  reducer, the effect hook, and the version replay all see exactly what `ConsumedEvent<Contract>`
   *  promises. SHARED by the live flow and `#rereduceIfVersionChanged`, so the two can never diverge
   *  (a coercion applied live but not on replay would make a version bump rewrite state). A payload-less
   *  event validates as `{}` (the "empty defaults" convention the contract requires of its stateSchema);
   *  a contract with no `events` catalog (the kernel-generic processors) folds unvalidated, as before. */
  #validateNormalizeAndReduce(
    event: StreamEvent,
    state: State,
  ): { state: State; event: StreamEvent; valid: boolean } {
    const parsed = this.#contract.payloadSchemaFor?.(event.type)?.safeParse(event.payload ?? {});
    if (parsed && !parsed.success) {
      reportIssue("processor.reduce.payload", parsed.error, {
        slug: this.#contract.slug,
        offset: event.offset,
        type: event.type,
      });
      return { state, event, valid: false }; // malformed: not folded, and the caller skips its effect
    }
    // Owned-event payloads are object schemas, so `z.output` is a record.
    const normalized = parsed
      ? { ...event, payload: parsed.data as Record<string, unknown> }
      : event;
    return { state: this.#reduceOrKeep(normalized, state), event: normalized, valid: true };
  }

  /** THE per-event primitive (rules 2–3) — the batch loop and the eventless at-head pass both come
   *  here: a GUARDED reduce, then `processEvent` with a FIFO blocker chain drained to a FIXED POINT.
   *  Returns the next state and whether the effect ran — a malformed payload for a KNOWN event is
   *  SKIPPED for BOTH reduce and effect (the effect hook is typed against `ConsumedEvent`'s `z.output`,
   *  so handing it garbage would throw and wedge the batch — checkpoints never advance, catch-up
   *  refails the same row); `processed: false` lets the batch fall back to the eventless caught-up pass.
   *  Owns NO cursor / persist / waiter — the caller does. */
  async #reduceAndProcessEvent(
    event: StreamEvent | null,
    state: State,
    caughtUp: boolean,
  ): Promise<{ state: State; processed: boolean }> {
    const { slug, version, emits } = this.#contract;
    const previousState = state;
    if (event) {
      // Validate + normalize + fold via the ONE shared path (so replay can't diverge). On the valid
      // path the reducer AND the effect hook below both see the NORMALIZED event (schema `z.output`);
      // a malformed payload is neither folded nor delivered to the (typed) effect hook.
      const reduced = this.#validateNormalizeAndReduce(event, state);
      if (!reduced.valid) return { state: reduced.state, processed: false };
      state = reduced.state;
      event = reduced.event;
    }
    // FIFO blocker chain for THIS event (rule 2); background work escapes it (rule 3).
    let blockers: Promise<unknown> = Promise.resolve();
    this.processor.processEvent({
      event,
      state,
      previousState,
      // Validated against the declared `emits` and stamped with provenance.
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
    return { state, processed: true };
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

// ── events ── the stream event envelope + idempotency rules. Zod-FREE: the envelope carries no
// runtime validator (the processor contract section below has the zod half).

// THE one deep-equal lives in patch.ts; re-exported here for the SDK bundle.
export { jsonEqual };

/** What `append` accepts: the event body, before the stream assigns its committed identity. The
 *  door checks ONE rule by hand: `type` is a non-empty string. */
export type StreamEventInput = {
  /** Convention: `events.iterate.com/<domain>/<fact>`. */
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Provenance: which processor (while processing what) appended this — stamped by the engine's
   *  `append` — and WHO: the session's verified principal (src/principal.ts), set by the DO's append
   *  root from the session's project token and never taken from a client. */
  source?: {
    processor?: {
      slug: string;
      version: string;
      whileProcessing?: { offset: number; type: string };
    };
    principal?: { actor: string; email?: string };
  };
  /** Same key + same body = dedupe (the existing event is returned); different body = loud error. */
  idempotencyKey?: string;
  /** OPTIONAL PRECONDITION (apps/os): land at exactly this offset or refuse the whole batch with
   *  OFFSET_CONFLICT — "nothing has happened since I last looked". Never stored in the body. */
  offset?: number;
  /** An EPHEMERAL event rides the stream to live subscribers but is NEVER persisted: it consumes an
   *  offset, triggers zero writes, and its body is gone the moment the incarnation ends — nobody can
   *  redeliver it (stream.ts, the zero-write contract). A durable OMITS the field. */
  ephemeral?: true;
};

/** A committed event: the input plus the identity the stream assigned at its commit point. */
export type StreamEvent = Omit<StreamEventInput, "offset"> & {
  offset: number;
  createdAt: string;
  path: string;
};

// ── idempotency (apps/os semantics, message text kept greppable across RPC hops) ──

export function idempotencyConflictMessage(idempotencyKey: string, existingOffset: number): string {
  return `idempotency key "${idempotencyKey}" already names a different event at offset ${existingOffset}`;
}

/** Structural equality of the parts an idempotent retry must not change. */
export function sameIdempotentEvent(
  existingEvent: StreamEventInput,
  requestedEvent: StreamEventInput,
): boolean {
  return (
    existingEvent.type === requestedEvent.type &&
    jsonEqual(existingEvent.payload, requestedEvent.payload) &&
    jsonEqual(existingEvent.metadata, requestedEvent.metadata)
  );
}

// ── reduce checkpoint ── THE ONE spelling of a persisted reduce checkpoint, shared by BOTH hosts (the
// stream's core reduce and the facet-hosted `ProcessorEngine`). ONE ROW per slug: the reducer
// version, the offset reduced through, and the state as JSON (NULL = the reduce never changed it =
// `initialState()` — a pure side-effect processor reusing its cursor never re-fires its effect
// history). ONE statement per write, so a checkpoint can never tear; the state column is rewritten
// only when the reduce changed it (`COALESCE`).
//
// THE CELL CEILING: a checkpoint is one SQLite cell — 2 MB in production, SQLITE_TOOBIG past it. A
// state whose JSON would not fit is refused BEFORE the write with a coded error, so the caller sees
// why instead of the platform's raw message, and nothing lands. No cloudflare:workers import on
// purpose: this module rides the SDK bundle into every facet isolate.

/** Under the 2 MB cell, with room for the row's other columns. */
const REDUCE_CHECKPOINT_STATE_MAX_CHARS = 2 * 1024 * 1024 - 4096;

/** Sync SQLite as the platform hands it over (`ctx.storage.sql`): a query is a LAZY cursor —
 *  iterate it, or `toArray()`. Spelled structurally so a node:sqlite stand-in satisfies it. */
export type SqlStorageHandle = {
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): Iterable<T> & { toArray(): T[] };
};

/** A persisted checkpoint as read back: the version it was reduced under (the caller gates on it),
 *  the offset reduced through, and the state — `undefined` when the reduce never changed it. */
export type ReduceCheckpoint<State> = {
  reducerVersion: string;
  reducedThroughOffset: number;
  state: State | undefined;
};

/** What BOTH hosts read and write their checkpoints through — the stream's storage and a facet's
 *  own (the unit lane drives it over node:sqlite, stream/test-support.ts). */
export class ReduceCheckpointTable {
  readonly #sql: SqlStorageHandle;

  /** `createTable: false` when the caller knows the table exists (the stream's storage skips every
   *  CREATE on a re-wake); a facet host constructs one per incarnation and lets it create. */
  constructor(sql: SqlStorageHandle, options: { createTable: boolean } = { createTable: true }) {
    this.#sql = sql;
    if (options.createTable) ReduceCheckpointTable.createTable(sql);
  }

  static createTable(sql: SqlStorageHandle): void {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS reduce_checkpoints (
         slug TEXT PRIMARY KEY,
         reducer_version TEXT NOT NULL,
         reduced_through_offset INTEGER NOT NULL,
         state TEXT
       )`,
    );
  }

  read<State>(slug: string): ReduceCheckpoint<State> | undefined {
    const row = this.#sql
      .exec<{ reducer_version: string; reduced_through_offset: number; state: string | null }>(
        "SELECT reducer_version, reduced_through_offset, state FROM reduce_checkpoints WHERE slug = ?",
        slug,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      reducerVersion: String(row.reducer_version),
      reducedThroughOffset: Number(row.reduced_through_offset),
      state: row.state === null ? undefined : (JSON.parse(String(row.state)) as State),
    };
  }

  /** ALWAYS the cursor; the state ONLY when `stateChanged` — one write either way. */
  write<State>(
    slug: string,
    cursor: { reducerVersion: string; reducedThroughOffset: number },
    state: State,
    stateChanged: boolean,
  ): void {
    const serializedState = stateChanged ? (JSON.stringify(state) ?? null) : null;
    // Stamped `retryable: false` (the flag workerd itself uses): the same state serializes to the
    // same size on every retry — a delivery loop halts on it instead of climbing its ladder.
    if (serializedState !== null && serializedState.length > REDUCE_CHECKPOINT_STATE_MAX_CHARS)
      throw Object.assign(
        codedError(
          "REDUCE_CHECKPOINT_TOO_LARGE",
          `checkpoint "${slug}": the reduced state serializes to ${serializedState.length} chars, over the ${REDUCE_CHECKPOINT_STATE_MAX_CHARS}-char ceiling of one storage cell (2 MB) — a reduce must keep a summary, not the events; nothing was written`,
          { slug, chars: serializedState.length, maxChars: REDUCE_CHECKPOINT_STATE_MAX_CHARS },
        ),
        { retryable: false },
      );
    this.#sql.exec(
      `INSERT INTO reduce_checkpoints (slug, reducer_version, reduced_through_offset, state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           reducer_version = excluded.reducer_version,
           reduced_through_offset = excluded.reduced_through_offset,
           state = COALESCE(excluded.state, reduce_checkpoints.state)`,
      slug,
      cursor.reducerVersion,
      cursor.reducedThroughOffset,
      serializedState,
    );
  }
}

// ── live state ── THE live-state primitive: one value, its revision chain, and the diff→emit
// dance Phoenix LiveView does, over the project's stream. Used two ways: a mini-app DO owns one
// directly as its store; the ProcessorEngine owns one per processor and `set`s the projection after
// every batch (sdk/index.ts shows both).
//
// MUTATION AND NOTIFICATION ARE INSEPARABLE: `set(next)` diffs the held value → next; on a real
// change it bumps the revision and appends the ephemeral `live-state/changed` delta carrying
// `{key, from, to, patch}` onto the stream. `snapshot()` is the SEED DOOR. The stream keeps no
// per-subscriber state — the CLIENT owns its chain: seed through the door, apply a payload whose
// `from` matches its held rev, re-read the door on any mismatch (live-state-chains-client-side.e2e).
//
// The revision is seeded from a per-incarnation EPOCH (not 0): a reborn holder mints a fresh epoch,
// so every stale client rev mismatches and re-reads the door instead of applying a patch onto a
// diverged base. Lossy by contract — a dropped delta append is a chain gap the client heals, never
// state loss. HARD RULE: no processor can ever REDUCE the delta (processor.ts `reducesEvent`), so a
// state-change notification can never feed a reduce; a SUBSCRIPTION may name the type to watch it.

/** A delta whose patch is over this many chars is not sent: a whole-array replace of a large
 *  projection would cost every watcher the projection per set, and past the event ceiling the door
 *  would refuse it outright. The delta rides with `patch: null` instead — the rev moved, re-seed. */
const LIVE_STATE_PATCH_MAX_CHARS = 1024 * 1024;

/** The only thing a LiveState needs from its host: somewhere to append the delta. A
 *  `ProcessorStream` and the itx scope both satisfy it. */
export type LiveStateSink = {
  append(event: { type: string; ephemeral?: true; payload?: Record<string, unknown> }): unknown;
};

export class LiveState<S> {
  readonly #liveStateSink: LiveStateSink;
  readonly #liveStateKey: string;
  #state: S;
  /** The DIFF BASE: the last value that serialized — what a client that applied every delta holds.
   *  Kept apart from `#state` so a value the wire cannot carry, adopted without an emit, never
   *  becomes the base every later diff would throw against. */
  #lastSerializedState: S;
  #liveStateRev: number;
  /** THE DELTA APPEND CHAIN — at most one delta append in flight, so commit order = mint order for a
   *  CROSS-HOP sink: `env.ITX.get().append(e)` mints a FRESH capability per call, so two deltas
   *  issued in different turns race across the hop and the second can commit first — ~14% of rapid
   *  pairs on the deployed edge (never locally, the hop is sub-ms). Nothing is dropped by a reorder,
   *  but it costs every watcher the full door re-read the deltas exist to avoid. A lone delta (the
   *  chain idle) is issued synchronously; only when an append is already in flight does the next
   *  queue behind it. Nobody waits on this. */
  #liveStateDeltaAppendChain: Promise<unknown> = Promise.resolve();
  /** Whether to order delta appends across turns (above). TRUE by default, so a mini-app holder gets
   *  it without opting in. FALSE for the core reduce, whose sink is the stream's OWN synchronous
   *  `append` (same isolate, no reorder possible): there the delta must land densely inside the
   *  commit that triggered it, never deferred a microtask. */
  readonly #orderDeltaAppends: boolean;

  constructor(
    sink: LiveStateSink,
    key: string,
    initial: S,
    options?: { orderDeltaAppends?: boolean },
  ) {
    this.#liveStateSink = sink;
    this.#liveStateKey = key;
    this.#state = initial;
    this.#lastSerializedState = initial;
    this.#liveStateRev = Date.now() * 4096 + Math.floor(Math.random() * 4096);
    this.#orderDeltaAppends = options?.orderDeltaAppends ?? true;
  }

  /** The current value (reflects every `set`). */
  get(): S {
    return this.#state;
  }

  /** THE seed door: `{rev, state}` read together (single-threaded ⇒ atomically), which is what lets
   *  a client chain patches exactly instead of guessing which changes its snapshot already contains. */
  snapshot(): { rev: number; state: S } {
    return { rev: this.#liveStateRev, state: this.#state };
  }

  /** Replace the value: diff the last serialized base → next; on a real change bump the revision
   *  and append the delta. Build a NEW value (don't mutate `next` in place) — the diff is over JSON.
   *  A diff/append failure degrades to a LOST notification (the client re-seeds on the chain gap),
   *  never a throw the caller sees. */
  set(next: S): void {
    // The SAME object is the same JSON (the contract forbids in-place mutation, which is what makes
    // identity a proof of equality): no diff, no delta, no rev move — the common case for a
    // processor whose projection is its unchanged reduced state.
    if (next === this.#lastSerializedState) return;
    // A `next` the wire cannot carry (a BigInt, a cycle) throws in the diff: adopt it anyway, and
    // STILL advance the rev — the bump mints the chain gap that forces a stale client's re-seed
    // (without it, a later emit's `from` would match the client's held rev and it would apply a
    // patch computed against a base it never received: silent corruption). The serialized base
    // stays put, so the next serializable value emits as a diff from what the client last saw.
    let patch;
    try {
      patch = diff(this.#lastSerializedState, next);
    } catch {
      this.#state = next;
      this.#liveStateRev += 1;
      return;
    }
    this.#state = next;
    this.#lastSerializedState = next;
    if (!patch) return;
    const from = this.#liveStateRev;
    const to = from + 1; // a LOCAL: a later set's rev must not be read into this delta's payload
    this.#liveStateRev = to;
    const wirePatch = JSON.stringify(patch).length > LIVE_STATE_PATCH_MAX_CHARS ? null : patch;
    const emitDelta = () =>
      this.#liveStateSink.append({
        type: "events.iterate.com/live-state/changed",
        ephemeral: true,
        payload: { key: this.#liveStateKey, from, to, patch: wirePatch },
      });
    // A dropped delta — a sync throw or a rejection — is a chain gap the client heals (the rev
    // already advanced); it must never reach the caller.
    if (!this.#orderDeltaAppends) {
      // The same-isolate sink: synchronously and densely, every time (`#orderDeltaAppends`).
      try {
        void Promise.resolve(emitDelta()).catch(() => {});
      } catch {
        /* the gap, contained */
      }
      return;
    }
    // The ORDERING path (a cross-hop sink mints a FRESH capability per call, so two deltas can race
    // on the wire): every delta rides ONE chain, each emitted only after the previous append settles,
    // so mint order IS the delivery order. No in-flight flag + synchronous fast path — clearing the
    // flag in the first append's `finally` while a later delta was still queued let a newer delta see
    // "idle", fork a parallel chain, and overtake the queued one (commit order 1, 3, 2). The chain's
    // own `.catch` contains a dropped delta (a sync throw or a rejection): a gap the client heals.
    this.#liveStateDeltaAppendChain = this.#liveStateDeltaAppendChain.then(emitDelta).catch(() => {});
  }

  /** Every delta minted so far has reached the sink (or failed into the chain gap) — the test seam
   *  for LiveState's now-asynchronous append (the delta append chain). Production never awaits it. */
  deltasSettled(): Promise<unknown> {
    return this.#liveStateDeltaAppendChain;
  }
}

// ── processor contract ── the zod CONTRACT helper (apps/os `defineProcessorContract`, focused). zod
// is ~310 KB of runtime the edge/DO script never needs (the core contract is hand-built,
// stream/core-processor.ts): only this helper reaches it, so esbuild tree-shakes zod off the worker
// script (zod ships `sideEffects: false`) — it rides the SDK bundle alone. A contract declares its
// identity, reduced-state schema, the events it OWNS (`events`, keyed by the durable type string,
// each with a zod payload schema — so the type strings and payload shapes are visible right here),
// the events it `consumes`/`emits`, and optional `processorDeps` (other contracts whose events it may
// consume without owning). The reduce's event union and the state type are DERIVED from the contract
// (`ConsumedEvent` / `ProcessorState`) — no hand-kept discriminated union to drift.

/** One owned event: its description and the zod schema for its payload. `ephemeral: true` marks a
 *  non-durable event (delivered only when its type is named in `consumes`). */
export type EventDefinition = { description: string; payloadSchema: z.ZodType; ephemeral?: true };
/** A durable event type string → its definition. */
export type EventCatalog = Record<string, EventDefinition>;

/** A `processorDeps` entry's own event catalog. */
type DepCatalog<Dep> = Dep extends { events: infer Events extends EventCatalog } ? Events : never;
/** The definition owning `Type` — local events win, then each dep. */
type DefinitionForType<
  Events extends EventCatalog,
  Deps extends readonly unknown[],
  Type extends string,
> = Type extends keyof Events
  ? Events[Type]
  : Deps[number] extends infer Dep
    ? Dep extends unknown
      ? Type extends keyof DepCatalog<Dep>
        ? DepCatalog<Dep>[Type]
        : never
      : never
    : never;

/** The committed event for one resolved type: `StreamEvent` narrowed to its `{ type, payload }`. */
type EventForType<
  Events extends EventCatalog,
  Deps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? DefinitionForType<Events, Deps, Type> extends { payloadSchema: infer Schema extends z.ZodType }
    ? StreamEvent & { type: Type; payload: z.output<Schema> }
    : never
  : never;

/** The reduce union for a `consumes` tuple — `"*"` alone means any `StreamEvent`. */
type EventForTypes<
  Events extends EventCatalog,
  Deps extends readonly unknown[],
  Types extends readonly string[],
> = "*" extends Types[number] ? StreamEvent : EventForType<Events, Deps, Types[number]>;

/** A contract's `processorDeps` tuple, defaulting to empty. */
type DepsOf<Contract> = Contract extends { processorDeps: infer Deps extends readonly unknown[] }
  ? Deps
  : readonly [];

/** A contract's reduced-state type, inferred from its `stateSchema`. */
export type ProcessorState<Contract> = Contract extends {
  stateSchema: infer Schema extends z.ZodType;
}
  ? z.output<Schema>
  : never;

/** The committed-event union a contract's `consumes` list can deliver to `reduce`/`processEvent`. */
export type ConsumedEvent<Contract> = Contract extends {
  events: infer Events extends EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? EventForTypes<Events, DepsOf<Contract>, Consumes>
  : never;

/** What `defineProcessorContract` returns: the base the engine reads, plus the events catalog and the
 *  resolved deps. (Events are written LITERALLY at the call site — `itx.append({ type, payload })` —
 *  so there is no event-builder here; the engine validates the payload against `payloadSchemaFor` at
 *  reduce, and `ConsumedEvent`/`ProcessorState` give the reduce its types.) */
export type DefinedProcessorContract<
  StateSchema extends z.ZodType,
  Events extends EventCatalog,
  Consumes extends readonly string[],
  Deps extends readonly unknown[],
> = ProcessorContract<z.output<StateSchema>> & {
  stateSchema: StateSchema;
  events: Events;
  // The literal consumes tuple is preserved (not widened to string[]) so `ConsumedEvent` can map each
  // consumed type to its event; the base ProcessorContract only needs `readonly string[]`.
  consumes: Consumes;
  processorDeps: Deps;
};

export function defineProcessorContract<
  const StateSchema extends z.ZodType,
  const Events extends EventCatalog = Record<string, never>,
  const Consumes extends readonly string[] = readonly string[],
  const Deps extends readonly { events: EventCatalog }[] = readonly [],
>(contract: {
  slug: string;
  version: string;
  description: string;
  /** Must parse `{}` — the initial state is `stateSchema.parse({})` (all fields defaulted). */
  stateSchema: StateSchema;
  /** The events this contract OWNS, keyed by durable type string. Omit for a kernel-generic
   *  processor that types its own reduce through the `Event` param instead of an events catalog. */
  events?: Events;
  /** Other processors' contracts whose events this one may `consumes`/`emits` without owning. */
  processorDeps?: Deps;
  consumes: Consumes;
  emits: readonly string[];
}): DefinedProcessorContract<StateSchema, Events, Consumes, Deps> {
  if (!contract.stateSchema.safeParse({}).success)
    throw new Error(`contract "${contract.slug}": stateSchema must parse {} (default every field)`);
  const events = (contract.events ?? {}) as Events;
  const processorDeps = (contract.processorDeps ?? []) as Deps;
  // One owner per event type: a local event may not shadow a dep's event, and two deps may not both
  // declare one. Otherwise `resolve` (and the runtime payload validation it backs) would pick just the
  // first while `ConsumedEvent`'s type union includes BOTH payload types — a second dep's events would
  // then validate against the wrong schema.
  const depEventTypes = new Set<string>();
  for (const dep of processorDeps as readonly { events: EventCatalog }[])
    for (const type of Object.keys(dep.events)) {
      if (type in events)
        throw new Error(`contract "${contract.slug}": event "${type}" is already owned by a dep`);
      if (depEventTypes.has(type))
        throw new Error(`contract "${contract.slug}": event "${type}" is declared by two deps`);
      depEventTypes.add(type);
    }
  const resolve = (type: string): EventDefinition | undefined =>
    events[type] ??
    (processorDeps as readonly { events: EventCatalog }[]).map((dep) => dep.events[type]).find(Boolean);
  return {
    slug: contract.slug,
    version: contract.version,
    description: contract.description,
    consumes: contract.consumes,
    emits: contract.emits,
    stateSchema: contract.stateSchema,
    events,
    processorDeps,
    initialState: () => contract.stateSchema.parse({}) as z.output<StateSchema>,
    payloadSchemaFor: (type: string) => resolve(type)?.payloadSchema,
  };
}
