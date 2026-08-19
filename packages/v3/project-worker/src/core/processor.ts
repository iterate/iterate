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
// DELIVERY IS PUSH-FIRST with a SCANNED-OFFSET-RANGE PROOF. The stream pushes
// `processEventBatch(events, scannedOffsetRange)` after every commit — the proof of the
// contiguous range scanned (`scannedAfterOffset` exclusive → `scannedThroughOffset` inclusive), so ephemeral
// holes, consumes-filters, and reboot gaps are all the same non-event — the cursor advances on
// the RANGE, never by counting events. A non-contiguous push triggers GAP REPAIR: read durable
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
import { diff } from "./patch.ts";
import { reportIssue } from "./errors.ts";
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
  /** Optional (older hosts may lack it): GC a key outright. */
  delete?(key: string): void;
};

/** The contiguity proof a delivery carries: (scannedAfterOffset, scannedThroughOffset]. */
export type ScannedOffsetRange = { scannedAfterOffset: number; scannedThroughOffset: number };

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

/** THE one live-state change type — ephemeral, payload `{key, from, to, patch}`: the delta
 *  patch itself rides the event (LiveView-style), chained by producer-owned revisions (`from` =
 *  the previous emission's `to`). HARD RULE: no processor can ever consume it (#consumes
 *  refuses it before contracts are even consulted), so state-change notifications can never
 *  feed a reduce — the feedback-loop class is unspellable, not merely discouraged. The CLIENT
 *  owns the chain: seed through the producer's door ({rev, state}), apply a payload whose
 *  `from` matches the held rev, re-read the door on any mismatch — never replay these events. */
export const LIVE_STATE_CHANGED = "events.iterate.com/live-state/changed";

/** THE ONE consumes rule — the reduce, both delivery lanes (connected + forwarder), and the
 *  inline core all call this; there is no second copy to drift. `consumes` undefined = every
 *  durable event (a subscriber's default). "*" = every durable event. A NAMED type opts that
 *  type in, INCLUDING ephemerals ("*" NEVER sweeps ephemerals). LIVE_STATE_CHANGED is never
 *  consumable (the loop guard). */
export function consumesEvent(
  consumes: readonly string[] | undefined,
  event: { type: string; ephemeral?: boolean },
): boolean {
  if (event.type === LIVE_STATE_CHANGED) return false;
  if (event.ephemeral) return consumes?.includes(event.type) ?? false;
  return consumes === undefined || consumes.includes("*") || consumes.includes(event.type);
}

type ReduceProgress<State> = {
  reducerVersion: string;
  reducedThroughOffset: number;
  state: State;
};

export abstract class StreamProcessor<State> {
  abstract readonly contract: ProcessorContract<State>;
  protected readonly stream: ProcessorStream;
  protected readonly path: string;
  protected readonly projectId: string;
  protected readonly props: Record<string, unknown>;
  readonly #storage: ProcessorStorage;

  // Rule 1: the serial chain.
  #chain: Promise<void> = Promise.resolve();
  #progress: ReduceProgress<State> | null = null; // in-memory cache of the persisted reduce progress
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

  /** OPTIONAL live-state projection: define it and every batch whose reduce CHANGED the projected
   *  shape emits ONE change event carrying the delta patch (key = the contract slug). Redact/
   *  trim here — this is the shape clients see, and the shape the diffs are computed over. */
  liveState?(state: State): unknown;

  // The live-state revision chain, in-memory ON PURPOSE: minted at the first liveSnapshot of an
  // incarnation (from the reduce cursor — monotonic across incarnations), advanced to `to` on
  // every emission. Losing it with an eviction just breaks the chain, and a broken chain is the
  // subscriber-side signal to re-seed — never a correctness hazard.
  #liveStateRev?: number;

