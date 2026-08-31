// core/processor.ts — the stream processor base class. The AUTHOR surface mirrors apps/os
// (`reduce`/`processEvent`, `blockProcessorWhile`/`runInBackground`, `delivery.caughtUp`) so
// processors port both ways; the RUNNER lives in the same class — a processor and the thing
// that runs it are one object (the registry-of-N this replaced was bookkeeping for a
// multi-tenancy that never occurred: every facet hosts exactly one processor).
//
// THIS FILE IS THE HEART OF THE USERSPACE SDK: its only runtime imports are the dependency-free
// diff in core/patch.ts and the platform-neutral error channel in core/errors.ts, and it
// is bundled — together with the zod contract helper from core/events.ts and zod itself, via
// src/sdk.ts — into every loaded processor isolate as `processor.js` (build-sdk.mjs). Userspace
// authors write exactly what built-ins write: `defineProcessorContract` with real schemas
// (owner's call: the SDK absolutely ships zod), then `class X extends StreamProcessor`.
//
// THE CONCURRENCY CONTRACT (verbatim from apps/os's runner):
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
// are all the same non-event — the cursor advances on the RANGE, never by counting events. A non-contiguous push triggers GAP REPAIR: read durable
// rows from the own cursor until the head. Ephemeral events ride pushes ONLY (reads are
// durable-only; an ephemeral missed while a facet rebuilds is gone by design — nothing can
// redeliver it) and NEVER trigger a progress persist: an ephemeral-only range advances the
// cursor in memory alone, so a pure-ephemeral flood costs this class ZERO storage writes.
//
// `reduce` is a PURE reduce (new object out, inputs immutable), cached per contract version;
// bumping `contract.version` re-reduces from offset 0 through `reduce` only (never re-running
// side effects) — and a re-reduce reads durable rows only, which is why durable product truth must
// never be derived from an ephemeral event.

import type { z } from "zod";
import { LiveState } from "./live-state.ts";
import { reportIssue } from "./errors.ts";
import {
  type ReduceCheckpoint,
  readReduceCheckpoint,
  reduceCursorKey,
  writeReduceCheckpoint,
} from "./reduce-checkpoint.ts";
import type {
  StreamEvent as StreamEventT,
  StreamEventInput as StreamEventInputT,
} from "./events.ts";

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
 *  `scannedThroughOffset` is how far the read is CONTIGUOUSLY known (the last row when a full
 *  page came back, the stream's highest assigned offset when the page ran short). */
export type ProcessorStream = {
  append(...events: StreamEventInputT[]): Promise<StreamEventT[]> | StreamEventT[];
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEventT[]; scannedThroughOffset: number }>;
};

/** The processor's own durable storage (the hosting facet's kv). */
export type ProcessorStorage = {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  /** Optional: GC a key outright. The userspace runner's storage adapter omits it; the built-in
   *  facet host wires it (only the forwarder processor needs it). */
  delete?(key: string): void;
};

/** The contiguity proof a delivery carries: the half-open offset window `(after, through]`. A chain
 *  of these (each `after` === the previous `through`) is how a subscriber proves it missed nothing. */
export type ScannedRange = { after: number; through: number };

export type ReduceArgs<State> = { event: StreamEventT; state: State };

export type ProcessEventArgs<State> = {
  /** The consumed event — or `null` for the eventless at-head pass. */
  event: StreamEventT | null;
  state: State;
  previousState: State;
  /** Emit (validated against `emits`, provenance-stamped) onto this processor's own stream. */
  append: (...events: StreamEventInputT[]) => Promise<StreamEventT[]>;
  /** Hold the cursor until `work` settles; FIFO with other blockers of the SAME event. */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** Fire-and-forget attempt; may overtake later events; outcome must be state-recoverable. */
  runInBackground: (work: () => Promise<unknown>) => void;
  delivery: { caughtUp: boolean };
};

export type ProcessorSnapshot<State> = { offset: number; state: State };

