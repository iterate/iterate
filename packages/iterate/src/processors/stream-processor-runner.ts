// The stream-processor runner owns everything a processor author should not —
// cursors, checkpoint cadence, retry, and recovery —
// so the processor itself can stay pure-ish hooks (reduce / processEvent —
// fold-derived side effects ride processEvent under `delivery.caughtUp`, not
// a separate hook). Design:
// docs/stream-processor-runner-redesign.md; the invariants are pinned by the
// in-memory harness in stream-processor-runner.test.ts (the executable spec).
//
// The shape inversion this file exists for: the legacy host was the star
// (`createStreamProcessorHost(ctx)` + `host.add(factory)`, hand-fed a Durable
// Object ctx). Here the PROCESSOR is passed INTO the runner, and the runner is
// a plain runtime-neutral object — the same class runs in a browser tab over
// SQLite, in a Durable Object over KV, and in the in-memory test harness that
// serves as the semantic spec. Nothing Cloudflare-shaped enters the core:
// anything durable arrives through the optional `durability` adapter, and
// anything incarnation-shaped through the optional `keepAlive` hook.
//
// Event batches: `openEventBatchCallback()` returns the committed processing
// offset plus the `processEventBatch` callback a direct source can retain and call.
// `openHostedEventBatchCallback()` is the trusted hosted-source variant: it
// accepts the source's own lifetime identity and defers any journal refold until
// the one-way callback, breaking a source-alarm -> facet-wake -> source-read cycle.
// Hosted wake wraps its promise with an independent one-way settlement
// capability; a browser's local event database calls the same runtime-neutral
// API directly.
// The runner reduces/processes ONE EVENT AT A TIME, so batch division is
// invisible to processor semantics (the harness pins this: one batch,
// singletons, or random partitions of the same journal must produce identical
// outcomes). `blockProcessorWhile` is therefore a strict per-event barrier,
// never a per-batch one — and registrations within one event run in strict
// FIFO order (each blocker starts after the previous settles), so authors
// order fold-derived work after per-event work simply by registering it
// later.
//
// The load-bearing orderings in here are transplanted from the legacy
// `StreamProcessor.#ingest` (deleted with the host) — the most
// incident-scarred loop in the system — and each is marked at its new home:
//   - failed batch settles already-started blockers, cursor untouched
//   - persist BEFORE advancing the in-memory cursor
//   - malformed consumed events advance the cursor, diagnostics append AFTER
//     the commit, in the background
//
// This runner owns processor reduction, processing, progress, and callback batching.

import type { z } from "zod";
import type { ProcessorStream } from "./stream-handle.ts";
import type { ProcessorState } from "./processor-contracts.ts";
import type { StreamEvent } from "./schemas.ts";
import type { StreamEventBatch } from "./rpc-types.ts";
import {
  awaitKeepAliveBacked,
  StreamProcessor,
  type MaybePromise,
  type StreamProcessorContract,
  type StreamProcessorRunnerHooks,
} from "./stream-processor.ts";

/**
 * The reduction half of a processor's durable progress: a disposable CACHE of
 * the fold (the journal is the authority). `reducerVersion` is the cache key —
 * a deploy that changes it invalidates the cache and triggers an automatic
 * reduce-only refold at load, which re-runs `reduce` ONLY. That is the whole point of splitting
 * this from {@link ProcessingProgress}: today's single `{offset, state}` cursor
 * makes a routine state-schema deploy refold history AND re-run `processEvent`
 * across it, re-driving real vendor calls.
 */
export type ReductionProgress<State> = {
  /** Cache key for the fold; a mismatch discards `state` and refolds. */
  reducerVersion: string;
  /** The highest offset folded into `state`. */
  reducedThroughOffset: number;
  /** The fold through `reducedThroughOffset`, under `reducerVersion`. */
  state: State;
};

/**
 * The processing half of a processor's durable progress: the AUTHORITATIVE
 * effect-acknowledgement cursor. Unlike the reduction cache it is never
 * discarded — rewinding it re-runs side effects. `cursorRevision` is the CAS
 * fence for exactly those rewinds: every commit asserts it, and a bump makes
 * every in-flight continuation of the old cursor position stale (the browser
 * projection reset rewinds this way — see
 * browserProcessorProgressRewindStatements in processor-state-storage.ts).
 */
export type ProcessingProgress = {
  /** Every effect at or below this offset is acknowledged (durably settled). */
  acknowledgedThroughOffset: number;
  /** Monotonic fencing token; a bump is the only sanctioned way to move
   * `acknowledgedThroughOffset` backward. */
  cursorRevision: number;
};

/**
 * A processor's two durable positions, persisted as one record. Invariant
 * (when persisted): `reduction.reducedThroughOffset <=
 * processing.acknowledgedThroughOffset` — the fold cache may lag the effect
 * cursor (it is rebuildable), but a fold AHEAD of acknowledged effects would
 * let `snapshot()` show state derived from events whose effects a cursor
 * rewind is about to re-run. Core (Phase 2) is the graceful degradation:
 * reduction only, no processing cursor — same structure, same reduce-only refold.
 */
export type ProcessorProgress<State> = {
  /** Random identity of the stream lifetime whose offsets and fold this record describes. */
  streamId: string;
  reduction: ReductionProgress<State>;
  processing: ProcessingProgress;
};

/**
 * Durable progress store, CAS-fenced by `cursorRevision`. The runner reads
 * once at open, then commits once per delivered batch; `commit` rejects
 * (throws) if `expectedCursorRevision` no longer matches the persisted
 * revision — the fence that stops a stale incarnation (or a continuation
 * outliving a cursor rewind) from clobbering the rewound cursor.
 * An absent record reads as revision 0. Backends: DO KV, browser SQLite
 * (where the committer folds projection writes and this record into ONE
 * transaction), or a plain object in tests.
 */
export type ProcessorProgressStore<State> = {
  read(): MaybePromise<ProcessorProgress<State> | undefined>;
  commit(
    progress: ProcessorProgress<State>,
    opts: { expectedCursorRevision: number; expectedStreamId: string | undefined },
  ): MaybePromise<void>;
  /**
   * Atomically replace progress after the stream at this path is recreated.
   * Backends with related durable projections must reset those in the same
   * transaction; omitting this method makes recreation fail closed.
   */
  replaceForStream?(
    progress: ProcessorProgress<State>,
    opts: { expectedCursorRevision: number; expectedStreamId: string },
  ): MaybePromise<void>;
};

/**
 * Optional recovery capability. Present only for durable processors that own
 * background obligations (`runInBackground` work whose OUTCOME matters).
 *
 * - `keepAliveWhile` schedules a durable alarm ahead of in-flight work, so an
 *   incarnation that dies owing work is revived by the alarm's fire. The
 *   production adapter is `(work) => keepalive.track(work())` over ONE
 *   ProcessorKeepalive (stream-processor-keepalive.ts) — the runner REUSES
 *   that machinery wholesale, it never reinvents mark/backoff/quiet-clean.
 * - The adapter's private revival pass appends the core
 *   `stream/processor-revived` fact (the payload's `processorSlug` names the
 *   revived processor), guaranteeing at least one delivery turn even at zero
 *   lag. Consuming the fact is OPTIONAL: an unconsumed head-reaching frame
 *   still gets the runner's eventless
 *   `processEvent({ event: null, delivery: { caughtUp: true } })` pass.
 * - `handleAlarm` services the durable timer (`ProcessorKeepalive.onAlarm`);
 *   the host DO multiplexes its single alarm across runners and routes fires
 *   to {@link StreamProcessorRunner.handleAlarm}, which delegates here.
 */