  /** THE SEED DOOR for live-state clients: `{rev, state}` — the revision and the projection
   *  read together (single-threaded, so atomically), which is what lets a client chain patches
   *  exactly instead of guessing which changes its snapshot already contains. */
  async liveSnapshot(): Promise<{ rev: number; state: unknown }> {
    if (typeof this.liveState !== "function")
      throw new Error(`processor "${this.contract.slug}" defines no liveState projection`);
    if (!this.#caughtUp()) await this.wake();
    const progress = this.#loadProgress();
    this.#liveStateRev ??= progress.reducedThroughOffset;
    return { rev: this.#liveStateRev, state: this.liveState(progress.state) };
  }

  /** Stable idempotency key namespaced by slug; add `whileProcessing` for per-event keys. */
  protected idempotencyKey(key: string, whileProcessing?: StreamEventT): string {
    return whileProcessing
      ? `${this.contract.slug}/${key}@${this.path}:${whileProcessing.offset}`
      : `${this.contract.slug}/${key}`;
  }

  // ── the drive doors ──

  /** THE push door: the stream (or hosting facet) hands the just-committed batch with its
   *  scannedOffsetRange. Contiguous → reduce it directly (the fast path — no read); anything else → gap
   *  repair from the own cursor. Fire-and-forget safe: enqueues on the serial chain. */
  processEventBatch(events: StreamEventT[], scannedOffsetRange: ScannedOffsetRange): Promise<void> {
    // Recorded SYNCHRONOUSLY: the head this processor has been SHOWN. Read verbs skip their
    // wake when the reduce has provably reached it — the fast path that deletes one parent read
    // RPC from every capability dispatch (and every level of alias nesting) once caught up.
    this.#pushedThroughOffset = Math.max(
      this.#pushedThroughOffset ?? 0,
      scannedOffsetRange.scannedThroughOffset,
    );
    return this.#enqueue(async () => {
      await this.#rereduceIfVersionChanged();
      const progress = this.#loadProgress();
      if (scannedOffsetRange.scannedAfterOffset === progress.reducedThroughOffset) {
        await this.#processBatch(events, scannedOffsetRange, true);
      } else if (scannedOffsetRange.scannedThroughOffset > progress.reducedThroughOffset) {
        await this.#catchUpBody(); // gap (fresh incarnation, dropped push) — repair from the log
      } // else: a stale redelivery — the scannedOffsetRange is already behind us; nothing to do
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
      void this.wake();
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

  #progressKey(): string {
    return `processor:${this.contract.slug}:progress`;
  }
  #stateKey(): string {
    return `processor:${this.contract.slug}:state`;
  }

