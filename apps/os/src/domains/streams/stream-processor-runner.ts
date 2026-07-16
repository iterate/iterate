// The stream-processor RUNNER: the delivery driver that owns everything a
// processor author should not — cursors, checkpoint cadence, retry, recovery —
// so the processor itself can stay pure-ish hooks (validate / reduce /
// processEvent — the at-head reconcile is processEvent under
// `delivery.caughtUp`, not a separate hook). Design:
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
// Delivery: `openDelivery()` answers the wake handshake — a resume cursor plus
// a `sink`. The sink IS the `processEventBatch` wire callback the transport
// invokes per delivered frame; transport batching stays entirely inside it.
// The runner reduces/processes ONE EVENT AT A TIME, so batch division is
// invisible to processor semantics (the harness pins this: one batch,
// singletons, or random partitions of the same journal must produce identical
// outcomes). `blockProcessorWhile` is therefore a strict per-event barrier,
// never a per-frame one.
//
// The load-bearing orderings in here are transplanted from the legacy
// `StreamProcessor.#ingest` (deleted with the host) — the most
// incident-scarred loop in the system — and each is marked at its new home:
//   - failed frame settles already-started blockers, cursor untouched
//   - persist BEFORE advancing the in-memory cursor
//   - malformed consumed events advance the cursor, diagnostics append AFTER
//     the commit, in the background
//
// This file is the Phase-1 `SubscriberRunner`. The Phase-2 `InlineRunner`
// (the Stream DO's own synchronous commit-path driver, where `validate` gates
// appends) shares the types below but is gated on a commit-path benchmark.

import type { z } from "zod";
import type { Stream } from "../../itx-api.generated.ts";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "./core-processor-contract.ts";
import type { ProcessorState } from "./processor-contracts.ts";
import type { StreamEvent } from "./schemas.ts";
import type { StreamEventBatch } from "./rpc-types.ts";
import {
  StreamProcessor,
  type MaybePromise,
  type StreamProcessorContract,
  type StreamProcessorDriver,
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
  reduction: ReductionProgress<State>;
  processing: ProcessingProgress;
};

/**
 * Durable progress store, CAS-fenced by `cursorRevision`. The runner reads
 * once at open, then commits once per delivered frame; `commit` rejects
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
    opts: { expectedCursorRevision: number },
  ): MaybePromise<void>;
};

/**
 * Optional recovery capability. Present only for durable processors that own
 * background obligations (`runInBackground` work whose OUTCOME matters): the
 * runner throws at construction if recovery is wired but the contract's
 * `consumes` omits the core `stream/processor-revived` event
 * ({@link STREAM_PROCESSOR_REVIVED_EVENT_TYPE}), because a revival fact
 * nobody consumes recovers nothing.
 *
 * - `keepAliveWhile` parks a durable alarm ahead of in-flight work, so an
 *   incarnation that dies owing work is revived by the alarm's fire. The
 *   production adapter is `(work) => keepalive.track(work())` over ONE
 *   ProcessorKeepalive (stream-processor-keepalive.ts) — the runner REUSES
 *   that machinery wholesale, it never reinvents mark/backoff/quiet-clean.
 * - `appendRevived` appends the core `stream/processor-revived` fact (the
 *   payload's `processorSlug` names the revived processor) — the journaled,
 *   CONSUMED evidence that guarantees at least one delivery turn (and, since
 *   the fact is at head when delivered, one `delivery.caughtUp` reconcile)
 *   even at zero lag. It is called by the adapter's own revival pass (the
 *   keepalive's `revive` hook), not by the runner core.
 * - `handleAlarm` services the durable timer (`ProcessorKeepalive.onAlarm`);
 *   the host DO multiplexes its single alarm across runners and routes fires
 *   to {@link StreamProcessorRunner.handleAlarm}, which delegates here.
 */
