// core/processor.ts — the stream processor base class. The AUTHOR surface mirrors apps/os
// (`reduce`/`processEvent`, `blockProcessorWhile`/`runInBackground`, `delivery.caughtUp`) so
// processors port both ways; the RUNNER lives in the same class — a processor and the thing
// that runs it are one object (the registry-of-N this replaced was bookkeeping for a
// multi-tenancy that never occurred: every facet hosts exactly one processor).
//
// THIS FILE IS THE HEART OF THE USERSPACE SDK: it keeps zero runtime imports (types only) and
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
// DELIVERY IS PUSH-FIRST with a SCAN-WINDOW PROOF. The stream pushes
// `processEventBatch(events, window)` after every commit; `window` proves the contiguous range
// scanned (`scannedAfterOffset` exclusive → `scannedThroughOffset` inclusive), so ephemeral
// holes, consumes-filters, and reboot gaps are all the same non-event — the cursor advances on
// the WINDOW, never by counting events. A non-contiguous push triggers GAP REPAIR: read durable
// rows from the own cursor until the head. Ephemeral events ride pushes ONLY (reads are
// durable-only; an ephemeral missed while a facet rebuilds is gone by design — nothing can
// redeliver it) and NEVER trigger a progress persist: an ephemeral-only window advances the
// cursor in memory alone, so a pure-ephemeral flood costs this class ZERO storage writes.
//
// `reduce` is a PURE fold (new object out, inputs immutable), cached per contract version;
// bumping `contract.version` refolds from offset 0 through `reduce` only (never re-running
// side effects) — and a refold reads durable rows only, which is why durable product truth must
// never be derived from an ephemeral event.

import type { z } from "zod";
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
  /** Bumping this refolds state from offset 0 (reduce only — side effects never re-run). */
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

/** The stream a processor folds. `read` answers durable rows plus the scan-window proof:
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
};

/** The contiguity proof a delivery carries: (scannedAfterOffset, scannedThroughOffset]. */
export type ScanWindow = { scannedAfterOffset: number; scannedThroughOffset: number };

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

type Progress<State> = {
  reducerVersion: string;
  reducedThroughOffset: number;
  state: State;
};

export abstract class StreamProcessor<State> {
  abstract readonly contract: ProcessorContract<State>;
  protected readonly stream: ProcessorStream;
  protected readonly path: string;
  protected readonly projectId: string;
  readonly #storage: ProcessorStorage;

  // Rule 1: the serial chain.
  #chain: Promise<void> = Promise.resolve();
  #progress: Progress<State> | null = null; // in-memory cache of the persisted fold
  #waiters: { offset: number; resolve: () => void }[] = [];

  constructor(args: {
    stream: ProcessorStream;
    storage: ProcessorStorage;
    path: string;
    projectId: string;
  }) {
    this.stream = args.stream;
    this.#storage = args.storage;
    this.path = args.path;
    this.projectId = args.projectId;
  }

  /** Pure fold. Return the NEXT state (a new object) — or null/undefined to keep the current. */
  protected reduce(_args: ReduceArgs<State>): State | null | undefined {
    return undefined;
  }

  /** Side-effect hook. Synchronous by design: register async work via the two helpers. */
  protected processEvent(_args: ProcessEventArgs<State>): undefined {}

  /** Stable idempotency key namespaced by slug; add `whileProcessing` for per-event keys. */
  protected idempotencyKey(key: string, whileProcessing?: StreamEventT): string {
    return whileProcessing
      ? `${this.contract.slug}/${key}@${this.path}:${whileProcessing.offset}`
      : `${this.contract.slug}/${key}`;
  }

  // ── the drive doors ──