export type ProcessorRecovery = {
  keepAliveWhile(work: () => Promise<unknown>): void;
  handleAlarm(info?: unknown): MaybePromise<void>;
  /**
   * Operator seam: clear the keepalive's crash-loop budget and pull an owed
   * retry in to the confirmation lead — the no-deploy antidote for a
   * 3-strikes revival plateau. Optional: in-memory/test recoveries without a
   * durable budget have nothing to reset.
   */
  resetBackoff?(): void;
};

/**
 * The ONE optional durability adapter a hosting runtime hands the runner:
 * `progress` is required whenever the processor is durable at all (without the
 * adapter the runner keeps progress in memory — tests, ephemeral browser
 * views); `recovery` is orthogonal and present only when the processor owns
 * background work that must survive eviction. This is deliberately where
 * every runtime-specific concern lives — no Cloudflare `ctx` in the runner.
 */
type ProcessorDurability<State> = {
  progress: ProcessorProgressStore<State>;
  recovery?: ProcessorRecovery;
};

/** Honest delivery information handed to `processEvent`. */
export type DeliveryContext = {
  /** Random identity of the stream lifetime that delivered this turn. */
  streamId: string;
  /**
   * The at-head signal: the scan has reached the highest raw stream offset
   * the runner has observed, so `state` is the complete reduction of
   * everything it has seen. It is true on the last consumed event of a
   * head-reaching frame. If that frame contains no consumed event, the runner
   * makes one eventless `processEvent` call (`event: null`) with this flag
   * instead; an unconsumed tail must not strand obligations on an otherwise
   * quiet stream.
   */
  caughtUp: boolean;
};

/**
 * One transport scan as delivered to the runner. The scan coordinates are
 * first-class rather than inferred from `events`: a delivery may deliberately
 * omit ephemeral or selector-filtered rows, including an entirely empty
 * interval, while still proving that every raw offset in the interval was
 * examined. Advancing through that proof is what prevents filtered rows from
 * leaving a processor cursor below the scanned-through offset.
 */
export type StreamProcessorEventBatch = Pick<
  StreamEventBatch,
  "events" | "scannedAfterOffset" | "scannedThroughOffset" | "streamId" | "streamMaxOffset"
>;

/** A consumed-type event whose payload failed the contract parse, awaiting its post-commit diagnostic. */
type PendingParseFailure = { event: StreamEvent; error: z.ZodError };

/** A pending `waitUntilEvent` waiter (see the method doc for semantics). */
type EventWaiterBase = {
  reject: (error: unknown) => void;
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
};

type EventWaiter =
  | (EventWaiterBase & { kind: "predicate"; predicate: (event: StreamEvent) => boolean })
  | (EventWaiterBase & { kind: "offset"; offset: number });

/** The in-flight fold/cursor context of one batch, committed at batch end. */
type BatchContext<State> = {
  /** The revision every commit in this batch asserts (fixed at batch start). */
  revision: number;
  /** When processing this batch began — feeds the per-commit consumption metrics
   * (the legacy `#ingest` timed the whole batch the same way). */
  ingestStartedAtMs: number;
  state: State;
  reducedThroughOffset: number;
  completedThroughOffset: number;
  eventsSinceCommit: number;
  /** New events delivered since the last commit — waiters resolve when their commit lands. */
  uncommittedEvents: StreamEvent[];
  /** Parse failures since the last commit — diagnostics append only AFTER their commit lands. */
  uncommittedParseFailures: PendingParseFailure[];
};

/**
 * Processes event batches for one processor on one stream. Runtime-neutral:
 * the browser, the Durable Object registry, and the in-memory
 * test harness all instantiate exactly this class and differ only in the
 * `durability` / `keepAlive` adapters they pass. One runner per processor —
 * the "host" of old survives only as a thin registry that builds adapters and
 * routes wakes/alarms to the right runner.
 *
 * Serialization: batches and self-pulls share ONE in-memory chain, so a
 * catch-up never interleaves with a half-processed batch. Cross-incarnation
 * races (a stale runner outliving progress made elsewhere) are fenced durably
 * instead, by the progress store's `cursorRevision` CAS + monotonic fence.
 */
export class StreamProcessorRunner<
  Contract extends StreamProcessorContract,
  Deps extends object = object,