export type ProcessorRecovery = {
  keepAliveWhile(work: () => Promise<unknown>): void;
  appendRevived(): MaybePromise<void>;
  handleAlarm(info?: unknown): MaybePromise<void>;
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

/**
 * Where a delivery sits relative to the head the runner has OBSERVED:
 * `"catching-up"` while replaying history, `"live"` once deliveries reach the
 * observed head. A policy input, not a correctness gate — the honest framing
 * that replaces today's `checkpointOffset >= streamMaxOffset` at-head guard.
 */
export type DeliveryPhase = "catching-up" | "live";

/**
 * Honest event-time context handed to `processEvent`. Head and lag are POLICY
 * inputs (skip the stale typing indicator, debounce the status repaint), never
 * correctness — the observed head can be behind the real head the moment it
 * is read. Effect keys are minted via the processor's own
 * `idempotencyKey(key, whileProcessing?)`: bind the event for per-event
 * effects (a redelivered frame dedupes), or fold the deciding state into
 * `key` with no event bound for obligation-derived stable keys.
 */
export type DeliveryContext = {
  phase: DeliveryPhase;
  /** The highest stream offset the runner has observed (>= this event's). */
  observedHeadOffset: number;
  /** How far this event trails `observedHeadOffset`; 0 = at the observed head. */
  eventsBehindObservedHead: number;
  /**
   * `eventsBehindObservedHead === 0` — this event WAS the observed head when
   * delivered, so the fold through it is everything the runner has seen. This
   * is the at-head reconcile signal: a processor drives its undriven
   * obligations / settles dead ones under this flag (there is no separate
   * hook). It is TRUE for exactly the last consumed event of a batch that
   * reached head; a batch whose tail is a type this processor does not consume
   * simply defers the pass to the next consumed-at-head event (or the
   * `stream/processor-revived` fact recovery appends) — see the runner's
   * delivery loop.
   */
  caughtUp: boolean;
  /** The processing cursor's current fencing token (see {@link ProcessingProgress}). */
  cursorRevision: number;
};

/**
 * One transport scan as delivered to the runner. The scan coordinates are
 * first-class rather than inferred from `events`: a delivery may deliberately
 * omit ephemeral or selector-filtered rows, including an entirely empty
 * interval, while still proving that every raw offset in the interval was
 * examined. Advancing through that proof is what prevents filtered rows from
 * wedging a processor cursor below head.
 */
export type StreamProcessorDeliveryFrame = Pick<
  StreamEventBatch,
  "events" | "scannedAfterOffset" | "scannedThroughOffset" | "streamMaxOffset"
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

/** The in-flight fold/cursor context of one frame, committed at frame end. */
type FrameContext<State> = {
  /** The revision every commit in this frame asserts (fixed at frame start). */
  revision: number;
  /** When this frame's drive began — feeds the per-commit consumption metrics
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
 * The delivery driver for one processor on one stream. Runtime-neutral by
 * construction: the browser, the Durable Object registry, and the in-memory
 * test harness all instantiate exactly this class and differ only in the
 * `durability` / `keepAlive` adapters they pass. One runner per processor —
 * the "host" of old survives only as a thin registry that builds adapters and
 * routes wakes/alarms to the right runner.
 *
 * Serialization: frames and self-pulls share ONE in-memory chain, so a
 * catch-up never interleaves with a half-processed frame. Cross-incarnation
 * races (a stale runner outliving progress made elsewhere) are fenced durably
 * instead, by the progress store's `cursorRevision` CAS + monotonic fence.
 */
export class StreamProcessorRunner<
  Contract extends StreamProcessorContract,
  Deps extends object = object,
> {
  private readonly processor: StreamProcessor<Contract, Deps>;
  private readonly driver: StreamProcessorDriver<Contract>;
  private readonly stream: Stream;
  private readonly durability: ProcessorDurability<ProcessorState<Contract>> | undefined;
  private readonly keepAlive: ((work: () => Promise<unknown>) => void) | undefined;
  private readonly now: () => number;
  private readonly readPageSize: number;

  /** Memoized load; cleared on failure so the next call retries (legacy #loadState). */
  #loaded: Promise<void> | undefined;
  /** True once progress reflects a real load (fresh default over an empty
   * store counts; a pending/failed load does not) — the gate that keeps
   * default or partially-refolded state from ever escaping (the legacy
   * `isLoaded` invariant). `snapshot()` additionally
   * awaits the load, so partial state cannot escape through it either. */
  #hasLoaded = false;
  /** The COMMITTED progress — what snapshot()/openDelivery() publish. Frame
   * folds accumulate in locals and land here only after the durable commit. */
  #progress: ProcessorProgress<ProcessorState<Contract>> | undefined;
  /** Highest stream offset observed across all frames and successful
   * processor home-stream appends this incarnation. */
  #observedHeadOffset = 0;
  /** Serializes frames + self-pulls; failures are contained per entry. */
  #chain: Promise<void> = Promise.resolve();
  /** Highest already-committed offset an offset waiter has asked a self-pull
   * to cover. Concurrent waiters share one drain: enqueueing one journal read
   * per waiter builds a cross-request promise chain in a Durable Object and
   * can exhaust Cloudflare's subrequest-depth limit under fan-out. */
  #pendingOffsetSelfPull: number | undefined;
  /** The one active drain for {@link #pendingOffsetSelfPull}. */
  #offsetSelfPullDrain: Promise<void> | undefined;
  #disposed = false;
  readonly #eventWaiters = new Set<EventWaiter>();
  readonly #stateChangeObservers = new Set<
    (snapshot: { offset: number; state: ProcessorState<Contract> }) => void
  >();
  /** Memoized schema default, for pre-load `currentState` reads. */
  #defaultState: ProcessorState<Contract> | undefined;

  constructor(args: {
    /** The processor under drive — passed IN; the runner never constructs one. */
    processor: StreamProcessor<Contract, Deps>;
    /** The processor's home stream (replay reads, revival appends). */
    stream: Stream;
    /** Durable progress + optional recovery; omit for in-memory (tests, ephemeral views). */
    durability?: ProcessorDurability<ProcessorState<Contract>>;
    /** Incarnation keep-alive for in-flight async work (a DO's `waitUntil` lane). */
    keepAlive?: (work: () => Promise<unknown>) => void;
    /** Injected clock for the test harness; production uses Date.now. */
    now?: () => number;
    /** Journal read page size (refold/catch-up paging); tests shrink it. */
    readPageSize?: number;
  }) {
    this.processor = args.processor;
    this.driver = StreamProcessor.runnerDriver(args.processor);
    this.stream = args.stream;
    this.durability = args.durability;
    this.keepAlive = args.keepAlive;
    this.now = args.now ?? (() => Date.now());
    this.readPageSize = args.readPageSize ?? 500;

    if (this.durability?.recovery !== undefined) {
      // A revival fact nobody consumes recovers nothing: recovery's whole
      // mechanism is "append the core `stream/processor-revived` fact, let
      // the ordinary delivery turn run the processor's own reconciliation
      // handlers". Exact identity, not shape: consuming some namespaced
      // `<ns>/revived` event recovers nothing — the ONE core fact the
      // recovery adapter appends must be consumed.
      const consumes = this.driver.contract.consumes;
      const consumesRevived =
        consumes.includes("*") || consumes.includes(STREAM_PROCESSOR_REVIVED_EVENT_TYPE);
      if (!consumesRevived) {
        throw new Error(
          `stream processor "${this.driver.contract.slug}" wires recovery but the contract does ` +
            `not consume the revival fact "${STREAM_PROCESSOR_REVIVED_EVENT_TYPE}" — a revival ` +
            `fact nobody consumes recovers nothing. Add that exact event type to the contract's consumes.`,
        );
      }
    }
  }

  /**
   * The subscriber half of the wake handshake: answers the resume cursor plus
   * the live `sink` the stream retains and invokes per delivered frame.
   *
   * `checkpointOffset` is the PROCESSING cursor (`acknowledgedThroughOffset`),
   * never the reduction offset: the stream persists this handshake value as
   * its delivery watermark, and resuming from a reduction-pinned snapshot
   * offset could skip events whose effects were never acknowledged.
   *
   * The sink is the internal `processEventBatch` wire callback — the ONLY
   * place transport batching exists; inside it the runner reduces and
   * processes one event at a time.
   */
  async openDelivery(): Promise<{
    checkpointOffset: number;
    sink: (batch: StreamProcessorDeliveryFrame) => Promise<void>;
  }> {
    this.#assertNotDisposed();
    await this.#load();
    return {
      checkpointOffset: this.#requireProgress().processing.acknowledgedThroughOffset,
      sink: (batch: StreamProcessorDeliveryFrame) => {
        const attempt = this.#enqueue(() => this.#processFrame(batch));
        // Zero-lag recovery must cover the WHOLE frame attempt, not merely
        // the work registered inside it (the June-10/July-7 incident class):
        // an eviction mid-frame on a stream that also died still gets this
        // processor revived by the keepalive alarm parked ahead of `attempt`.
        // A failed attempt reads as failure to the keepalive (routing the
        // next fire to revival); the transport observes the same rejection
        // through the returned promise and owns the redelivery.
        this.durability?.recovery?.keepAliveWhile(() => attempt);
        // The production wake lane is consumes-FILTERED but stamped with the
        // RAW stream head, so a successful
        // frame can leave the acknowledged cursor behind `streamMaxOffset`
        // with an unconsumed DURABLE tail nothing else will ever deliver —
        // the cursor parks below head, the last consumed event's
        // `delivery.caughtUp` never becomes true, and the obligation the frame
        // opened wedges. Every behind frame therefore gets a trailing
        // type-UNFILTERED self-pull that folds the tail up to head (its final
        // page reports its own tail as the head, so the last consumed event is
        // delivered at head and its reconcile fires). It rides the runner's chain — serialized
        // with frames, reading the freshest cursor — and the keepalive lane,
        // NOT the promise returned to the transport: a failed trailing pull
        // reads as FAILURE to the keepalive, blocking the quiet-clean disarm
        // and routing the next alarm fire to revival, whose unfiltered
        // catch-up is this pull's retry. A failed main attempt takes the
        // transport's redelivery lane instead; no trailing pull follows it.
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
        return attempt;
      },
    };
  }

  /** Service a durable alarm fire routed here by the hosting registry (recovery lane). */
  async handleAlarm(info?: unknown): Promise<void> {
    const recovery = this.durability?.recovery;
    if (recovery === undefined) return;
    await recovery.handleAlarm(info);
  }

  /** One consistent read of the fold, pinned to `reducedThroughOffset`. */
  async snapshot(): Promise<{ offset: number; state: ProcessorState<Contract> }> {
    await this.#load();
    const progress = this.#requireProgress();
    return {
      offset: progress.reduction.reducedThroughOffset,
      state: progress.reduction.state,
    };
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
   * real facts for subscribers.
   */
  get currentState(): ProcessorState<Contract> {
    if (this.#progress !== undefined) return this.#progress.reduction.state;
    this.#defaultState ??= this.driver.initialState();
    return this.#defaultState;
  }

  /**
   * Observe committed reduced-state changes IN-PROCESS: the observer is a
   * local function (the hosting registry wires it to reassemble its
   * live-state engine), never a retained RPC stub. It fires after a frame
   * commit lands durably AND the committed state changed identity — the
   * runner's home for the legacy `StreamProcessor.observeStateChanges` +
   * post-persist notify. Returns an unsubscribe.
   */
  observeStateChanges(
    observer: (snapshot: { offset: number; state: ProcessorState<Contract> }) => void,
  ): () => void {
    this.#stateChangeObservers.add(observer);
    return () => void this.#stateChangeObservers.delete(observer);
  }

  /**
   * Pull-page the journal from the ACKNOWLEDGED cursor and drive ordinary
   * frames until caught up — the public door for read-your-writes pulls and a
   * hosting registry's cold-load healing (the legacy host's `catchUpInternal`
   * shape). One page of lookahead, so every non-final frame carries a
   * `streamMaxOffset` past its own tail and only the genuinely final page is
   * at-head. Serialized with delivered frames on the runner's chain; failures
   * RETHROW — the caller owns any swallow-and-log policy.
   */
  catchUp(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#load();
      await this.#selfCatchUp();
    });
  }

  /**
   * Resolve once the ACKNOWLEDGED cursor reaches `offset` — the single
   * wait-for-progress door (read-your-writes: append, then wait on the offset
   * the append returned). The offset form never depends on push delivery to
   * reach an event that ALREADY EXISTS on the stream: when the cursor is
   * behind, it kicks a chain-serialized self-pull ({@link catchUp}) that
   * drives the journal tail itself; the parked waiter covers only a genuinely
   * FUTURE offset the pull cannot reach yet. The predicate form observes
   * FUTURE deliveries only — an event not yet appended (e.g. runScript's
   * completion, appended later by `runInBackground` work; that work runs OFF
   * the runner chain and outside the awaiting handler, so the parked waiter
   * never gates the append or the delivery that resolves it) — and resolves
   * after the frame that delivered the matching event has durably committed,
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
      await this.#load();
      if (this.#requireProgress().processing.acknowledgedThroughOffset >= args.offset) return;
      const { offset, signal, timeoutMs } = args;
      // No await between the check above and registering the waiter below
      // (the helper below registers synchronously), so a frame cannot
      // advance the cursor past `offset` in the gap and be missed.
      const reached = this.#parkEventWaiter({ kind: "offset", offset }, { signal, timeoutMs });
      // Self-pull, not park-and-hope: this form's contract is read-your-writes
      // over an append that already committed, and a parked waiter alone would
      // hold the wait hostage to the push lane's health (a wedged
      // subscription, a lost wake dial — the orphaned-announcement incident
      // class). Concurrent offset waiters coalesce into one target-aware drain
      // rather than enqueueing one redundant journal pull per RPC. The drain
      // rides the runner chain, serialized with delivered frames — no
      // double-drive against a concurrent live frame, because redelivered
      // offsets dedupe against the acknowledged cursor — and resolves waiters
      // through the ordinary frame commit. A genuinely future offset stays
      // parked for delivery. Pull failures are logged, not rethrown: waiters
      // stay valid (a later frame still resolves them) and `timeoutMs` stays
      // the caller's bound.
      this.#scheduleOffsetSelfPull(offset);
      return await reached;
    }
    const { predicate, signal, timeoutMs } = args;
    await this.#parkEventWaiter({ kind: "predicate", predicate }, { signal, timeoutMs });
  }

  /**
   * Start consequential work outside a delivery hook on this runner's own
   * keepalive/recovery lane. The caller must still represent the desired
   * outcome durably and reconcile it after eviction; this method supplies the
   * same bounded recovery plumbing as `processEvent`'s `runInBackground`.
   *
   * This is intentionally a narrow escape hatch for synchronous domain verbs
   * that first journal an obligation and then want to drive that exact
   * committed obligation without waiting for an unrelated future consumed
   * event to provide another at-head pulse.
   */
  runInBackground(work: () => Promise<unknown>): void {
    this.#runInBackground(work);
  }

  /** Release delivery resources. Idempotent; a disposed runner rejects new work. */
  dispose(): void {
    this.#disposed = true;
    this.#pendingOffsetSelfPull = undefined;
    for (const waiter of this.#eventWaiters) {
      this.#settleEventWaiter(waiter, { error: new Error("StreamProcessorRunner disposed") });
    }
    this.#stateChangeObservers.clear();
  }

  // ---------------------------------------------------------------------------
  // The per-event loop.
  // ---------------------------------------------------------------------------

  async #processFrame(frame: StreamProcessorDeliveryFrame): Promise<void> {
    const ingestStartedAtMs = this.now();
    assertDeliveryFrame(frame);
    await this.#load();
    const committed = this.#requireProgress();
    const committedThroughOffset = committed.processing.acknowledgedThroughOffset;
    if (frame.scannedAfterOffset > committedThroughOffset) {
      throw new Error(
        `delivery frame starts after the committed scan cursor: ${frame.scannedAfterOffset} > ${committedThroughOffset}`,
      );
    }
    const frameScannedThroughOffset = Math.max(committedThroughOffset, frame.scannedThroughOffset);

    // Offset-dedupe against the acknowledged cursor (and within the frame):
    // redelivered events are silent skips, exactly like legacy ingest.
    const pending: StreamEvent[] = [];
    let scan = committedThroughOffset;
    for (const event of frame.events) {
      if (event.offset <= scan) continue;
      scan = event.offset;
      pending.push(event);
    }

    // observedHead = max(transport head, scan tail, processor home appends),
    // monotonic across frames. Transport frames carry a head SNAPSHOT from
    // when the stream produced them; one can sit queued while the preceding
    // frame's at-head reconcile appends its terminal fact. Without importing
    // the append's returned offset here, that queued frame can falsely claim
    // caughtUp over the pre-terminal fold and repeat the external obligation
    // (the fresh-project config-repo double-seed incident). The processor
    // records every successful home append, including protected append()
    // calls outside a delivery hook; sibling appends do not affect this head.
    this.#observedHeadOffset = Math.max(
      this.#observedHeadOffset,
      frame.streamMaxOffset,
      frameScannedThroughOffset,
      this.driver.highestCommittedHomeAppendOffset(),
    );
    if (pending.length === 0 && frameScannedThroughOffset === committedThroughOffset) return;
    const observedHeadOffset = this.#observedHeadOffset;
    // What this frame will acknowledge through once its blocking work
    // completes — the legacy `checkpointOffset` semantics, kept verbatim for
    // the existing `processEvent` signature.
    const frameCheckpointOffset = frameScannedThroughOffset;

    // AT-HEAD is a BATCH property, not a per-event-offset one. If this batch
    // folds through the observed head (its tail is at head — no filtered
    // durable events beyond it), then by the end of it the processor has seen
    // EVERYTHING the stream has, so its LAST consumed event is delivered with
    // `caughtUp: true` even though that event's own offset may sit far below
    // head (a batch of 100 where only the first is consumed still leaves the
    // processor at head). `caughtUp` is the at-head reconcile signal — see
    // DeliveryContext.
    const batchReachesHead = frameScannedThroughOffset >= observedHeadOffset;
    // The offset of the LAST event this batch will actually deliver to
    // `processEvent` — a consumed type that PARSES. `isDeliverable` folds in
    // the wildcard (`"*"` consumes every type) AND excludes malformed consumed
    // events: without the parse check a malformed event at head would be
    // selected as "last consumed", steal the `caughtUp` flag from the real
    // last-good event (which never gets it), and strand its obligation.
    let lastDeliveredOffset: number | null = null;
    for (const event of pending) {
      if (this.driver.isDeliverable(event)) lastDeliveredOffset = event.offset;
    }

    const ctx: FrameContext<ProcessorState<Contract>> = {
      revision: committed.processing.cursorRevision,
      ingestStartedAtMs,
      state: committed.reduction.state,
      reducedThroughOffset: committed.reduction.reducedThroughOffset,
      completedThroughOffset: committed.processing.acknowledgedThroughOffset,
      eventsSinceCommit: 0,
      uncommittedEvents: [],
      uncommittedParseFailures: [],
    };
    /** Every blocker started anywhere in this frame, for failure settlement. */
    const startedBlockers: Promise<unknown>[] = [];

    try {
      for (const event of pending) {
        const reduction = this.driver.reduceRawEvent({ event, state: ctx.state });
        if (reduction !== undefined && "parseError" in reduction) {
          // A malformed consumed event is a fact of the log, not an
          // exception: collect it, keep advancing (the cursor must never
          // wedge on it), and record it AFTER its commit lands (below).
          ctx.uncommittedParseFailures.push({ event, error: reduction.parseError });
        } else if (reduction !== undefined) {
          // `caughtUp` on the LAST delivered event of a batch that reached head
          // (not `offset >= head` — that never fires for a subset-consuming
          // processor whose head is a later unconsumed event).
          const caughtUp = batchReachesHead && event.offset === lastDeliveredOffset;
          const delivery: DeliveryContext = {
            phase: event.offset >= observedHeadOffset ? "live" : "catching-up",
            observedHeadOffset,
            eventsBehindObservedHead: Math.max(0, observedHeadOffset - event.offset),
            caughtUp,
            cursorRevision: ctx.revision,
          };
          const eventBlockers: Promise<unknown>[] = [];
          // At-head reconcile work is DEFERRED (thunks, not started) and run
          // only AFTER the per-event blockers complete, so its appends land in
          // the journal AFTER this event's own per-event appends. That
          // ordering is load-bearing: e.g. an interrupt's scheduled-phase
          // cancel (a per-event append) must precede the reconcile's
          // lost-debounce re-fire (`llm-request-requested`), or the re-fire
          // wins the fold and the cancel no-ops. It restores the ordering the
          // old separate `onCaughtUp` pass had (reconcile after per-event work).
          const atHeadWork: (() => Promise<unknown>)[] = [];
          const whileProcessing = reduction.event;
          this.driver.processEvent({
            event: reduction.event,
            previousState: reduction.previousState,
            state: reduction.state,
            streamMaxOffset: observedHeadOffset,
            checkpointOffset: frameCheckpointOffset,
            delivery,
            blockProcessorWhile: (work) => {
              const attempt = this.#keepAliveBackedWork(work);
              eventBlockers.push(attempt);
              startedBlockers.push(attempt);
            },
            blockProcessorWhileCaughtUp: (work) => {
              atHeadWork.push(work);
            },
            runInBackground: (work) => this.#runInBackground(work),
            append: (...input) => this.driver.append({ whileProcessing }, input),
            appendTo: (path, ...input) => this.driver.appendTo(path, { whileProcessing }, input),
          });
          // STRICT PER-EVENT ORDERING: THIS event's blocking work completes
          // before the next event's processEvent starts. Background work was
          // registered (keepalive-backed) and deliberately NOT awaited — it
          // may overtake later events.
          await Promise.all(eventBlockers);
          // Then the at-head reconcile, AFTER per-event appends have landed.
          for (const work of atHeadWork) {
            const attempt = this.#keepAliveBackedWork(work);
            startedBlockers.push(attempt);
            await attempt;
          }
          ctx.state = reduction.state;
        }
        // Non-consumed and malformed events advance both cursors too —
        // mirroring what a filtered delivery's cursor does today.
        ctx.reducedThroughOffset = event.offset;
        ctx.completedThroughOffset = event.offset;
        ctx.eventsSinceCommit += 1;
        ctx.uncommittedEvents.push(event);
      }
      // The at-head reconcile rides `processEvent` for the LAST CONSUMED event
      // of a head-reaching batch (`delivery.caughtUp`). A head-reaching batch
      // that consumed NOTHING (a self-pull that folded only an unconsumed
      // durable tail) carries no such event, so it does NOT reconcile this
      // pass: the obligation defers to the next consumed-at-head event, or the
      // consumed `stream/processor-revived` fact recovery appends. Reconcile
      // never fires without a real consumed event at head.
      // The frame's scan proof covers omitted rows too. They are deliberate
      // no-ops for this processor, but both cursors must advance across them
      // atomically with the durable events above — including an empty scan.
      ctx.reducedThroughOffset = frameScannedThroughOffset;
      ctx.completedThroughOffset = frameScannedThroughOffset;
    } catch (error) {
      // A failed frame must still settle work it already registered so
      // nothing rejects unobserved. Whatever was not yet durably committed is
      // not committed now — the frame stays retryable and the transport
      // replays it from the last acknowledged cursor.
      // (The legacy #ingest's failure settlement, verbatim.)
      await Promise.allSettled(startedBlockers);
      throw error;
    }

    // FIXED CADENCE: one durable commit per delivered frame, after EVERY
    // event's blocking work — the at-head reconcile's included — has settled
    // (the legacy batch checkpoint window exactly). The gap between the
    // in-memory cursor and the last persisted acknowledgement is the
    // deliberate at-least-once replay window (appends stay
    // idempotency-keyed). Committing only at frame end is also what keeps a
    // failed at-head reconcile retryable: a mid-frame commit of the head
    // event would strand its at-head pass with the cursor already at head
    // and redelivery empty.
    if (ctx.eventsSinceCommit > 0 || frameScannedThroughOffset > committedThroughOffset) {
      await this.#commitFrameContext(ctx);
    }
  }

  /**
   * Persist the frame context, THEN advance the published cursor, resolve
   * waiters, and flush parse-failure diagnostics for the covered events.
   *
   * Persist-before-advance is load-bearing (the legacy #ingest's ordering):
   * if the durable write fails, the frame must stay retryable — the redelivered
   * frame re-reduces from the OLD published state and retries the write.
   * Advancing in-memory first would make the retry a silent no-op (every
   * event filtered out, nothing re-saved), losing the frame durably.
   */
  async #commitFrameContext(ctx: FrameContext<ProcessorState<Contract>>): Promise<void> {
    const next: ProcessorProgress<ProcessorState<Contract>> = {
      reduction: {
        reducerVersion: this.driver.contract.version,
        reducedThroughOffset: ctx.reducedThroughOffset,
        state: ctx.state,
      },
      processing: {
        acknowledgedThroughOffset: ctx.completedThroughOffset,
        cursorRevision: ctx.revision,
      },
    };
    const previousCommittedState = this.#progress?.reduction.state;
    await this.#commit(next, ctx.revision);
    this.#progress = next;
    ctx.eventsSinceCommit = 0;
    const committedEvents = ctx.uncommittedEvents.splice(0);
    const committedFailures = ctx.uncommittedParseFailures.splice(0);
    // The commit is durable and the published cursor advanced — the events
    // are genuinely CONSUMED, which is the moment self-measured subscriber
    // metrics report (the legacy #ingest's noteBatchIngested placement).
    // Fed through the driver so the wake
    // capability's consumption-lag samples stay live under runner drive.
    if (committedEvents.length > 0) {
      const newestEventCreatedAtMs = Date.parse(committedEvents.at(-1)!.createdAt);
      this.driver.noteBatchIngested({
        ingestedThroughOffset: next.processing.acknowledgedThroughOffset,
        ...(Number.isFinite(newestEventCreatedAtMs) ? { newestEventCreatedAtMs } : {}),
        eventCount: committedEvents.length,
        ingestStartedAtMs: ctx.ingestStartedAtMs,
        atMs: this.now(),
      });
    }
    // Observers before waiters, both after the durable commit — the legacy
    // ingest ordering: by the time either
    // fires, published state already reflects the committed frame.
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
    // never re-poison the frame it just rescued.
    // (The legacy #ingest's parse-failure lane, verbatim.)
    for (const { event, error } of committedFailures) {
      const message =
        `stream processor "${this.driver.contract.slug}" skipped event at offset ` +
        `${event.offset} ("${event.type}"): it fails the contract's schema`;
      console.error(message, error);
      // Raw `stream.append`, not the emitted lane: `stream/error-occurred` is
      // core-owned and deliberately absent from subclass `emits` — this is
      // the runtime speaking, not the processor author. Full provenance stamp
      // (which processor skipped which event) preserved.
      this.#runInBackground(() =>
        this.stream.append({
          type: "events.iterate.com/stream/error-occurred",
          idempotencyKey: this.driver.idempotencyKey("event-parse-failed", event),
          source: { processor: this.driver.processorStamp(event) },
          payload: {
            message,
            error: { name: error.name, message: error.message },
          },
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Progress load / refold / commit.
  // ---------------------------------------------------------------------------

  #load(): Promise<void> {
    this.#loaded ??= this.#loadOnce().catch((error: unknown) => {
      // Clear the memoized load so a later call retries instead of replaying
      // this rejection forever.
      this.#loaded = undefined;
      throw error;
    });
    return this.#loaded;
  }

  async #loadOnce(): Promise<void> {
    const persisted = await this.durability?.progress.read();
    if (persisted === undefined) {
      // Fresh processor: nothing observed yet, so the schema default IS the
      // fold of the (empty) acknowledged prefix.
      this.#progress = {
        reduction: {
          reducerVersion: this.driver.contract.version,
          reducedThroughOffset: 0,
          state: this.driver.initialState(),
        },
        processing: { acknowledgedThroughOffset: 0, cursorRevision: 0 },
      };
      this.#hasLoaded = true;
      return;
    }

    const acknowledged = persisted.processing.acknowledgedThroughOffset;
    const parsed = this.driver.parseState(persisted.reduction.state);
    // A persisted reduction AHEAD of the acknowledgement violates the record
    // invariant (see ProcessorProgress): publishing it would show state
    // derived from events whose effects are not acknowledged. Treat it as a
    // cache miss — discard the fold, refold reduce-only through ack (below).
    const reducedAheadOfAck = persisted.reduction.reducedThroughOffset > acknowledged;
    if (
      persisted.reduction.reducerVersion === this.driver.contract.version &&
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
        // head: those events' contributions silently vanish. Catch the fold
        // up REDUCE-ONLY (their effects are acknowledged; processEvent never
        // re-runs) and persist the healed cache before publishing.
        reduction = await this.#rebuildReduction(acknowledged, {
          state: reduction.state,
          reducedThroughOffset: reduction.reducedThroughOffset,
        });
        const progress: ProcessorProgress<ProcessorState<Contract>> = {
          reduction,
          processing: persisted.processing,
        };
        await this.#commit(progress, persisted.processing.cursorRevision);
        this.#progress = progress;
        this.#hasLoaded = true;
        return;
      }
      this.#progress = { reduction, processing: persisted.processing };
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
        ? `stream processor "${this.driver.contract.slug}" persisted reduction cursor ` +
            `(${persisted.reduction.reducedThroughOffset}) is AHEAD of the acknowledged cursor ` +
            `(${acknowledged}) — an invalid record; discarding the fold and refolding ` +
            `reduce-only through the acknowledgement`
        : `stream processor "${this.driver.contract.slug}" reduction cache is stale ` +
            `(persisted reducerVersion "${persisted.reduction.reducerVersion}", ` +
            `current "${this.driver.contract.version}", state ${parsed.success ? "valid" : "invalid"}); ` +
            `refolding reduce-only through acknowledged offset ` +
            `${acknowledged}`,
    );
    const reduction = await this.#rebuildReduction(acknowledged);
    const progress: ProcessorProgress<ProcessorState<Contract>> = {
      reduction,
      processing: persisted.processing,
    };
    await this.#commit(progress, persisted.processing.cursorRevision);
    this.#progress = progress;
    this.#hasLoaded = true;
  }

  /** Rebuild the fold through `throughOffset`, reduce ONLY, paged — from
   * offset 0 by default, or extending `from` (a valid persisted fold that
   * LAGS the target, so only the gap's events are read). */
  async #rebuildReduction(
    throughOffset: number,
    from?: { state: ProcessorState<Contract>; reducedThroughOffset: number },
  ): Promise<ReductionProgress<ProcessorState<Contract>>> {
    let state = from?.state ?? this.driver.initialState();
    const afterOffset = from?.reducedThroughOffset ?? 0;
    if (throughOffset > afterOffset) {
      using pager = this.stream.readEvents({
        afterOffset,
        beforeOffset: throughOffset + 1,
        limit: this.readPageSize,
      });
      let page = await pager.next();
      while (page.length > 0) {
        for (const event of page) {
          if (event.offset > throughOffset) continue;
          const reduction = this.driver.reduceRawEvent({ event, state });
          // Parse failures were recorded when first processed (idempotent);
          // a refold silently folds past them, exactly like live delivery.
          if (reduction !== undefined && !("parseError" in reduction)) {
            state = reduction.state;
          }
        }
        page = await pager.next();
      }
    }
    return {
      reducerVersion: this.driver.contract.version,
      reducedThroughOffset: throughOffset,
      state,
    };
  }

  async #commit(
    progress: ProcessorProgress<ProcessorState<Contract>>,
    expectedCursorRevision: number,
  ): Promise<void> {
    if (this.durability === undefined) return;
    await this.durability.progress.commit(progress, { expectedCursorRevision });
  }

  /**
   * Re-run `reduce` + `processEvent` from the acknowledged cursor by
   * self-pulling the journal — a catch-up cannot rely on the transport
   * pump, whose cursor was fixed at wake handshake. One page of lookahead so
   * every non-final frame carries a streamMaxOffset PAST its own tail (the
   * at-head pulse fires only on the genuinely final page), mirroring the
   * host's catch-up.
   */
  async #selfCatchUp(): Promise<void> {
    let scannedAfterOffset = this.#requireProgress().processing.acknowledgedThroughOffset;
    using pager = this.stream.readEvents({
      afterOffset: scannedAfterOffset,
      limit: this.readPageSize,
    });
    let events = await pager.next();
    while (events.length > 0) {
      const lookahead = await pager.next();
      const scannedThroughOffset = events.at(-1)!.offset;
      await this.#processFrame({
        events,
        scannedAfterOffset,
        scannedThroughOffset,
        streamMaxOffset: (lookahead.at(-1) ?? events.at(-1))!.offset,
      });
      scannedAfterOffset = scannedThroughOffset;
      events = lookahead;
    }
  }

  // ---------------------------------------------------------------------------
  // Small shared machinery.
  // ---------------------------------------------------------------------------

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
   * plain `keepAlive` hook, else run directly. Same fire-and-forget→promise
   * bridge as the legacy `#runKeepAliveBackedWork`.
   */
  async #keepAliveBackedWork(work: () => Promise<unknown>): Promise<unknown> {
    const keepAliveWhile = this.durability?.recovery?.keepAliveWhile ?? this.keepAlive;
    if (keepAliveWhile === undefined) return await work();
    return await new Promise<unknown>((resolve, reject) => {
      keepAliveWhile(async () => {
        try {
          const result = await work();
          resolve(result);
          return result;
        } catch (error) {
          reject(error);
          throw error;
        }
      });
    });
  }

  /** Serialize frames + self-pulls; the chain swallows each entry's
   * failure so one failed frame never wedges the entries behind it. */
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

  /**
   * Coalesce offset-pinned read-your-writes pulls through the highest target.
   *
   * A target that arrives while the active pass is reading becomes one
   * trailing pass only when the first pass did not already cover it. This is
   * target-aware rather than a plain single-flight: sharing a pull that began
   * before a later append could otherwise leave that later waiter parked even
   * though its event already exists. A failed pass is not retried in a loop;
   * push delivery / durable recovery remains the retry lane, and the original
   * waiter's timeout (when supplied) remains its explicit bound.
   */
  #scheduleOffsetSelfPull(offset: number): void {
    this.#pendingOffsetSelfPull = Math.max(this.#pendingOffsetSelfPull ?? 0, offset);
    if (this.#offsetSelfPullDrain !== undefined) return;

    const drain = this.#drainOffsetSelfPull();
    this.#offsetSelfPullDrain = drain;
    void drain.finally(() => {
      if (this.#offsetSelfPullDrain !== drain) return;
      this.#offsetSelfPullDrain = undefined;
      // A target can arrive after the drain's final loop check but before this
      // finalizer runs. Start a fresh drain so that narrow race cannot strand
      // an already-committed offset.
      if (!this.#disposed && this.#pendingOffsetSelfPull !== undefined) {
        this.#scheduleOffsetSelfPull(this.#pendingOffsetSelfPull);
      }
    });
  }

  async #drainOffsetSelfPull(): Promise<void> {
    while (this.#pendingOffsetSelfPull !== undefined) {
      const target = this.#pendingOffsetSelfPull;
      this.#pendingOffsetSelfPull = undefined;
      if (this.#requireProgress().processing.acknowledgedThroughOffset >= target) continue;

      try {
        await this.catchUp();
      } catch (error) {
        const highestTarget = Math.max(target, this.#pendingOffsetSelfPull ?? target);
        // Do not immediately re-enter the same failed Cloudflare request
        // lineage. The waiter remains registered for push delivery/recovery,
        // exactly as it did before pulls were coalesced.
        this.#pendingOffsetSelfPull = undefined;
        if (!this.#disposed) {
          console.error(
            `stream processor "${this.driver.contract.slug}" waitUntilEvent(offset <= ` +
              `${highestTarget}) self-pull failed; waiters stay parked for delivery`,
            error,
          );
        }
        return;
      }
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error(
        `StreamProcessorRunner for "${this.driver.contract.slug}" is disposed; it accepts no new work`,
      );
    }
  }

  #requireProgress(): ProcessorProgress<ProcessorState<Contract>> {
    if (this.#progress === undefined) {
      throw new Error("StreamProcessorRunner progress read before load — this is a runner bug");
    }
    return this.#progress;
  }

  // A throwing observer is ITS bug, never the frame's: the commit already
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

  #parkEventWaiter(
    match:
      | { kind: "predicate"; predicate: (event: StreamEvent) => boolean }
      | { kind: "offset"; offset: number },
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: EventWaiter = { ...match, reject, resolve, signal: opts.signal };
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
        // registration. Re-check after registration so that edge cannot park.
        if (opts.signal.aborted) waiter.abortListener();
      }
    });
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
  // acknowledged SCAN watermark, so an empty/filtered interval cannot leave a
  // read-your-writes waiter parked below a cursor the runner already proved.
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