  /** THE push door: the stream (or hosting facet) hands the just-committed batch with its
   *  window. Contiguous → fold it directly (the fast path — no read); anything else → gap
   *  repair from the own cursor. Fire-and-forget safe: enqueues on the serial chain. */
  processEventBatch(events: StreamEventT[], window: ScanWindow): Promise<void> {
    return this.#enqueue(async () => {
      await this.#refoldIfNeeded();
      const progress = this.#loadProgress();
      if (window.scannedAfterOffset === progress.reducedThroughOffset) {
        await this.#processBatch(events, window, true);
      } else if (window.scannedThroughOffset > progress.reducedThroughOffset) {
        await this.#catchUpBody(); // gap (fresh incarnation, dropped push) — repair from the log
      } // else: a stale redelivery — the window is already behind us; nothing to do
    });
  }

  /** Catch up from the own persisted cursor (cold boot, reads). A wake carries nothing. */
  wake(): Promise<void> {
    return this.#enqueue(() => this.#catchUpBody());
  }

  // ── the read surface ──

  /** Fold-and-effects caught up through the log, then the current snapshot. */
  async snapshot(): Promise<ProcessorSnapshot<State>> {
    await this.wake();
    const progress = this.#loadProgress();
    return { offset: progress.reducedThroughOffset, state: progress.state };
  }

  /** THE barrier verb (read-your-writes): resolves once processed AT LEAST through `offset`. */
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    const { offset, timeoutMs = 10_000 } = input;
    return new Promise<void>((resolve, reject) => {
      if (this.#loadProgress().reducedThroughOffset >= offset) return resolve();
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `processor "${this.contract.slug}" did not reach offset ${offset} in ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      this.#waiters.push({
        offset,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
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

  #loadProgress(): Progress<State> {
    if (this.#progress) return this.#progress;
    const stored = this.#storage.get<Progress<State>>(this.#progressKey());
    this.#progress =
      stored && stored.reducerVersion === this.contract.version
        ? stored
        : {
            reducerVersion: this.contract.version,
            reducedThroughOffset: 0,
            state: this.contract.initialState(),
          };
    return this.#progress;
  }

  /** Refold from 0 through `reduce` only (contract version changed). Durable rows only — never
   *  re-runs effects, and (by design) never sees dead ephemerals. */
  async #refoldIfNeeded(): Promise<void> {
    const stored = this.#storage.get<Progress<State>>(this.#progressKey());
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
    this.#storage.put(this.#progressKey(), this.#progress);
  }

  /** CURSOR-DRIVEN gap repair: read contiguously from the persisted cursor out of the log —
   *  a failed batch, a missed push, or a fresh incarnation can never skip a durable event. */
  async #catchUpBody(): Promise<void> {
    await this.#refoldIfNeeded();
    for (;;) {
      const after = this.#loadProgress().reducedThroughOffset;
      const page = await this.stream.read(after, 500);
      const window = { scannedAfterOffset: after, scannedThroughOffset: page.scannedThroughOffset };
      if (page.scannedThroughOffset <= after) return;
      await this.#processBatch(page.events, window, page.events.length < 500);
      if (page.events.length < 500) return;
    }
  }

  /** `"*"` covers every durable event; an ephemeral event must be NAMED to be consumed. */
  #consumes(event: StreamEventT): boolean {
    if (event.ephemeral) return this.contract.consumes.includes(event.type);
    return this.contract.consumes.includes("*") || this.contract.consumes.includes(event.type);
  }

  /** Rules 2–5 over one contiguous window. The caller established contiguity. */
  async #processBatch(events: StreamEventT[], window: ScanWindow, atHead: boolean): Promise<void> {
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
          // A malformed/hostile event must not wedge the fold forever: record the skip, move on.
          console.error(
            `processor "${this.contract.slug}" reduce failed at offset ${event.offset}`,
            error,
          );
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
            console.error(`processor "${this.contract.slug}" background work failed`, error),
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

    // Rule 4: ONE persist per window, before the cursor advances — but NEVER for an
    // ephemeral-only window (a pure-ephemeral flood costs zero writes; after eviction the
    // cursor regresses only over events nobody can redeliver anyway).
    const next: Progress<State> = {
      reducerVersion: this.contract.version,
      reducedThroughOffset: window.scannedThroughOffset,
      state,
    };
    if (sawDurable) this.#storage.put(this.#progressKey(), next);
    this.#progress = next;
    for (const w of this.#waiters.splice(0)) {
      if (next.reducedThroughOffset >= w.offset) w.resolve();
      else this.#waiters.push(w);
    }
  }
}