> {
  private readonly processor: StreamProcessor<Contract, Deps>;
  private readonly hooks: StreamProcessorRunnerHooks<Contract>;
  private readonly stream: ProcessorStream;
  private readonly durability: ProcessorDurability<ProcessorState<Contract>> | undefined;
  private readonly keepAlive: ((work: () => Promise<unknown>) => void) | undefined;
  private readonly now: () => number;
  private readonly readPageSize: number;

  /** Memoized load for one stream lifetime; cleared on failure or recreation. */
  #loaded: Promise<void> | undefined;
  #loadingStreamId: string | undefined;
  /** True once progress reflects a real load (fresh default over an empty
   * store counts; a pending/failed load does not) — the gate that keeps
   * default or partially-refolded state from ever escaping (the legacy
   * `isLoaded` invariant). `snapshot()` additionally
   * awaits the load, so partial state cannot escape through it either. */
  #hasLoaded = false;
  /** The COMMITTED, loaded progress — what snapshots and direct callbacks publish.
   * A hosted wake may publish only the separately-read processing cursor before this
   * reduction cache loads. Batch folds accumulate in locals and land here only after
   * the durable commit. */
  #progress: ProcessorProgress<ProcessorState<Contract>> | undefined;
  /** Highest stream offset observed across all batches this incarnation. */
  #highestObservedOffset = 0;
  /** Serializes batches + self-pulls; failures are contained per entry. */
  #chain: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #eventWaiters = new Set<EventWaiter>();
  readonly #stateChangeObservers = new Set<
    (snapshot: { offset: number; state: ProcessorState<Contract> }) => void
  >();
  /** Memoized schema default, for pre-load `currentState` reads. */
  #defaultState: ProcessorState<Contract> | undefined;

  constructor(args: {
    /** The processor to run — passed in; the runner never constructs one. */
    processor: StreamProcessor<Contract, Deps>;
    /** The processor's home stream (replay reads, revival appends). */
    stream: ProcessorStream;
    /** Durable progress + optional recovery; omit for in-memory (tests, ephemeral views). */
    durability?: ProcessorDurability<ProcessorState<Contract>>;
    /** Keeps in-flight work alive with the hosting DO's `waitUntil`. */
    keepAlive?: (work: () => Promise<unknown>) => void;
    /** Injected clock for the test harness; production uses Date.now. */
    now?: () => number;
    /** Journal read page size (refold/catch-up paging); tests shrink it. */
    readPageSize?: number;
  }) {
    this.processor = args.processor;
    this.hooks = StreamProcessor.runnerHooks(args.processor);
    this.stream = args.stream;
    this.durability = args.durability;
    this.keepAlive = args.keepAlive;
    this.now = args.now ?? (() => Date.now());
    this.readPageSize = args.readPageSize ?? 500;
  }

  /**
   * Opens the processor's event-batch callback and returns its committed
   * processing offset. A hosted processor wake returns this pair to a source
   * stream; the browser database writer calls the same method directly.
   *
   * `checkpointOffset` is the PROCESSING cursor (`acknowledgedThroughOffset`),
   * never the reduction offset: the caller resumes after this value, and
   * resuming from a reduction-pinned snapshot
   * offset could skip events whose effects were never acknowledged.
   *
   * `processEventBatch` is the only place transport batching enters the
   * runner; inside it the runner reduces and processes one event at a time. A
   * hosting transport may adapt how the promise is observed, but must not
   * duplicate these semantics.
   */
  async openEventBatchCallback(expectedStreamId?: string): Promise<{
    checkpointOffset: number;
    processEventBatch: (batch: StreamProcessorEventBatch) => Promise<void>;
  }> {
    this.#assertNotDisposed();
    const opened = await this.#enqueue(async () => {
      const streamId = await this.#readCurrentStreamId(expectedStreamId);
      await this.#load(streamId);
      return {
        streamId,
        checkpointOffset: this.#requireProgress().processing.acknowledgedThroughOffset,
      };
    });
    return this.#eventBatchCallback({
      ...opened,
      deferredLoad: false,
      sourceScansAllEvents: false,
    });
  }

  /**
   * Open the callback used by a trusted hosted source Stream.
   *
   * The request already carries that source's authoritative stream ID. Reading
   * it back before returning would deadlock a colocated Processor Facet: the
   * source alarm owns the wake RPC while the facet's identity/refold read waits
   * for that same source turn. Return the durable processing cursor without a
   * source read, then finish any reduction-cache load when the source invokes
   * the independent one-way batch callback.
   */
  async openHostedEventBatchCallback(streamId: string): Promise<{
    checkpointOffset: number;
    processEventBatch: (batch: StreamProcessorEventBatch) => Promise<void>;
  }> {
    this.#assertNotDisposed();
    const checkpointOffset = await this.#enqueue(() => this.#prepareHostedCheckpoint(streamId));
    return this.#eventBatchCallback({
      streamId,
      checkpointOffset,
      deferredLoad: true,
      sourceScansAllEvents: true,
    });
  }

  #eventBatchCallback(args: {
    streamId: string;
    checkpointOffset: number;
    deferredLoad: boolean;
    sourceScansAllEvents: boolean;
  }): {
    checkpointOffset: number;
    processEventBatch: (batch: StreamProcessorEventBatch) => Promise<void>;
  } {
    return {
      checkpointOffset: args.checkpointOffset,
      processEventBatch: (batch: StreamProcessorEventBatch) => {
        const attempt = this.#enqueue(async () => {
          if (args.deferredLoad) await this.#loadPreparedStream(args.streamId);
          await this.#processBatch(batch);
        });
        // Zero-lag recovery must cover the WHOLE batch attempt, not merely
        // the work registered inside it (the June-10/July-7 incident class):
        // an eviction mid-batch on a stream that also died still gets this
        // processor revived by the keepalive alarm scheduled ahead of `attempt`.
        // A failed attempt reads as failure to the keepalive (routing the
        // next fire to revival); the transport observes the same rejection
        // through the returned promise and owns the redelivery.
        this.durability?.recovery?.keepAliveWhile(() => attempt);
        // Direct callback batches can contain only consumed event types while
        // carrying a later raw stream maximum. Without another reader, an
        // unconsumed tail would keep `delivery.caughtUp` false and strand any
        // obligation the batch opened. The runner therefore pulls the raw
        // journal after a successful direct batch. The pull is serialized with
        // delivery, kept alive independently from the transport promise, and
        // retried by durable recovery if it fails.
        //
        // Hosted stream delivery is different: its source already scans every
        // raw offset and sends empty frames across configured-filter gaps.
        // That transport must remain the only catch-up driver or a runner pull
        // would consume events the subscription explicitly excluded.
        if (!args.sourceScansAllEvents) {
          this.#runInBackground(() =>
            attempt.then(
              () =>
                this.#enqueue(async () => {
                  const { processing } = this.#requireProgress();
                  if (processing.acknowledgedThroughOffset < batch.streamMaxOffset) {
                    await this.#selfCatchUp();
                  }
                }),
              () => undefined,
            ),
          );
        }
        return attempt;
      },
    };
  }

  /** Handle a durable recovery alarm routed here by the hosting registry. */
  async handleAlarm(info?: unknown): Promise<void> {
    const recovery = this.durability?.recovery;
    if (recovery === undefined) return;
    await recovery.handleAlarm(info);
  }

  /** One consistent read of the fold, pinned to `reducedThroughOffset`. */
  async snapshot(): Promise<{ offset: number; state: ProcessorState<Contract> }> {
    return this.#enqueue(async () => {
      const streamId = await this.#readCurrentStreamId();
      await this.#load(streamId);
      const progress = this.#requireProgress();
      return {
        offset: progress.reduction.reducedThroughOffset,
        state: progress.reduction.state,
      };
    });
  }

  /**
   * Whether published state IS a real fold rather than the schema default —
   * the legacy `isLoaded` gate. With the runner, the load itself performs any
   * pending refold, so this is true whenever a load has completed and false
   * only before the first successful load.
   */
  get isLoaded(): boolean {
    return this.#hasLoaded;
  }

  /**
   * The current committed fold, synchronously (the schema default until the
   * first load) — the legacy `StreamProcessor.currentState`,
   * kept so a hosting registry can assemble its
   * live state without an async hop. Gate on {@link isLoaded} first: a cold
   * runner reports the default, and publishing that anywhere live would wipe
   * real facts for state observers.
   */
  get currentState(): ProcessorState<Contract> {
    if (this.#progress !== undefined) return this.#progress.reduction.state;
    this.#defaultState ??= this.hooks.initialState();
    return this.#defaultState;
  }

  /**
   * Observe committed reduced-state changes IN-PROCESS: the observer is a
   * local function (the hosting registry wires it to reassemble its
   * live-state engine), never a retained RPC stub. It fires after a batch
   * commit lands durably AND the committed state changed identity — the
   * runner's home for the legacy `StreamProcessor.observeStateChanges` +
   * post-persist notify. Returns a function that stops observing.
   */
  observeStateChanges(
    observer: (snapshot: { offset: number; state: ProcessorState<Contract> }) => void,
  ): () => void {
    this.#stateChangeObservers.add(observer);
    return () => void this.#stateChangeObservers.delete(observer);
  }

  /**
   * Read journal pages after the acknowledged cursor and process them until
   * caught up — the public method for read-your-writes and a
   * hosting registry's cold-load healing (the legacy host's `catchUpInternal`
   * shape). One page of lookahead, so every non-final batch carries a
   * `streamMaxOffset` past its own last event and only the genuinely final page is
   * marked caught up. Serialized with delivered batches on the runner's chain; failures
   * RETHROW — the caller owns any swallow-and-log policy.
   */
  catchUp(): Promise<void> {
    return this.#enqueue(async () => {
      const streamId = await this.#readCurrentStreamId();
      await this.#load(streamId);
      await this.#selfCatchUp();
    });
  }

  /**
   * Resolve once the ACKNOWLEDGED cursor reaches `offset` — the single
   * wait-for-progress door (read-your-writes: append, then wait on the offset
   * the append returned). The offset form never depends on stream delivery to
   * reach an event that ALREADY EXISTS on the stream: when the cursor is
   * behind, it starts a chain-serialized journal read ({@link catchUp}); the
   * waiting promise covers only a genuinely
   * FUTURE offset the pull cannot reach yet. The predicate form observes
   * FUTURE deliveries only — an event not yet appended (e.g. runScript's
   * completion, appended later by `runInBackground` work; that work runs OFF
   * the runner chain and outside the awaiting handler, so the halted waiter
   * never gates the append or the delivery that resolves it) — and resolves
   * after the batch that delivered the matching event has durably committed,
   * so state already reflects it.
   */
  waitUntilEvent(args: {
    predicate: (event: StreamEvent) => boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<void>;
  waitUntilEvent(args: { offset: number; timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  async waitUntilEvent(
    args:
      | { predicate: (event: StreamEvent) => boolean; timeoutMs?: number; signal?: AbortSignal }
      | { offset: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    if (args.signal?.aborted === true) throw abortReason(args.signal);
    if ("offset" in args) {
      if (!Number.isSafeInteger(args.offset) || args.offset < 0) {
        throw new Error("waitUntilEvent offset must be a non-negative safe integer");
      }
      const streamId = await this.#readCurrentStreamId();
      await this.#load(streamId);
      if (this.#requireProgress().processing.acknowledgedThroughOffset >= args.offset) return;
      const { offset, signal, timeoutMs } = args;
      // No await between the check above and registering the waiter below
      // (the helper below registers synchronously), so a batch cannot
      // advance the cursor past `offset` in the gap and be missed.
      const reached = this.#registerEventWaiter({ kind: "offset", offset }, { signal, timeoutMs });
      // Self-pull, not wait-and-hope: this form's contract is read-your-writes
      // over an append that already committed. A waiting caller must not depend
      // only on an open callback that may stop responding or on a wake call
      // that may have been lost (the orphaned-announcement incident). The
      // catch-up runs on the runner chain, serialized with delivered
      // batches — no concurrent processing against a live batch, because
      // redelivered offsets dedupe against the acknowledged cursor — and
      // resolves the waiter through the ordinary frame commit. A genuinely
      // future offset stays parked for delivery after a successful pull. A
      // failed pull is authoritative, however: settle this wait immediately
      // so the caller can apply its bounded availability retry instead of
      // hiding the failure behind the full wait timeout.
      void this.catchUp().catch((error: unknown) => {
        reached.reject(error);
      });
      return await reached.promise;
    }
    const { predicate, signal, timeoutMs } = args;
    await this.#registerEventWaiter({ kind: "predicate", predicate }, { signal, timeoutMs })
      .promise;
  }

  /** Release processor resources. Idempotent; a disposed runner rejects new work. */
  dispose(): void {
    this.#disposed = true;
    for (const waiter of this.#eventWaiters) {
      this.#settleEventWaiter(waiter, { error: new Error("StreamProcessorRunner disposed") });
    }
    this.#stateChangeObservers.clear();
  }

  // ---------------------------------------------------------------------------
  // The per-event loop.
  // ---------------------------------------------------------------------------

  async #processBatch(batch: StreamProcessorEventBatch): Promise<void> {
    const ingestStartedAtMs = this.now();
    assertProcessorEventBatch(batch);
    const committed = this.#requireProgress();
    if (batch.streamId !== committed.streamId) {
      throw new Error(
        `stream processor "${this.hooks.contract.slug}" received batch for stream ID ` +
          `${batch.streamId}; current progress belongs to ${committed.streamId}`,
      );
    }
    const committedThroughOffset = committed.processing.acknowledgedThroughOffset;
    if (batch.scannedAfterOffset > committedThroughOffset) {
      throw new Error(
        `delivery batch starts after the committed scan cursor: ${batch.scannedAfterOffset} > ${committedThroughOffset}`,
      );
    }
    const batchScannedThroughOffset = Math.max(committedThroughOffset, batch.scannedThroughOffset);

    // Offset-dedupe against the acknowledged cursor (and within the batch):
    // redelivered events are silent skips, exactly like legacy ingest.
    const pending: StreamEvent[] = [];
    let scan = committedThroughOffset;
    for (const event of batch.events) {
      if (event.offset <= scan) continue;
      scan = event.offset;
      pending.push(event);
    }

    // Highest observed offset = max(streamMaxOffset, last scanned offset), monotonic across
    // batches: "the highest offset the runner has OBSERVED" never regresses on
    // a stale redelivery, so an older batch can still see that more rows exist.
    this.#highestObservedOffset = Math.max(
      this.#highestObservedOffset,
      batch.streamMaxOffset,
      batchScannedThroughOffset,
    );
    if (pending.length === 0 && batchScannedThroughOffset === committedThroughOffset) return;
    const highestObservedOffset = this.#highestObservedOffset;

    // `caughtUp` is a batch property, not a per-event-offset one. If this batch
    // scans through the highest offset observed so far, then by the end of it
    // the processor has seen EVERYTHING the stream has reported, so its LAST consumed event gets
    // `caughtUp: true` even though that event's own offset may sit far below
    // the maximum (a batch of 100 where only the first is consumed still leaves
    // the processor caught up).
    const batchCaughtUp = batchScannedThroughOffset >= highestObservedOffset;
    // The offset of the LAST event this batch will actually deliver to
    // `processEvent` — a consumed type that PARSES. `isDeliverable` folds in
    // the wildcard (`"*"` consumes every type) AND excludes malformed consumed
    // events: without the parse check a malformed final event would be
    // selected as "last consumed", steal the `caughtUp` flag from the real
    // last-good event (which never gets it), and strand its obligation.
    let lastDeliveredOffset: number | null = null;
    for (const event of pending) {
      if (this.hooks.isDeliverable(event)) lastDeliveredOffset = event.offset;
    }
    // Whether a CONSUMED event carried `caughtUp` this batch. If the scan
    // reached the highest observed offset but none of its events did (all remaining events are
    // unconsumed — a self-pull that folded only foreign events, or a filtered
    // wake batch whose final durable row is an unconsumed presence fact), the runner
    // still owes the processor one caught-up call: it calls `processEvent` with
    // `event: null` after the loop. Without it pending work strands
    // whenever an unconsumed event (e.g. stream/connection-closed) sits
    // at the latest offset — the late-agent preview regression.
    let firedCaughtUp = false;

    const ctx: BatchContext<ProcessorState<Contract>> = {
      revision: committed.processing.cursorRevision,
      ingestStartedAtMs,
      state: committed.reduction.state,
      reducedThroughOffset: committed.reduction.reducedThroughOffset,
      completedThroughOffset: committed.processing.acknowledgedThroughOffset,
      eventsSinceCommit: 0,
      uncommittedEvents: [],
      uncommittedParseFailures: [],
    };
    /** Every blocker started anywhere in this batch, for failure settlement. */
    const startedBlockers: Promise<unknown>[] = [];

    try {
      for (const event of pending) {
        const reduction = this.hooks.reduceRawEvent({ event, state: ctx.state });
        if (reduction !== undefined && "parseError" in reduction) {
          // A malformed consumed event is a fact of the log, not an
          // exception: collect it, keep advancing (the cursor must never
          // wedge on it), and record it AFTER its commit lands (below).
          ctx.uncommittedParseFailures.push({ event, error: reduction.parseError });
        } else if (reduction !== undefined) {
          // `caughtUp` on the LAST delivered event of a batch that scanned through
          // the highest observed offset (not a comparison of this event alone — that
          // fails when a later unconsumed event is the batch's final row).
          const caughtUp = batchCaughtUp && event.offset === lastDeliveredOffset;
          if (caughtUp) firedCaughtUp = true;
          const delivery: DeliveryContext = {
            caughtUp,
            streamId: batch.streamId,
          };
          // FIFO blocker chain: each registration starts only after the
          // previous one settles, so a later registration in the same
          // `processEvent` body observes the earlier registrations' appends.
          // That ordering is load-bearing: e.g. an interrupt's cancel append
          // (registered in the per-event switch) must precede a fold-derived
          // re-fire registered after it, or the re-fire wins the fold and the
          // cancel no-ops. Registration order replaces the deleted deferred
          // `blockProcessorWhileCaughtUp` mechanism.
          let eventChain: Promise<unknown> = Promise.resolve();
          const whileProcessing = reduction.event;
          this.hooks.processEvent({
            event: reduction.event,
            previousState: reduction.previousState,
            state: reduction.state,
            delivery,
            blockProcessorWhile: (work) => {
              const attempt = eventChain.then(() =>
                this.#keepAliveBackedWork(work).catch((error: unknown) => {
                  console.error(
                    `stream processor blocked work failed (${this.hooks.contract.slug})`,
                    error,
                  );
                  throw error;
                }),
              );
              eventChain = attempt;
              startedBlockers.push(attempt);
            },
            runInBackground: (work) => this.#runInBackground(work),
            append: (...input) =>
              this.hooks.append({ streamId: batch.streamId, whileProcessing }, input),
            appendTo: (path, ...input) =>
              this.hooks.appendTo(path, { streamId: batch.streamId, whileProcessing }, input),
          });
          // STRICT PER-EVENT ORDERING: THIS event's blocking work completes
          // before the next event's processEvent starts. Background work was
          // registered (keepalive-backed) and deliberately NOT awaited — it
          // may overtake later events.
          await eventChain;
          ctx.state = reduction.state;
        }
        // Non-consumed and malformed events advance both cursors too —
        // matching what a filtered delivery's cursor does today.
        ctx.reducedThroughOffset = event.offset;
        ctx.completedThroughOffset = event.offset;
        ctx.eventsSinceCommit += 1;
        ctx.uncommittedEvents.push(event);
      }
      // Eventless caught-up call. Normally `delivery.caughtUp` rides the last
      // consumed event in the final batch. But a batch can scan through the
      // highest observed offset with NO consumed event carrying that flag — a
      // SQLite read that folded only unconsumed remaining events, or a filtered wake batch
      // whose final durable row is an unconsumed presence fact (e.g.
      // stream/connection-closed). Deferring the reconcile to "the next
      // consumed event" strands the obligation when the stream then goes quiet
      // (the late-agent preview regression). So the
      // runner calls the processor over the final fold: `event` is null
      // (the processor skips its per-event switch), appends are unstamped, and
      // obligation keys are offset-free (`this.idempotencyKey`), stable across
      // passes. Its blockers are awaited before the deferred batch-end commit.
      if (batchCaughtUp && !firedCaughtUp) {
        const delivery: DeliveryContext = {
          caughtUp: true,
          streamId: batch.streamId,
        };
        // Same FIFO blocker chain as the per-event dispatch; its work is
        // awaited before the deferred batch-end commit.
        let caughtUpChain: Promise<unknown> = Promise.resolve();
        this.hooks.processEvent({
          event: null,
          previousState: ctx.state,
          state: ctx.state,
          delivery,
          blockProcessorWhile: (work) => {
            const attempt = caughtUpChain.then(() =>
              this.#keepAliveBackedWork(work).catch((error: unknown) => {
                console.error(
                  `stream processor blocked work failed (${this.hooks.contract.slug})`,
                  error,
                );
                throw error;
              }),
            );
            caughtUpChain = attempt;
            startedBlockers.push(attempt);
          },
          runInBackground: (work) => this.#runInBackground(work),
          append: (...input) => this.hooks.append({ streamId: batch.streamId }, input),
          appendTo: (path, ...input) =>
            this.hooks.appendTo(path, { streamId: batch.streamId }, input),
        });
        await caughtUpChain;
      }
      // The batch's scan proof covers omitted rows too. They are deliberate
      // no-ops for this processor, but both cursors must advance across them
      // atomically with the durable events above — including an empty scan.
      ctx.reducedThroughOffset = batchScannedThroughOffset;
      ctx.completedThroughOffset = batchScannedThroughOffset;
    } catch (error) {
      // A failed batch must still settle work it already registered so
      // nothing rejects unobserved. Whatever was not yet durably committed is
      // not committed now — the batch stays retryable and the transport
      // replays it from the last acknowledged cursor.
      // (The legacy #ingest's failure settlement, verbatim.)
      await Promise.allSettled(startedBlockers);
      throw error;
    }

    // FIXED CADENCE: one durable commit per delivered batch, after EVERY
    // event's blocking work — including the caught-up call — has settled
    // (the legacy batch checkpoint window exactly). The gap between the
    // in-memory cursor and the last persisted acknowledgement is the
    // deliberate at-least-once replay window (appends stay
    // idempotency-keyed). Committing only at batch end is also what keeps a
    // failed caught-up call retryable: a mid-batch commit of the final
    // event would strand that call with the cursor already at the maximum offset
    // and redelivery empty.
    if (ctx.eventsSinceCommit > 0 || batchScannedThroughOffset > committedThroughOffset) {
      await this.#commitBatchContext(ctx);
    }
  }

  /**
   * Persist the batch context, THEN advance the published cursor, resolve
   * waiters, and flush parse-failure diagnostics for the covered events.
   *
   * Persist-before-advance is load-bearing (the legacy #ingest's ordering):
   * if the durable write fails, the batch must stay retryable — the redelivered
   * batch re-reduces from the OLD published state and retries the write.
   * Advancing in-memory first would make the retry a silent no-op (every
   * event filtered out, nothing re-saved), losing the batch durably.
   */
  async #commitBatchContext(ctx: BatchContext<ProcessorState<Contract>>): Promise<void> {
    const streamId = this.#requireProgress().streamId;
    const next: ProcessorProgress<ProcessorState<Contract>> = {
      streamId,
      reduction: {
        reducerVersion: this.hooks.contract.version,
        reducedThroughOffset: ctx.reducedThroughOffset,
        state: ctx.state,
      },
      processing: {
        acknowledgedThroughOffset: ctx.completedThroughOffset,
        cursorRevision: ctx.revision,
      },
    };
    const previousCommittedState = this.#progress?.reduction.state;
    await this.#commit(next, {
      expectedCursorRevision: ctx.revision,
      expectedStreamId: streamId,
    });
    this.#progress = next;
    ctx.eventsSinceCommit = 0;
    const committedEvents = ctx.uncommittedEvents.splice(0);
    const committedFailures = ctx.uncommittedParseFailures.splice(0);
    // The commit is durable and the published cursor advanced — the events
    // are genuinely CONSUMED, which is the moment self-measured event-consumption
    // metrics report (the legacy #ingest's noteBatchIngested placement).
    // Fed through the processor hooks so the wake capability's
    // consumption-lag samples stay current.
    if (committedEvents.length > 0) {
      const newestEventCreatedAtMs = Date.parse(committedEvents.at(-1)!.createdAt);
      this.hooks.noteBatchIngested({
        ingestedThroughOffset: next.processing.acknowledgedThroughOffset,
        ...(Number.isFinite(newestEventCreatedAtMs) ? { newestEventCreatedAtMs } : {}),
        eventCount: committedEvents.length,
        ingestStartedAtMs: ctx.ingestStartedAtMs,
        atMs: this.now(),
      });
    }
    // Observers before waiters, both after the durable commit — the legacy
    // ingest ordering: by the time either
    // fires, published state already reflects the committed batch.
    if (!Object.is(previousCommittedState, next.reduction.state)) {
      this.#notifyStateChange({
        offset: next.reduction.reducedThroughOffset,
        state: next.reduction.state,
      });
    }
    this.#resolveEventWaiters(committedEvents, next.processing.acknowledgedThroughOffset);
    // Record skipped unparseable events AFTER the commit, in the background:
    // the raw event in the log is the authoritative record and the
    // idempotency key dedupes redelivery, so a failing record append can
    // never fail the batch it just rescued again.
    // (This preserves the legacy #ingest parse-failure behavior.)
    for (const { event, error } of committedFailures) {
      const message =
        `stream processor "${this.hooks.contract.slug}" skipped event at offset ` +
        `${event.offset} ("${event.type}"): it fails the contract's schema`;
      console.error(message, error);
      // A guarded raw append, not a processor-declared emitted event:
      // `stream/error-occurred` is core-owned and deliberately absent from
      // subclass `emits` — this is the runtime speaking, not the processor
      // author. The guard stops a delayed diagnostic for lifetime A from
      // landing after this path has been recreated as lifetime B.
      this.#runInBackground(() =>
        this.stream.appendIfStreamId({
          streamId,
          events: [
            {
              type: "events.iterate.com/stream/error-occurred",
              idempotencyKey: this.hooks.idempotencyKey("event-parse-failed", event),
              source: { processor: this.hooks.processorStamp(streamId, event) },
              payload: {
                message,
                error: { name: error.name, message: error.message },
              },
            },
          ],
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Progress load / refold / commit.
  // ---------------------------------------------------------------------------

  /**
   * Return the hosted source's authoritative effect cursor without reading
   * that source. Fresh/recreated lifetimes still land their durable fence
   * before the checkpoint escapes; an existing lifetime leaves its disposable
   * reduction cache unloaded until the one-way delivery callback.
   */
  async #prepareHostedCheckpoint(streamId: string): Promise<number> {
    if (this.#hasLoaded && this.#progress?.streamId === streamId) {
      return this.#progress.processing.acknowledgedThroughOffset;
    }
    if (this.#hasLoaded) {
      this.#hasLoaded = false;
      this.#loaded = undefined;
      this.#loadingStreamId = undefined;
    }

    const persisted = await this.durability?.progress.read();
    if (persisted === undefined) {
      const fresh = this.#freshProgress(streamId, 0);
      await this.#commit(fresh, {
        expectedCursorRevision: 0,
        expectedStreamId: undefined,
      });
      this.#progress = fresh;
      this.#hasLoaded = true;
      return 0;
    }
    if (persisted.streamId === streamId) {
      return persisted.processing.acknowledgedThroughOffset;
    }

    const replaceForStream = this.durability?.progress.replaceForStream;
    if (replaceForStream === undefined) {
      throw new Error(
        `stream processor "${this.hooks.contract.slug}" progress belongs to stream ID ` +
          `${persisted.streamId}, but the current stream ID is ${streamId}; ` +
          `this durability backend must reset its related projections before reopening`,
      );
    }
    const fresh = this.#freshProgress(streamId, persisted.processing.cursorRevision + 1);
    await replaceForStream(fresh, {
      expectedCursorRevision: persisted.processing.cursorRevision,
      expectedStreamId: persisted.streamId,
    });
    this.#progress = fresh;
    this.#hasLoaded = true;
    this.#notifyStateChange({ offset: 0, state: fresh.reduction.state });
    return 0;
  }

  #load(streamId: string): Promise<void> {
    return this.#loadWithStreamReplacement(streamId, true);
  }

  #loadPreparedStream(streamId: string): Promise<void> {
    if (this.#hasLoaded) return Promise.resolve();
    return this.#loadWithStreamReplacement(streamId, false);
  }

  #loadWithStreamReplacement(streamId: string, replaceMismatchedStream: boolean): Promise<void> {
    if (this.#hasLoaded && this.#progress?.streamId === streamId) return Promise.resolve();
    if (this.#hasLoaded) {
      this.#hasLoaded = false;
      this.#loaded = undefined;
      this.#loadingStreamId = undefined;
    }
    if (this.#loaded !== undefined) {
      if (this.#loadingStreamId === streamId) return this.#loaded;
      return this.#loaded.then(() =>
        this.#loadWithStreamReplacement(streamId, replaceMismatchedStream),
      );
    }
    this.#loadingStreamId = streamId;
    this.#loaded = this.#loadOnce(streamId, replaceMismatchedStream).catch((error: unknown) => {
      // Clear the memoized load so a later call retries instead of replaying
      // this rejection forever.
      this.#loaded = undefined;
      this.#loadingStreamId = undefined;
      throw error;
    });
    return this.#loaded;
  }

  #freshProgress(
    streamId: string,
    cursorRevision: number,
  ): ProcessorProgress<ProcessorState<Contract>> {
    return {
      streamId,
      reduction: {
        reducerVersion: this.hooks.contract.version,
        reducedThroughOffset: 0,
        state: this.hooks.initialState(),
      },
      processing: { acknowledgedThroughOffset: 0, cursorRevision },
    };
  }

  async #loadOnce(streamId: string, replaceMismatchedStream: boolean): Promise<void> {
    const persisted = await this.durability?.progress.read();
    if (persisted === undefined) {
      // Fresh processor: nothing observed yet, so the schema default IS the
      // fold of the (empty) acknowledged prefix. Persist the stream ID before
      // a checkpoint can escape, so no later wake can adopt unrelated
      // pre-existing progress.
      const fresh = this.#freshProgress(streamId, 0);
      await this.#commit(fresh, {
        expectedCursorRevision: 0,
        expectedStreamId: undefined,
      });
      this.#progress = fresh;
      this.#hasLoaded = true;
      return;
    }

    if (persisted.streamId !== streamId) {
      if (!replaceMismatchedStream) {
        throw new Error(
          `hosted callback for stream ID ${streamId} is stale; processor progress belongs to ` +
            `${persisted.streamId}`,
        );
      }
      const replaceForStream = this.durability?.progress.replaceForStream;
      if (replaceForStream === undefined) {
        throw new Error(
          `stream processor "${this.hooks.contract.slug}" progress belongs to stream ID ` +
            `${persisted.streamId}, but the current stream ID is ${streamId}; ` +
            `this durability backend must reset its related projections before reopening`,
        );
      }
      const fresh = this.#freshProgress(streamId, persisted.processing.cursorRevision + 1);
      await replaceForStream(fresh, {
        expectedCursorRevision: persisted.processing.cursorRevision,
        expectedStreamId: persisted.streamId,
      });
      this.#progress = fresh;
      this.#hasLoaded = true;
      this.#notifyStateChange({ offset: 0, state: fresh.reduction.state });
      return;
    }

    const acknowledged = persisted.processing.acknowledgedThroughOffset;
    const parsed = this.hooks.parseState(persisted.reduction.state);
    // A persisted reduction AHEAD of the acknowledgement violates the record
    // invariant (see ProcessorProgress): publishing it would show state
    // derived from events whose effects are not acknowledged. Treat it as a
    // cache miss — discard the fold, refold reduce-only through ack (below).
    const reducedAheadOfAck = persisted.reduction.reducedThroughOffset > acknowledged;
    if (
      persisted.reduction.reducerVersion === this.hooks.contract.version &&
      parsed.success &&
      !reducedAheadOfAck
    ) {
      let reduction: ReductionProgress<ProcessorState<Contract>> = {
        ...persisted.reduction,
        state: parsed.state,
      };
      if (reduction.reducedThroughOffset < acknowledged) {
        // The fold cache validly LAGS the acknowledgement (a commit cadence
        // may persist them apart) — but publishing the lagging fold as-is
        // would reduce the NEXT delivery onto state missing the events in
        // (reducedThrough, acknowledged] and then stamp it as reduced through
        // the acknowledged offset: those events' contributions silently vanish. Catch the fold
        // up REDUCE-ONLY (their effects are acknowledged; processEvent never
        // re-runs) and persist the healed cache before publishing.
        reduction = await this.#rebuildReduction(streamId, acknowledged, {
          state: reduction.state,
          reducedThroughOffset: reduction.reducedThroughOffset,
        });
        const progress: ProcessorProgress<ProcessorState<Contract>> = {
          streamId,
          reduction,
          processing: persisted.processing,
        };
        await this.#commit(progress, {
          expectedCursorRevision: persisted.processing.cursorRevision,
          expectedStreamId: streamId,
        });
        this.#progress = progress;
        this.#hasLoaded = true;
        return;
      }
      this.#progress = { streamId, reduction, processing: persisted.processing };
      this.#hasLoaded = true;
      return;
    }

    // REDUCE-ONLY REFOLD: the reduction cache is stale (reducer version
    // changed, the persisted fold no longer fits the schema, or the fold ran
    // AHEAD of the acknowledgement — all the same cache miss). DISCARD the
    // fold, KEEP the processing acknowledgement — this is the entire point of
    // the two-cursor split: a routine state-schema deploy rebuilds the cache
    // by re-running `reduce` ONLY, never `processEvent`, never effects. The
    // rebuild stages into locals; nothing partial is observable (every read
    // awaits this load).
    console.warn(
      reducedAheadOfAck
        ? `stream processor "${this.hooks.contract.slug}" persisted reduction cursor ` +
            `(${persisted.reduction.reducedThroughOffset}) is AHEAD of the acknowledged cursor ` +
            `(${acknowledged}) — an invalid record; discarding the fold and refolding ` +
            `reduce-only through the acknowledgement`
        : `stream processor "${this.hooks.contract.slug}" reduction cache is stale ` +
            `(persisted reducerVersion "${persisted.reduction.reducerVersion}", ` +
            `current "${this.hooks.contract.version}", state ${parsed.success ? "valid" : "invalid"}); ` +
            `refolding reduce-only through acknowledged offset ` +
            `${acknowledged}`,
    );
    const reduction = await this.#rebuildReduction(streamId, acknowledged);
    const progress: ProcessorProgress<ProcessorState<Contract>> = {
      streamId,
      reduction,
      processing: persisted.processing,
    };
    await this.#commit(progress, {
      expectedCursorRevision: persisted.processing.cursorRevision,
      expectedStreamId: streamId,
    });
    this.#progress = progress;
    this.#hasLoaded = true;
  }

  /** Rebuild the fold through `throughOffset`, reduce ONLY, paged — from
   * offset 0 by default, or extending `from` (a valid persisted fold that
   * LAGS the target, so only the gap's events are read). */
  async #rebuildReduction(
    streamId: string,
    throughOffset: number,
    from?: { state: ProcessorState<Contract>; reducedThroughOffset: number },
  ): Promise<ReductionProgress<ProcessorState<Contract>>> {
    let state = from?.state ?? this.hooks.initialState();
    let afterOffset = from?.reducedThroughOffset ?? 0;
    if (throughOffset > afterOffset) {
      for (;;) {
        const page = await this.stream.getEventPage({
          afterOffset,
          beforeOffset: throughOffset + 1,
          limit: this.readPageSize,
        });
        this.#assertReadStreamId(page.streamId, streamId);
        if (page.events.length === 0) break;
        for (const event of page.events) {
          if (event.offset > throughOffset) continue;
          const reduction = this.hooks.reduceRawEvent({ event, state });
          // Parse failures were recorded when first processed (idempotent);
          // a refold silently folds past them, exactly like live delivery.
          if (reduction !== undefined && !("parseError" in reduction)) {
            state = reduction.state;
          }
        }
        afterOffset = page.events.at(-1)!.offset;
      }
    }
    return {
      reducerVersion: this.hooks.contract.version,
      reducedThroughOffset: throughOffset,
      state,
    };
  }

  async #commit(
    progress: ProcessorProgress<ProcessorState<Contract>>,
    opts: { expectedCursorRevision: number; expectedStreamId: string | undefined },
  ): Promise<void> {
    if (this.durability === undefined) return;
    await this.durability.progress.commit(progress, opts);
  }

  /**
   * Re-run `reduce` + `processEvent` from the acknowledged cursor by
   * reading the journal itself — catch-up cannot rely on a callback whose
   * starting offset was fixed when it opened. One page of lookahead means
   * every non-final batch carries a streamMaxOffset past its own last event (the
   * `caughtUp` flag appears only on the genuinely final page), matching the
   * host's catch-up.
   */
  async #selfCatchUp(): Promise<void> {
    const streamId = this.#requireProgress().streamId;
    let scannedAfterOffset = this.#requireProgress().processing.acknowledgedThroughOffset;
    for (;;) {
      const page = await this.stream.getEventPage({
        afterOffset: scannedAfterOffset,
        limit: this.readPageSize,
      });
      this.#assertReadStreamId(page.streamId, streamId);
      const isFinalPage = page.events.length < this.readPageSize;
      const scannedThroughOffset = isFinalPage ? page.streamMaxOffset : page.events.at(-1)!.offset;
      if (scannedThroughOffset <= scannedAfterOffset) return;
      await this.#processBatch({
        streamId,
        events: page.events,
        scannedAfterOffset,
        scannedThroughOffset,
        streamMaxOffset: page.streamMaxOffset,
      });
      scannedAfterOffset = scannedThroughOffset;
      if (isFinalPage) return;
    }
  }

  // ---------------------------------------------------------------------------
  // Small shared machinery.
  // ---------------------------------------------------------------------------

  async #readCurrentStreamId(expectedStreamId?: string): Promise<string> {
    // Identity-only read: the page envelope carries the lifetime and head, so
    // do not transfer the stream's first retained event on every processor read.
    const page = await this.stream.getEventPage({ afterOffset: Number.MAX_SAFE_INTEGER, limit: 1 });
    if (expectedStreamId !== undefined && page.streamId !== expectedStreamId) {
      throw new Error(
        `stream processor "${this.hooks.contract.slug}" was opened for stream ID ` +
          `${expectedStreamId}, but the stream at this path is ${page.streamId}`,
      );
    }
    return page.streamId;
  }

  #assertReadStreamId(actualStreamId: string, expectedStreamId: string): void {
    if (actualStreamId === expectedStreamId) return;
    throw new Error(
      `stream processor "${this.hooks.contract.slug}" stream ID changed during a read ` +
        `(${expectedStreamId} -> ${actualStreamId})`,
    );
  }

  /** Fire-and-forget async work backed by the keepalive, with failures logged. */
  #runInBackground(work: () => Promise<unknown>): void {
    this.#keepAliveBackedWork(work).catch((error: unknown) => {
      console.error("stream processor runner background work failed", error);
    });
  }

  /**
   * Route registered work through the recovery adapter's keepalive when
   * present (both `blockProcessorWhile` and `runInBackground` ride it — "the
   * DO died owing work" must equal "the alarm was armed"), else through the
   * plain `keepAlive` hook, else run directly.
   */
  async #keepAliveBackedWork(work: () => Promise<unknown>): Promise<unknown> {
    const keepAliveWhile = this.durability?.recovery?.keepAliveWhile ?? this.keepAlive;
    return await awaitKeepAliveBacked(keepAliveWhile, work);
  }

  /** Serialize batches + self-pulls; the chain swallows each entry's
   * failure so one failed batch never wedges the entries behind it. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(() => {
      this.#assertNotDisposed();
      return work();
    });
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error(
        `StreamProcessorRunner for "${this.hooks.contract.slug}" is disposed; it accepts no new work`,
      );
    }
  }

  #requireProgress(): ProcessorProgress<ProcessorState<Contract>> {
    if (this.#progress === undefined) {
      throw new Error("StreamProcessorRunner progress read before load — this is a runner bug");
    }
    return this.#progress;
  }

  // A throwing observer is ITS bug, never the batch's: the commit already
  // landed, so failures are logged and the loop continues (the legacy
  // #notifyStateChange, verbatim).
  #notifyStateChange(snapshot: { offset: number; state: ProcessorState<Contract> }): void {
    for (const observer of [...this.#stateChangeObservers]) {
      try {
        observer(snapshot);
      } catch (error) {
        console.error("stream processor runner state-change observer failed", error);
      }
    }
  }

  #registerEventWaiter(
    match:
      | { kind: "predicate"; predicate: (event: StreamEvent) => boolean }
      | { kind: "offset"; offset: number },
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): { promise: Promise<void>; reject: (error: unknown) => void } {
    let waiter!: EventWaiter;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = { ...match, reject, resolve, signal: opts.signal };
      this.#eventWaiters.add(waiter);
      if (opts.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.#settleEventWaiter(waiter, {
            error: new Error(`waitUntilEvent timed out after ${opts.timeoutMs}ms`),
          });
        }, opts.timeoutMs);
      }
      if (opts.signal !== undefined) {
        waiter.abortListener = () => {
          this.#settleEventWaiter(waiter, { error: abortReason(opts.signal!) });
        };
        opts.signal.addEventListener("abort", waiter.abortListener, { once: true });
        // The caller may abort between the public preflight check and listener
        // registration. Re-check after registration so that edge cannot halt.
        if (opts.signal.aborted) waiter.abortListener();
      }
    });
    return {
      promise,
      reject: (error: unknown) => this.#settleEventWaiter(waiter, { error }),
    };
  }

  #settleEventWaiter(
    waiter: EventWaiter,
    outcome: { error: unknown } | { value: undefined },
  ): void {
    if (!this.#eventWaiters.delete(waiter)) return;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    if ("error" in outcome) waiter.reject(outcome.error);
    else waiter.resolve();
  }

  // Settle waiters after the durable commit + published-cursor advance.
  // Predicate waits match actual delivered events; offset waits match the
  // acknowledged scan offset, so an empty/filtered interval cannot leave a
  // read-your-writes waiter halted below a cursor the runner already proved.
  #resolveEventWaiters(events: readonly StreamEvent[], acknowledgedThroughOffset: number): void {
    for (const waiter of this.#eventWaiters) {
      let matched = false;
      try {
        matched =
          waiter.kind === "offset"
            ? acknowledgedThroughOffset >= waiter.offset
            : events.some(waiter.predicate);
      } catch (error) {
        this.#settleEventWaiter(waiter, { error });
        continue;
      }
      if (matched) {
        this.#settleEventWaiter(waiter, { value: undefined });
      }
    }
  }
}

function assertProcessorEventBatch(batch: StreamProcessorEventBatch): void {
  const coordinates = [
    ["scannedAfterOffset", batch.scannedAfterOffset],
    ["scannedThroughOffset", batch.scannedThroughOffset],
    ["streamMaxOffset", batch.streamMaxOffset],
  ] as const;
  for (const [name, value] of coordinates) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`stream processor event batch ${name} must be a non-negative safe integer`);
    }
  }
  if (batch.scannedThroughOffset < batch.scannedAfterOffset) {
    throw new Error(
      `stream processor event batch scan regressed: ${batch.scannedAfterOffset} -> ${batch.scannedThroughOffset}`,
    );
  }
  if (batch.streamMaxOffset < batch.scannedThroughOffset) {
    throw new Error(
      `stream processor event batch scan ${batch.scannedThroughOffset} is ahead of stream maximum offset ${batch.streamMaxOffset}`,
    );
  }
  let previousOffset = batch.scannedAfterOffset;
  for (const event of batch.events) {
    if (!Number.isSafeInteger(event.offset) || event.offset <= previousOffset) {
      throw new Error(
        `stream processor event batch events must increase strictly after scan cursor ${previousOffset}; found ${event.offset}`,
      );
    }
    if (event.offset > batch.scannedThroughOffset) {
      throw new Error(
        `stream processor event batch event ${event.offset} is beyond scanned-through offset ${batch.scannedThroughOffset}`,
      );
    }
    previousOffset = event.offset;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("waitUntilEvent aborted");
}