/** A REDUCE-ONLY processor: pure reduce, no effects — hostable at ZERO DISTANCE (inline at the
 *  parent's commit point) because it needs none of the async runner below. The entire runner
 *  apparatus — serial chain, cursors, scanned offset ranges, gap repair, resurrection — is the price of
 *  being AWAY from the commit point; a reduce that runs synchronously inside append pays none of
 *  it. Same `defineProcessorContract`, same `reduce({event, state})` signature; NOT having a
 *  `processEvent` is what qualifies a processor for inline hosting (the rule is the type).
 *  Inline reduces see DURABLE events only — their checkpoint must be rebuildable from the log. */
export type ReduceOnlyProcessor<State> = {
  contract: ProcessorContract<State>;
  reduce(args: ReduceArgs<State>): State | null | undefined;
};

/** Returned by #liveStateOf when `liveState(state)` threw — distinct from a legitimate `undefined`
 *  projection, so a throw skips the emit while `undefined` is a real (patchable) value. */
const PROJECTION_FAILED = Symbol("live-state-projection-failed");

/** THE ONE consumes rule — the reduce, both delivery lanes (connected + forwarder), and the
 *  inline core all call this; there is no second copy to drift. `consumes` undefined = every
 *  durable event (a subscriber's default). "*" = every durable event. A NAMED type opts that
 *  type in, INCLUDING ephemerals ("*" NEVER sweeps ephemerals). The live-state/changed type is
 *  never consumable (the loop guard). */
export function consumesEvent(
  consumes: readonly string[] | undefined,
  event: { type: string; ephemeral?: boolean },
): boolean {
  if (event.type === "events.iterate.com/live-state/changed") return false;
  if (event.ephemeral) return consumes?.includes(event.type) ?? false;
  return consumes === undefined || consumes.includes("*") || consumes.includes(event.type);
}

export abstract class StreamProcessor<State> {
  abstract readonly contract: ProcessorContract<State>;
  protected readonly stream: ProcessorStream;
  protected readonly path: string;
  protected readonly projectId: string;
  protected readonly props: Record<string, unknown>;
  readonly #storage: ProcessorStorage;

  // Rule 1: the serial chain.
  #chain: Promise<void> = Promise.resolve();
  #progress: ReduceCheckpoint<State> | null = null; // in-memory cache of the persisted reduce progress
  #pushedThroughOffset?: number; // highest scannedThroughOffset ever SHOWN to us (see processEventBatch)
  #waiters: { offset: number; resolve: () => void }[] = [];

  constructor(args: {
    stream: ProcessorStream;
    storage: ProcessorStorage;
    path: string;
    projectId: string;
    /** Per-instance configuration from the enablement mount (event-sourced; re-enabling with
     *  different props shadows the old configuration). */
    props?: Record<string, unknown>;
  }) {
    this.stream = args.stream;
    this.#storage = args.storage;
    this.path = args.path;
    this.projectId = args.projectId;
    this.props = args.props ?? {};
  }

  /** Pure reduce. Return the NEXT state (a new object) — or null/undefined to keep the current. */
  protected reduce(_args: ReduceArgs<State>): State | null | undefined {
    return undefined;
  }

  /** Side-effect hook. Synchronous by design: register async work via the two helpers. */
  protected processEvent(_args: ProcessEventArgs<State>): undefined {}

  /** The live-state PROJECTION — the shape clients see and the shape the diffs are computed over.
   *  DEFAULT: the reduced state verbatim, so EVERY processor's reduced state is live out of the box —
   *  a delta emits on every change whether or not anyone is watching. That is deliberate: the delta
   *  is an EPHEMERAL, unconsumable event (memory-only, no storage write, dropped at delivery if no
   *  subscriber names its key), so "always live" costs an offset and a cheap diff, nothing durable.
   *  Override to redact/trim, or to FOLD IN RUNTIME FIELDS the reduce doesn't own
   *  (`return { ...state, lastSeenMs: this.#lastSeenMs }`); after a runtime field changes out of
   *  band, call `publishLiveState()` to emit its delta. */
  protected liveState(state: State): unknown {
    return state;
  }