function assertDeliveryFrame(frame: StreamProcessorDeliveryFrame): void {
  const coordinates = [
    ["scannedAfterOffset", frame.scannedAfterOffset],
    ["scannedThroughOffset", frame.scannedThroughOffset],
    ["streamMaxOffset", frame.streamMaxOffset],
  ] as const;
  for (const [name, value] of coordinates) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`stream processor delivery ${name} must be a non-negative safe integer`);
    }
  }
  if (frame.scannedThroughOffset < frame.scannedAfterOffset) {
    throw new Error(
      `stream processor delivery scan regressed: ${frame.scannedAfterOffset} -> ${frame.scannedThroughOffset}`,
    );
  }
  if (frame.streamMaxOffset < frame.scannedThroughOffset) {
    throw new Error(
      `stream processor delivery scan ${frame.scannedThroughOffset} is ahead of stream head ${frame.streamMaxOffset}`,
    );
  }
  let previousOffset = frame.scannedAfterOffset;
  for (const event of frame.events) {
    if (!Number.isSafeInteger(event.offset) || event.offset <= previousOffset) {
      throw new Error(
        `stream processor delivery events must increase strictly after scan cursor ${previousOffset}; found ${event.offset}`,
      );
    }
    if (event.offset > frame.scannedThroughOffset) {
      throw new Error(
        `stream processor delivery event ${event.offset} is beyond scanned-through offset ${frame.scannedThroughOffset}`,
      );
    }
    previousOffset = event.offset;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("waitUntilEvent aborted");
}