  /** The persisted reduce is TWO keys: the tiny cursor record (written per durable scannedOffsetRange) and
   *  the state blob (written only when the reduce actually changed it) — otherwise every enabled
   *  facet rewrote its ENTIRE state for every durable batch, consumed or not. Both writes land
   *  in one event-loop turn, so the storage write coalescer commits them together. */
  #loadProgress(): ReduceProgress<State> {
    if (this.#progress) return this.#progress;
    const cursor = this.#storage.get<{ reducerVersion: string; reducedThroughOffset: number }>(
      this.#progressKey(),
    );
    const state = this.#storage.get<State>(this.#stateKey());
    this.#progress =
      cursor &&
      cursor.reducerVersion === this.contract.version &&
      (state !== undefined || cursor.reducedThroughOffset === 0)
        ? {
            reducerVersion: cursor.reducerVersion,
            reducedThroughOffset: cursor.reducedThroughOffset,
            state: state !== undefined ? state : this.contract.initialState(),
          }
        : {
            reducerVersion: this.contract.version,
            reducedThroughOffset: 0,
            state: this.contract.initialState(),
          };
    return this.#progress;
  }

  /** Re-reduce from offset 0 (the contract version changed). Durable rows only — never re-runs
   *  effects, and (by design) never sees dead ephemerals. */
  async #rereduceIfVersionChanged(): Promise<void> {
    if (this.#progress) return; // version can't change within an incarnation — probe storage once
    const stored = this.#storage.get<{ reducerVersion: string }>(this.#progressKey());
    if (!stored || stored.reducerVersion === this.contract.version) return;
    let state = this.contract.initialState();
    let after = 0;
    for (;;) {
      const page = await this.stream.read(after, 500);
      for (const event of page.events) {
        if (this.#consumes(event)) state = this.reduce({ event, state }) ?? state;
      }
      after = page.scannedThroughOffset;
      if (page.events.length < 500) break;
    }
    this.#progress = { reducerVersion: this.contract.version, reducedThroughOffset: after, state };
    this.#storage.put(this.#progressKey(), {
      reducerVersion: this.contract.version,
      reducedThroughOffset: after,
    });
    this.#storage.put(this.#stateKey(), state);
  }

  /** CURSOR-DRIVEN gap repair: read contiguously from the persisted cursor out of the log —
   *  a failed batch, a missed push, or a fresh incarnation can never skip a durable event. */
  async #catchUpBody(): Promise<void> {
    await this.#rereduceIfVersionChanged();
    for (;;) {
      const after = this.#loadProgress().reducedThroughOffset;
      const page = await this.stream.read(after, 500);
      const scannedOffsetRange = {
        scannedAfterOffset: after,
        scannedThroughOffset: page.scannedThroughOffset,
      };
      if (page.scannedThroughOffset <= after) return;
      await this.#processBatch(page.events, scannedOffsetRange, page.events.length < 500);
      if (page.events.length < 500) return;
    }
  }

  /** `"*"` covers every durable event; an ephemeral event must be NAMED to be consumed —
   *  except LIVE_STATE_CHANGED, which nothing may consume, ever (the loop guard). */
  #consumes(event: StreamEventT): boolean {
    return consumesEvent(this.contract.consumes, event);
  }

  /** Rules 2–5 over one contiguous scannedOffsetRange. The caller established contiguity. */
  async #processBatch(
    events: StreamEventT[],
    scannedOffsetRange: ScannedOffsetRange,
    atHead: boolean,
  ): Promise<void> {
    const progress = this.#loadProgress();
    let { state } = progress;
    let caughtUpDelivered = false;

    const makeAppend =
      (whileProcessing: StreamEventT | null) =>
      async (...inputs: StreamEventInputT[]): Promise<StreamEventT[]> => {
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
                ? {
                    whileProcessing: {
                      offset: whileProcessing.offset,
                      type: whileProcessing.type,
                    },
                  }
                : {}),
            },
          };
        }
        return await this.stream.append(...inputs);
      };

    const runOne = async (event: StreamEventT | null, caughtUp: boolean) => {
      const previousState = state;
      if (event) {
        let next: State | null | undefined;
        try {
          next = this.reduce({ event, state });
        } catch (error) {
          // A malformed/hostile event must not wedge the reduce forever: record the skip, move on.
          reportIssue("processor.reduce", error, {
            slug: this.contract.slug,
            offset: event.offset,
          });
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
        append: makeAppend(event),
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
      await blockers; // STRICT PER-EVENT ORDERING: this event's blocking work completes first
      if (caughtUp) caughtUpDelivered = true;
    };

    const sawDurable = events.some((e) => !e.ephemeral);
    const consumable = events.filter(
      (e) => this.#consumes(e) && e.offset > progress.reducedThroughOffset, // redelivery dedupe
    );
    for (let i = 0; i < consumable.length; i++) {
      await runOne(consumable[i], atHead && i === consumable.length - 1);
    }
    // Rule 5: reached the head without a caught-up event → one eventless at-head pass.
    if (atHead && !caughtUpDelivered) await runOne(null, true);

    // Rule 4: ONE persist per scannedOffsetRange, before the cursor advances — but NEVER for an
    // ephemeral-only scannedOffsetRange (a pure-ephemeral flood costs zero writes; after eviction the
    // cursor regresses only over events nobody can redeliver anyway).
    const next: ReduceProgress<State> = {
      reducerVersion: this.contract.version,
      reducedThroughOffset: scannedOffsetRange.scannedThroughOffset,
      state,
    };
    if (sawDurable) {
      this.#storage.put(this.#progressKey(), {
        reducerVersion: next.reducerVersion,
        reducedThroughOffset: next.reducedThroughOffset,
      });
      if (state !== progress.state) this.#storage.put(this.#stateKey(), state);
    }
    this.#progress = next;
    for (const w of this.#waiters.splice(0)) {
      if (next.reducedThroughOffset >= w.offset) w.resolve();
      else this.#waiters.push(w);
    }

    // LIVE STATE: if this scannedOffsetRange changed the PROJECTED shape, emit the delta — persist first,
    // emit second, so a crash between the two loses only a notification (healed by the chain
    // mismatch on the next change), never state. The revision advances even if the append
    // fails, for the same reason: a hole in the chain is a re-seed, a lie in it is corruption.
    // The WHOLE block is guarded — the reduce above already committed, so a projection/diff
    // failure (an unserializable value in state, a throwing projection) must degrade to a lost
    // notification, never to a rejected batch that snapshot()/waitUntilProcessed callers see.
    if (typeof this.liveState === "function" && state !== progress.state) {
      try {
        const patch = diff(this.liveState(progress.state), this.liveState(state));
        if (patch) {
          const from = this.#liveStateRev ?? progress.reducedThroughOffset;
          const to = scannedOffsetRange.scannedThroughOffset;
          this.#liveStateRev = to;
          await this.stream.append({
            type: LIVE_STATE_CHANGED,
            ephemeral: true,
            payload: { key: this.contract.slug, from, to, patch },
          });
        }
      } catch (error) {
        reportIssue("processor.live-state-emit", error, { slug: this.contract.slug });
      }
    }
  }
}