  // One LiveState holder per processor (core/live-state.ts) — it owns the revision chain and the
  // diff→emit dance. Lazily materialized so its epoch is minted once per incarnation; seeded with
  // the PREVIOUS projection at the top of each batch (so the first change after (re)materialization
  // still diffs from the right base). A version refold clears it (#rereduceIfVersionChanged), so a
  // reborn chain mints a fresh epoch and clients re-seed — which a refold wants.
  #live?: LiveState<unknown>;
  #liveHolder(seedState?: State): LiveState<unknown> {
    if (this.#live) return this.#live;
    const seed = this.#liveStateOf(seedState ?? this.#loadProgress().state);
    return (this.#live = new LiveState(
      this.stream,
      this.contract.slug,
      seed === PROJECTION_FAILED ? undefined : seed,
    ));
  }

  /** `this.liveState(state)`, CONTAINED: a throwing/unserializable projection loses only its
   *  notification (the client re-seeds on the chain gap), never a batch or the holder. The sentinel
   *  distinguishes "threw" (skip the emit) from a legitimate `undefined` projection. */
  #liveStateOf(state: State): unknown {
    try {
      return this.liveState(state);
    } catch (error) {
      reportIssue("processor.live-state", error, { slug: this.contract.slug });
      return PROJECTION_FAILED;
    }
  }

  /** THE SEED DOOR for live-state clients: `{rev, state}` read together (single-threaded ⇒
   *  atomically), which is what lets a client chain patches exactly instead of guessing which
   *  changes its snapshot already contains. */
  async liveSnapshot(): Promise<{ rev: number; state: unknown }> {
    if (!this.#caughtUp()) await this.wake();
    return this.#liveHolder().snapshot();
  }

  /** Emit a delta for the CURRENT projection (reduced + any runtime fields) if it changed. The base
   *  calls this after every batch; call it yourself after mutating a runtime field out of band. */
  protected publishLiveState(): void {
    const projection = this.#liveStateOf(this.#loadProgress().state);
    if (projection !== PROJECTION_FAILED) this.#liveHolder().set(projection);
  }

  /** Stable idempotency key namespaced by slug; add `whileProcessing` for per-event keys. */
  protected idempotencyKey(key: string, whileProcessing?: StreamEventT): string {
    return whileProcessing
      ? `${this.contract.slug}/${key}@${this.path}:${whileProcessing.offset}`
      : `${this.contract.slug}/${key}`;
  }

  // ── the drive doors ──

  /** THE push door: the stream (or hosting facet) hands the just-committed batch with its
   *  range. Contiguous → reduce it directly (the fast path — no read); anything else → gap
   *  repair from the own cursor. Fire-and-forget safe: enqueues on the serial chain. */
  processEventBatch(events: StreamEventT[], range: ScannedRange): Promise<void> {
    // Recorded SYNCHRONOUSLY: the head this processor has been SHOWN. Read verbs skip their
    // wake when the reduce has provably reached it — the fast path that deletes one parent read
    // RPC from every capability dispatch (and every level of alias nesting) once caught up.
    this.#pushedThroughOffset = Math.max(this.#pushedThroughOffset ?? 0, range.through);
    return this.#enqueue(async () => {
      await this.#rereduceIfVersionChanged();
      const cursor = this.#loadProgress().reducedThroughOffset;
      // DURABLE GAP REPAIR is the ONLY reason not to process the push immediately: a durable prefix
      // the push assumes but we haven't folded must be healed from the log FIRST. The push carries
      // fresh named ephemerals the log can't return (reads are durable-only), so a blanket catch-up
      // would repair the durables but drop the ephemerals — hence repair up to the push
      // start, then process the push itself.
      if (range.after > cursor) {
        await this.#repairThrough(range.after);
        // Log can't reach the push start (a durable row genuinely missing) → full durable catch-up,
        // then STILL process the push below so its ephemerals aren't dropped (the durables are
        // simply filtered as already-folded).
        if (this.#loadProgress().reducedThroughOffset !== range.after) await this.#catchUpBody();
      }
      // ALWAYS process the push — no push is ever discarded. Durables fold iff fresh (`offset >
      // cursor`); ephemerals ALWAYS deliver (one push, unredeliverable); the cursor never regresses.
      // A wholly-behind (stale) push folds nothing and just delivers its ephemerals. This
      // one path replaced the old contiguous / non-contiguous / stale-drop three-way branch.
      const atHead = range.through >= (this.#pushedThroughOffset ?? 0);
      await this.#processBatch(events, range, atHead);
    });
  }

  /** Catch up from the own persisted cursor (cold boot, reads). A wake carries nothing. */
  wake(): Promise<void> {
    return this.#enqueue(() => this.#catchUpBody());
  }

  // ── the read surface ──

  /** Fold-and-effects caught up through the log, then the current snapshot. */
  async snapshot(): Promise<ProcessorSnapshot<State>> {
    if (!this.#caughtUp()) await this.wake();
    const progress = this.#loadProgress();
    return { offset: progress.reducedThroughOffset, state: progress.state };
  }

  /** Provably at the shown head → the read verbs skip their catch-up read entirely. */
  #caughtUp(): boolean {
    return (
      this.#pushedThroughOffset !== undefined &&
      this.#loadProgress().reducedThroughOffset >= this.#pushedThroughOffset
    );
  }

  /** THE barrier verb (read-your-writes): resolves once processed AT LEAST through `offset`. */
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    const { offset, timeoutMs = 10_000 } = input;
    return new Promise<void>((resolve, reject) => {
      if (this.#loadProgress().reducedThroughOffset >= offset) return resolve();
      const waiter = {
        offset,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        // A timed-out waiter LEAVES the list — otherwise every later batch re-scans it forever.
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `processor "${this.contract.slug}" did not reach offset ${offset} in ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.#waiters.push(waiter);
      void this.wake()
        .then(() => {
          // The offset may have been reached by the wake's own catch-up OR by a version refold
          // (which sets progress without a #processBatch that resolves waiters). Re-check here.
          const i = this.#waiters.indexOf(waiter);
          if (i !== -1 && this.#loadProgress().reducedThroughOffset >= offset) {
            this.#waiters.splice(i, 1);
            waiter.resolve();
          }
        })
        // A rejecting self-pull (read threw) rejects THIS waiter promptly with the real error,
        // not a park-until-timeout with a generic message.
        .catch((error) => {
          const i = this.#waiters.indexOf(waiter);
          if (i === -1) return; // already resolved/timed-out
          this.#waiters.splice(i, 1);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  // ── the runner (private) ──

  /** Serialize on the chain. THE RULE: never await your own chain from inside a batch — a
   *  processor that appends during its batch would deadlock, which is why every append→drive
   *  caller is fire-and-forget. */
  #enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(work);
    this.#chain = run.catch(() => {}); // a failed batch never wedges the chain; retry via wake
    return run;
  }

  /** The persisted reduce checkpoint (see reduce-checkpoint.ts) — cached per incarnation. A
   *  version MATCH is cached; a MISMATCH (or no cursor) returns the fresh fallback WITHOUT caching
   *  it, because `#rereduceIfVersionChanged` bails when `#progress` is already set — caching here
   *  would skip the refold and replay the whole log WITH side effects. */
  #loadProgress(): ReduceCheckpoint<State> {
    if (this.#progress) return this.#progress;
    const cp = readReduceCheckpoint(this.#storage, this.contract.slug, this.contract.version, () =>
      this.contract.initialState(),
    );
    if (cp) return (this.#progress = cp);
    return {
      reducerVersion: this.contract.version,
      reducedThroughOffset: 0,
      state: this.contract.initialState(),
    };
  }

  /** Re-reduce from offset 0 (the contract version changed). Durable rows only — never re-runs
   *  effects, and (by design) never sees dead ephemerals. */
  async #rereduceIfVersionChanged(): Promise<void> {
    if (this.#progress) return; // version can't change within an incarnation — probe storage once
    const stored = this.#storage.get<{ reducerVersion: string; reducedThroughOffset: number }>(
      reduceCursorKey(this.contract.slug),
    );
    if (!stored || stored.reducerVersion === this.contract.version) return;
    // Rebuild ONLY through the offset the OLD cursor covered (reduce-only, no effects). Events
    // past it are the job of the normal flow that follows — refolding to the live head instead
    // would judge an already-queued in-flight push stale and swallow its effects.
    const target = stored.reducedThroughOffset;
    let state = this.contract.initialState();
    let after = 0;
    while (after < target) {
      const page = await this.stream.read(after, 500);
      for (const event of page.events) {
        if (event.offset > target) break;
        if (consumesEvent(this.contract.consumes, event))
          state = this.reduce({ event, state }) ?? state;
      }
      const scannedTo = Math.min(page.scannedThroughOffset, target);
      if (scannedTo <= after) break;
      after = scannedTo;
      if (page.events.length < 500) break;
    }
    this.#progress = { reducerVersion: this.contract.version, reducedThroughOffset: target, state };
    writeReduceCheckpoint(this.#storage, this.contract.slug, this.#progress, state, true);
    // A refold jumped the state under the holder; drop it so the next batch re-seeds a fresh chain
    // (new epoch ⇒ clients re-read the door — a version bump wants exactly that).
    this.#live = undefined;
  }

  /** CURSOR-DRIVEN gap repair: read contiguously from the persisted cursor out of the log —
   *  a failed batch, a missed push, or a fresh incarnation can never skip a durable event. */
  async #catchUpBody(): Promise<void> {
    await this.#rereduceIfVersionChanged();
    let sawFullPage = false;
    for (;;) {
      const after = this.#loadProgress().reducedThroughOffset;
      const page = await this.stream.read(after, 500);
      if (page.scannedThroughOffset <= after) {
        // No new contiguous events beyond the cursor → we are AT HEAD. An EXACT full page (500)
        // was judged not-at-head and never got rule 5's caught-up pass; a log whose length is an
        // exact page multiple must still learn it is caught up — deliver the eventless at-head pass.
        if (sawFullPage) await this.#processBatch([], { after, through: after }, true);
        return;
      }
      const atHead = page.events.length < 500;
      await this.#processBatch(page.events, { after, through: page.scannedThroughOffset }, atHead);
      if (atHead) return;
      sawFullPage = true;
    }
  }

  /** BOUNDED durable repair: reduce durable rows from the cursor UP TO `target` (inclusive), no
   *  further — the prefix a non-contiguous push needs healed before its OWN batch (carrying fresh
   *  ephemerals the log can't return) is processed. Never delivers caughtUp: the push, not this
   *  repair, decides at-head. Stops early if the log can't reach `target` (the caller falls back). */
  async #repairThrough(target: number): Promise<void> {
    for (;;) {
      const after = this.#loadProgress().reducedThroughOffset;
      if (after >= target) return;
      const page = await this.stream.read(after, 500);
      if (page.scannedThroughOffset <= after) return; // nothing more durable to repair
      const through = Math.min(page.scannedThroughOffset, target);
      await this.#processBatch(
        page.events.filter((e) => e.offset <= target),
        { after, through },
        false,
      );
      if (through >= target) return;
    }
  }

  /** Rules 2–5 over one range (the caller has healed any durable prefix gap first).
   *  DURABLES fold at-most-once — `offset > cursor`. EPHEMERALS ALWAYS deliver — each rides exactly
   *  one push and can never be a redelivery, so a durable-only wake that clamped the cursor PAST an
   *  ephemeral offset must not suppress it. The cursor is a DURABLE-fold watermark and never
   *  regresses. (This one method replaced the old contiguous / non-contiguous / stale-drop three-way
   *  in `processEventBatch`; there is no separate ephemeral path.) */
  async #processBatch(events: StreamEventT[], range: ScannedRange, atHead: boolean): Promise<void> {
    const progress = this.#loadProgress();
    const prevState = progress.state;
    let state = prevState;
    // Seed the holder at the PREVIOUS projection BEFORE #progress advances — so the delta emitted at
    // the end diffs prev→next, not next→next (the first-change-lost trap if the holder is born after).
    this.#liveHolder(prevState);

    const consumable = events.filter(
      (e) =>
        consumesEvent(this.contract.consumes, e) &&
        (e.ephemeral || e.offset > progress.reducedThroughOffset),
    );
    let caughtUpDelivered = false;
    for (let i = 0; i < consumable.length; i++) {
      const last = i === consumable.length - 1;
      state = await this.#applyEvent(consumable[i], state, atHead && last);
      if (atHead && last) caughtUpDelivered = true;
    }
    // Rule 5: reached the head with no caught-up event → one eventless at-head pass.
    if (atHead && !caughtUpDelivered) state = await this.#applyEvent(null, state, true);

    // Rule 4: ONE persist per range, iff a DURABLE actually ADVANCED the cursor. The
    // cursor never REGRESSES (`max`), so a wholly-behind (stale) push leaves it put — and must NOT
    // re-persist (a stale durable re-push already folded is a no-op write; a pure-ephemeral range
    // writes zero — the flood stays free). `advanced` excludes the stale re-push; `sawDurable`
    // excludes the ephemeral-only range. (This is why B's stale push delivers its ephemerals in
    // memory yet persists nothing.)
    const reducedThroughOffset = Math.max(progress.reducedThroughOffset, range.through);
    const advanced = reducedThroughOffset > progress.reducedThroughOffset;
    const sawDurable = events.some((e) => !e.ephemeral);
    const next: ReduceCheckpoint<State> = {
      reducerVersion: this.contract.version,
      reducedThroughOffset,
      state,
    };
    if (sawDurable && advanced)
      writeReduceCheckpoint(this.#storage, this.contract.slug, next, state, state !== prevState);
    this.#progress = next;
    this.#resolveWaiters(reducedThroughOffset);
    // Persist FIRST, emit the live-state delta second (a crash between loses only a notification,
    // healed by the chain gap; never state). #progress is already `next`, so publishLiveState reads
    // the just-committed state; the holder diffs against the previous projection and no-ops if
    // unchanged. Runtime-only fields ride a separate publishLiveState() call from out of band.
    if (state !== prevState) this.publishLiveState();
  }

  /** THE per-event primitive (rules 2–3), shared by every path (batch, gap-repair, at-head pass):
   *  a GUARDED reduce, then `processEvent` with a FIFO blocker chain drained to a FIXED POINT. Returns
   *  the next state; owns NO cursor / persist / waiter — the caller does. Extracting it is why the
   *  ephemeral fix is a one-clause filter change and not a duplicated batch body. */
  async #applyEvent(event: StreamEventT | null, state: State, caughtUp: boolean): Promise<State> {
    const previousState = state;
    if (event) {
      let next: State | null | undefined;
      try {
        next = this.reduce({ event, state });
      } catch (error) {
        // A malformed/hostile event must not wedge the reduce forever: record the skip, move on.
        reportIssue("processor.reduce", error, { slug: this.contract.slug, offset: event.offset });
        next = undefined;
      }
      state = next ?? state;
    }
    // FIFO blocker chain for THIS event (rule 2); background work escapes it (rule 3).
    let blockers: Promise<unknown> = Promise.resolve();
    this.processEvent({
      event,
      state,
      previousState,
      append: this.#makeAppend(event),
      blockProcessorWhile: (work) => {
        blockers = blockers.then(() => work());
      },
      runInBackground: (work) => {
        void work().catch((error) =>
          reportIssue("processor.background", error, { slug: this.contract.slug }),
        );
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

  /** Provenance stamper: every emit carries this processor's slug/version (+ what it was processing),
   *  validated against the declared `emits`. */
  #makeAppend(whileProcessing: StreamEventT | null) {
    return async (...inputs: StreamEventInputT[]): Promise<StreamEventT[]> => {
      for (const input of inputs) {
        if (!this.contract.emits.includes(input.type))
          throw new Error(
            `processor "${this.contract.slug}" emits ${JSON.stringify(input.type)} without declaring it`,
          );
        input.source = {
          processor: {
            slug: this.contract.slug,
            version: this.contract.version,
            ...(whileProcessing
              ? { whileProcessing: { offset: whileProcessing.offset, type: whileProcessing.type } }
              : {}),
          },
        };
      }
      return await this.stream.append(...inputs);
    };
  }

  /** Resolve the waiters a cursor advance satisfies (waitUntilProcessed); keep the rest. */
  #resolveWaiters(reducedThroughOffset: number): void {
    for (const w of this.#waiters.splice(0)) {
      if (reducedThroughOffset >= w.offset) w.resolve();
      else this.#waiters.push(w);
    }
  }
}
