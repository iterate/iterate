// The stream-processor RUNNER: the delivery driver that owns everything a
// processor author should not — cursors, checkpoint cadence, retry, recovery —
// so the processor itself can stay three pure-ish hooks (validate / reduce /
// processEvent, plus the optional at-head onCaughtUp). Design:
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
import type { ProcessorState } from "./processor-contracts.ts";
import type { StreamEvent } from "./schemas.ts";
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
 * `reReduce`, which re-runs `reduce` ONLY. That is the whole point of splitting
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
 * discarded — rewinding it re-runs side effects, which only an explicit,
 * audited operator `reprocessFrom` may do. `cursorRevision` is the CAS fence
 * for exactly those rewinds: every commit asserts it, and a bump makes every
 * in-flight continuation of the old cursor position stale (it also feeds
 * {@link DeliveryContext.idempotencyKey}, so an operator redrive genuinely
 * re-emits where a crash retry dedupes).
 */
export type ProcessingProgress = {
  /** Every effect at or below this offset is acknowledged (durably settled). */
  acknowledgedThroughOffset: number;
  /** Monotonic fencing token; bumped by cursor rewinds (`reprocessFrom`/`skipThrough`). */
  cursorRevision: number;
};

/**
 * A processor's two durable positions, persisted as one record. Invariant
 * (when persisted): `reduction.reducedThroughOffset <=
 * processing.acknowledgedThroughOffset` — the fold cache may lag the effect
 * cursor (it is rebuildable), but a fold AHEAD of acknowledged effects would
 * let `snapshot()` show state derived from events whose effects an operator
 * rewind is about to re-run. Core (Phase 2) is the graceful degradation:
 * reduction only, no processing cursor — same structure, same `reReduce`.
 */
export type ProcessorProgress<State> = {
  reduction: ReductionProgress<State>;
  processing: ProcessingProgress;
};

/**
 * Durable progress store, CAS-fenced by `cursorRevision`. The runner reads
 * once at open, then commits per its cadence policy; `commit` rejects
 * (throws) if `expectedCursorRevision` no longer matches the persisted
 * revision — the fence that stops a stale incarnation (or a continuation
 * outliving an operator `reprocessFrom`) from clobbering the rewound cursor.
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
 * `consumes` omits the processor-scoped `<namespace>/revived` event, because a
 * revival fact nobody consumes recovers nothing.
 *
 * - `keepAliveWhile` parks a durable alarm ahead of in-flight work, so an
 *   incarnation that dies owing work is revived by the alarm's fire. The
 *   production adapter is `(work) => keepalive.track(work())` over ONE
 *   ProcessorKeepalive (stream-processor-keepalive.ts) — the runner REUSES
 *   that machinery wholesale, it never reinvents mark/backoff/quiet-clean.
 * - `appendRevived` appends the `<namespace>/revived` fact — the journaled
 *   evidence that guarantees at least one delivery turn (and therefore one
 *   `onCaughtUp` pass) even at zero lag. It is called by the adapter's own
 *   revival pass (the keepalive's `revive` hook), not by the runner core.
 * - `handleAlarm` services the durable timer (`ProcessorKeepalive.onAlarm`);
 *   the host DO multiplexes its single alarm across runners and routes fires
 *   to {@link StreamProcessorRunner.handleAlarm}, which delegates here.
 */
export type ProcessorRecovery = {
  /** The exact `<namespace>/revived` event type `appendRevived` appends. The
   * runner's construction check validates the contract consumes THIS type —
   * a processor consuming some OTHER processor's revived event would pass a
   * shape-only check while its own revival fact never invokes it. */
  revivedEventType: string;
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
 * is read. `idempotencyKey` derives a deterministic effect key from the
 * author's key + this event's source offset + the current `cursorRevision`,
 * so a crash retry of the same event dedupes (same offset, same revision)
 * while an operator `reprocessFrom` re-emits (same offset, NEW revision) — no
 * random id. At revision 0 the derivation is BYTE-IDENTICAL to the legacy
 * `StreamProcessor.idempotencyKey(key, whileProcessing)` format
 * (`<slug>/<key>@<path>:<offset>`): an effect committed under the old code
 * must dedupe, not duplicate, when the new runner replays it post-deploy.
 * Obligation-derived stable keys are a SEPARATE concept — those keep using
 * the processor's own `idempotencyKey(key)` with the deciding state folded
 * into `key`, exactly as today.
 */
export type DeliveryContext = {
  phase: DeliveryPhase;
  /** The highest stream offset the runner has observed (>= this event's). */
  observedHeadOffset: number;
  /** How far this event trails `observedHeadOffset`; 0 = at the observed head. */
  eventsBehindObservedHead: number;
  /** The processing cursor's current fencing token (see {@link ProcessingProgress}). */
  cursorRevision: number;
  /** Derive a deterministic effect key: `authorKey + sourceOffset + cursorRevision`. */
  idempotencyKey(key: string): string;
};

/**
 * When to durably persist progress. Consulted after every completed event
 * (`frameEnd: false`) and once at the end of each frame (`frameEnd: true`).
 * The gap between the in-memory completed cursor and the last persisted
 * acknowledgement is the deliberate at-least-once replay window; a policy
 * that commits less often widens it, never breaks it (appends stay
 * idempotency-keyed). Ship default: {@link perFrameCadence} — persist once
 * per frame after all its events' blocking work completes, matching the
 * legacy batch checkpoint window exactly.
 */
export type CheckpointCadence = (args: {
  /** True for the end-of-frame consult (after every event's blocking work settled). */
  frameEnd: boolean;
  /** Events completed since the last durable commit. */
  eventsSinceCommit: number;
}) => boolean;

/** The default cadence: one durable commit per delivered frame. */
const perFrameCadence: CheckpointCadence = ({ frameEnd }) => frameEnd;

/**
 * The audit fact appended by the operator cursor controls (`reprocessFrom` /
 * `skipThrough`). Evidence, not enforcement: the CAS-fenced progress commit is
 * authoritative (the same KV-over-journal inversion the keepalive documents);
 * the fact narrates the episode in the journal and dedupes per revision, so a
 * platform retry never journals a duplicate.
 */
export const STREAM_PROCESSOR_CURSOR_CONTROL_EVENT_TYPE =
  "events.iterate.com/stream-processor/cursor-control";

/** One transport frame as delivered to the sink. */
type SinkFrame = { events: readonly StreamEvent[]; streamMaxOffset: number };

/** A consumed-type event whose payload failed the contract parse, awaiting its post-commit diagnostic. */
type PendingParseFailure = { event: StreamEvent; error: z.ZodError };

/** A pending `waitUntilEvent` waiter (see the method doc for semantics). */
type EventWaiter = {
  predicate: (event: StreamEvent) => boolean;
  reject: (error: unknown) => void;
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** The in-flight fold/cursor context of one frame, committed per cadence. */
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
 * Serialization: frames and operator controls share ONE in-memory chain, so a
 * cursor rewind never interleaves with a half-processed frame. Cross-
 * incarnation races (a stale runner outliving a rewind made elsewhere) are
 * fenced durably instead, by the progress store's `cursorRevision` CAS.
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
  private readonly cadence: CheckpointCadence;
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
  /** Highest stream offset observed across all frames this incarnation. */
  #observedHeadOffset = 0;
  /** Serializes frames + operator controls; failures are contained per entry. */
  #chain: Promise<void> = Promise.resolve();
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
    /** Durable-commit cadence policy; default = once per frame. */
    cadence?: CheckpointCadence;
    /** Journal read page size (refold/catch-up paging); tests shrink it. */
    readPageSize?: number;
  }) {
    this.processor = args.processor;
    this.driver = StreamProcessor.runnerDriver(args.processor);
    this.stream = args.stream;
    this.durability = args.durability;
    this.keepAlive = args.keepAlive;
    this.now = args.now ?? (() => Date.now());
    this.cadence = args.cadence ?? perFrameCadence;
    this.readPageSize = args.readPageSize ?? 500;

    if (this.durability?.recovery !== undefined) {
      // A revival fact nobody consumes recovers nothing: recovery's whole
      // mechanism is "append `<ns>/revived`, let the ordinary delivery turn
      // run the processor's own reconciliation handlers". Exact identity, not
      // shape: consuming some OTHER processor's `/revived` event recovers
      // nothing either — the fact THIS adapter appends must be consumed.
      const revivedEventType = this.durability.recovery.revivedEventType;
      const consumes = this.driver.contract.consumes;
      const consumesRevived = consumes.includes("*") || consumes.includes(revivedEventType);
      if (!consumesRevived) {
        throw new Error(
          `stream processor "${this.driver.contract.slug}" wires recovery whose revival fact ` +
            `is "${revivedEventType}", but the contract does not consume it — a revival fact ` +
            `nobody consumes recovers nothing. Add that exact event type to the contract's consumes.`,
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
    sink: (batch: { events: readonly StreamEvent[]; streamMaxOffset: number }) => Promise<void>;
  }> {
    this.#assertNotDisposed();
    await this.#load();
    return {
      checkpointOffset: this.#requireProgress().processing.acknowledgedThroughOffset,
      sink: (batch: SinkFrame) => {
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
        // the cursor parks below head, `onCaughtUp` never fires, and the
        // obligation the frame opened wedges. Every behind frame therefore
        // gets a trailing type-UNFILTERED self-pull that folds the tail up
        // to head (its final page reports its own tail as the head, so the
        // at-head pulse fires). It rides the runner's chain — serialized
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
   * External confirmation that published state IS the fold — the legacy
   * zero-batch caught-up confirmation. With the
   * runner this is almost always redundant (`#load` performs any pending
   * refold itself, so `isLoaded` is true after every successful load); it
   * survives for a host that confirmed the fold through its own delivery
   * machinery, mirroring the legacy host's catch-up contract.
   */
  markLoaded(): void {
    this.#hasLoaded = true;
  }

  /**
   * Observe committed reduced-state changes IN-PROCESS: the observer is a
   * local function (the hosting registry wires it to reassemble its
   * live-state engine), never a retained RPC stub. It fires after a frame
   * commit lands durably AND the committed state changed identity — the
   * runner's home for the legacy `StreamProcessor.observeStateChanges` +
   * post-persist notify. Operator cursor
   * controls (`reReduce`/`reprocessFrom`/`skipThrough`) do NOT notify —
   * callers of those refresh live state themselves. Returns an unsubscribe.
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
  }): Promise<void>;
  waitUntilEvent(args: { offset: number; timeoutMs?: number }): Promise<void>;
  async waitUntilEvent(
    args:
      | { predicate: (event: StreamEvent) => boolean; timeoutMs?: number }
      | { offset: number; timeoutMs?: number },
  ): Promise<void> {
    if ("offset" in args) {
      await this.#load();
      if (this.#requireProgress().processing.acknowledgedThroughOffset >= args.offset) return;
      const { offset, timeoutMs } = args;
      // No await between the check above and registering the waiter below
      // (the predicate call registers synchronously), so a frame cannot
      // advance the cursor past `offset` in the gap and be missed.
      const reached = this.waitUntilEvent({
        predicate: (event) => event.offset >= offset,
        timeoutMs,
      });
      // Self-pull, not park-and-hope: this form's contract is read-your-writes
      // over an append that already committed, and a parked waiter alone would
      // hold the wait hostage to the push lane's health (a wedged
      // subscription, a lost wake dial — the orphaned-announcement incident
      // class). The catch-up rides the runner chain, serialized with delivered
      // frames — no double-drive against a concurrent live frame, because
      // redelivered offsets dedupe against the acknowledged cursor — and
      // resolves the waiter through the ordinary frame commit. A genuinely
      // future offset stays parked for delivery. Pull failures are logged, not
      // rethrown: the waiter stays valid (a later frame still resolves it) and
      // `timeoutMs` stays the caller's bound.
      this.catchUp().catch((error: unknown) => {
        console.error(
          `stream processor "${this.driver.contract.slug}" waitUntilEvent(offset ${offset}) ` +
            `self-pull failed; the waiter stays parked for delivery`,
          error,
        );
      });
      return await reached;
    }
    const { predicate, timeoutMs } = args;
    await new Promise<void>((resolve, reject) => {
      const waiter: EventWaiter = { predicate, reject, resolve };
      this.#eventWaiters.add(waiter);
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.#eventWaiters.delete(waiter);
          reject(new Error(`waitUntilEvent timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /**
   * Rebuild the reduction cache through the acknowledged cursor by re-running
   * `reduce` ONLY — no effects, no cursor movement, no revision bump (the
   * cache is disposable; rebuilding it rewinds nothing). Fires automatically
   * on a `reducerVersion` mismatch at load; callable by operators to heal a
   * corrupt cache. The rebuild stages into locals and swaps in atomically
   * after the durable commit — a partial refold is never observable.
   */
  reReduce(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#load();
      const progress = this.#requireProgress();
      const reduction = await this.#rebuildReduction(progress.processing.acknowledgedThroughOffset);
      const next: ProcessorProgress<ProcessorState<Contract>> = {
        reduction,
        processing: progress.processing,
      };
      await this.#commit(next, progress.processing.cursorRevision);
      this.#progress = next;
    });
  }

  /**
   * Operator rewind of the EFFECT cursor: CAS on `expectedCursorRevision`,
   * set acknowledged = `offset - 1`, bump `cursorRevision` (staling in-flight
   * continuations' commits and rotating `idempotencyKey` derivations so
   * effects genuinely re-emit), reconstruct the fold through `offset - 1`
   * (reduce only), then re-run `reduce` + `processEvent` from `offset` by
   * self-pulling the journal. `snapshot()` honestly rewinds while it catches
   * back up. Appends a `cursor-control` audit fact (evidence; the CAS commit
   * is authoritative). The rewind is durable once the commit lands even if
   * the catch-up replay then fails — the transport's redelivery (or the next
   * call) resumes from the rewound cursor.
   */
  reprocessFrom(args: {
    offset: number;
    expectedCursorRevision: number;
    reason: string;
  }): Promise<{ cursorRevision: number }> {
    return this.#enqueue(async () => {
      await this.#load();
      const progress = this.#requireProgress();
      if (!Number.isInteger(args.offset) || args.offset < 1) {
        throw new Error(`reprocessFrom offset must be a positive integer, got ${args.offset}`);
      }
      if (args.offset > progress.processing.acknowledgedThroughOffset + 1) {
        throw new Error(
          `reprocessFrom(${args.offset}) would SKIP past acknowledged offset ` +
            `${progress.processing.acknowledgedThroughOffset}; use skipThrough for that`,
        );
      }
      this.#assertExpectedRevision("reprocessFrom", progress, args.expectedCursorRevision);
      const cursorRevision = args.expectedCursorRevision + 1;
      const reduction = await this.#rebuildReduction(args.offset - 1);
      const next: ProcessorProgress<ProcessorState<Contract>> = {
        reduction,
        processing: { acknowledgedThroughOffset: args.offset - 1, cursorRevision },
      };
      // The CAS commit IS the fence: it lands under the OLD revision and
      // writes the new one, so any in-flight continuation of the old cursor
      // fails its own commit from here on.
      await this.#commit(next, args.expectedCursorRevision);
      this.#progress = next;
      this.#appendCursorControlAudit({
        control: "reprocess-from",
        offset: args.offset,
        reason: args.reason,
        cursorRevision,
      });
      await this.#selfCatchUp();
      return { cursorRevision };
    });
  }

  /**
   * The audited escape hatch past a poison event: advance the acknowledged
   * cursor through `offset` WITHOUT running its effects, CAS-fenced and
   * revision-bumping like `reprocessFrom`. The skipped events are still
   * REDUCED (best-effort — a reduce that itself throws is logged and its
   * event's fold contribution dropped; the journal remains the authority),
   * because what is being skipped is the EFFECT, not the fact. The only exit
   * from the block-retry-forever failure policy — there is deliberately no
   * auto-DLQ.
   */
  skipThrough(args: {
    offset: number;
    expectedCursorRevision: number;
    reason: string;
  }): Promise<{ cursorRevision: number }> {
    return this.#enqueue(async () => {
      await this.#load();
      const progress = this.#requireProgress();
      // Integer guard FIRST: NaN fails every `<=` comparison, so without it a
      // NaN offset would sail past the already-acknowledged check and persist
      // NaN cursors.
      if (!Number.isInteger(args.offset) || args.offset < 1) {
        throw new Error(`skipThrough offset must be a positive integer, got ${args.offset}`);
      }
      if (args.offset <= progress.processing.acknowledgedThroughOffset) {
        throw new Error(
          `skipThrough(${args.offset}) is already acknowledged ` +
            `(through ${progress.processing.acknowledgedThroughOffset}); nothing to skip`,
        );
      }
      this.#assertExpectedRevision("skipThrough", progress, args.expectedCursorRevision);
      const cursorRevision = args.expectedCursorRevision + 1;

      let state = progress.reduction.state;
      // Track the highest journal offset the reduce pass actually READ: a
      // skip past the durable head must throw, not persist cursors past
      // events that do not exist (they would read as pre-acknowledged when
      // they later arrive — silently never processed).
      let highestReadOffset = progress.reduction.reducedThroughOffset;
      if (progress.reduction.reducedThroughOffset < args.offset) {
        using pager = this.stream.readEvents({
          afterOffset: progress.reduction.reducedThroughOffset,
          beforeOffset: args.offset + 1,
          limit: this.readPageSize,
        });
        let page = await pager.next();
        while (page.length > 0) {
          for (const event of page) {
            if (event.offset > args.offset) continue;
            highestReadOffset = Math.max(highestReadOffset, event.offset);
            try {
              const reduction = this.driver.reduceRawEvent({ event, state });
              if (reduction !== undefined && !("parseError" in reduction)) {
                state = reduction.state;
              }
            } catch (error) {
              console.error(
                `stream processor "${this.driver.contract.slug}" reduce failed on skipped ` +
                  `offset ${event.offset}; the fold proceeds without it`,
                error,
              );
            }
          }
          page = await pager.next();
        }
      }
      if (highestReadOffset < args.offset) {
        throw new Error(
          `skipThrough(${args.offset}) is past the durable head — the journal's highest ` +
            `readable offset is ${highestReadOffset}; refusing to persist cursors past ` +
            `events that do not exist`,
        );
      }

      const next: ProcessorProgress<ProcessorState<Contract>> = {
        reduction: {
          reducerVersion: this.driver.contract.version,
          reducedThroughOffset: args.offset,
          state,
        },
        processing: { acknowledgedThroughOffset: args.offset, cursorRevision },
      };
      await this.#commit(next, args.expectedCursorRevision);
      this.#progress = next;
      this.#appendCursorControlAudit({
        control: "skip-through",
        offset: args.offset,
        reason: args.reason,
        cursorRevision,
      });
      return { cursorRevision };
    });
  }

  /** Release delivery resources. Idempotent; a disposed runner rejects new work. */
  dispose(): void {
    this.#disposed = true;
    for (const waiter of this.#eventWaiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(new Error("StreamProcessorRunner disposed"));
    }
    this.#eventWaiters.clear();
    this.#stateChangeObservers.clear();
  }

  // ---------------------------------------------------------------------------
  // The per-event loop.
  // ---------------------------------------------------------------------------

  async #processFrame(frame: SinkFrame): Promise<void> {
    const ingestStartedAtMs = this.now();
    await this.#load();
    const committed = this.#requireProgress();

    // Offset-dedupe against the acknowledged cursor (and within the frame):
    // redelivered events are silent skips, exactly like legacy ingest.
    const pending: StreamEvent[] = [];
    let scan = committed.processing.acknowledgedThroughOffset;
    for (const event of frame.events) {
      if (event.offset <= scan) continue;
      scan = event.offset;
      pending.push(event);
    }

    // observedHead = max(streamMaxOffset, last event offset), monotonic across
    // frames: "the highest offset the runner has OBSERVED" never regresses on
    // a stale redelivery, so a behind frame can always SEE it is behind.
    this.#observedHeadOffset = Math.max(this.#observedHeadOffset, frame.streamMaxOffset, scan);
    if (pending.length === 0) return;
    const observedHeadOffset = this.#observedHeadOffset;
    // What this frame will acknowledge through once its blocking work
    // completes — the legacy `checkpointOffset` semantics, kept verbatim for
    // the existing `processEvent` signature.
    const frameCheckpointOffset = pending.at(-1)!.offset;

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
          const delivery: DeliveryContext = {
            phase: event.offset >= observedHeadOffset ? "live" : "catching-up",
            observedHeadOffset,
            eventsBehindObservedHead: Math.max(0, observedHeadOffset - event.offset),
            cursorRevision: ctx.revision,
            idempotencyKey: (key) => this.#effectIdempotencyKey(key, event, ctx.revision),
          };
          const eventBlockers: Promise<unknown>[] = [];
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
            runInBackground: (work) => this.#runInBackground(work),
            append: (...input) => this.driver.append({ whileProcessing }, input),
            appendTo: (path, ...input) => this.driver.appendTo(path, { whileProcessing }, input),
          });
          // STRICT PER-EVENT ORDERING: THIS event's blocking work completes
          // before the next event's processEvent starts. Background work was
          // registered (keepalive-backed) and deliberately NOT awaited — it
          // may overtake later events.
          await Promise.all(eventBlockers);
          ctx.state = reduction.state;
        }
        // Non-consumed and malformed events advance both cursors too —
        // mirroring what a filtered delivery's cursor does today.
        ctx.reducedThroughOffset = event.offset;
        ctx.completedThroughOffset = event.offset;
        ctx.eventsSinceCommit += 1;
        ctx.uncommittedEvents.push(event);

        // The head-reaching event's acknowledgement is DEFERRED to the
        // frame-end commit, which runs only after `onCaughtUp` and its
        // awaited blockers: a mid-frame commit of the head event would let
        // an onCaughtUp blocker failure (or death) strand its work — the
        // cursor already at head, redelivery empty, the at-head pass never
        // retried. Holding the commit keeps the whole frame retryable.
        if (
          ctx.completedThroughOffset < observedHeadOffset &&
          this.cadence({ frameEnd: false, eventsSinceCommit: ctx.eventsSinceCommit })
        ) {
          await this.#commitFrameContext(ctx);
        }
      }

      // AT-HEAD: processing reached everything the runner has observed. This
      // is the runner-level pulse that replaces the legacy reconcile gate —
      // and it fires even when the tail events were not consumed (a frame of
      // foreign types still advances the cursor to head), closing the
      // requested-N-then-unconsumed-N+1 wedge.
      if (ctx.completedThroughOffset >= observedHeadOffset) {
        const caughtUpBlockers: Promise<unknown>[] = [];
        await this.driver.onCaughtUp({
          state: ctx.state,
          delivery: {
            phase: "live",
            observedHeadOffset,
            eventsBehindObservedHead: 0,
            cursorRevision: ctx.revision,
            // No source event: obligation keys must stay stable across
            // passes, so the derivation binds no offset (only the revision).
            idempotencyKey: (key) => this.#effectIdempotencyKey(key, undefined, ctx.revision),
          },
          blockProcessorWhile: (work) => {
            const attempt = this.#keepAliveBackedWork(work);
            caughtUpBlockers.push(attempt);
            startedBlockers.push(attempt);
          },
          runInBackground: (work) => this.#runInBackground(work),
          append: (...input) => this.driver.append({}, input),
          appendTo: (path, ...input) => this.driver.appendTo(path, {}, input),
        });
        await Promise.all(caughtUpBlockers);
      }
    } catch (error) {
      // A failed frame must still settle work it already registered so
      // nothing rejects unobserved. Whatever was not yet durably committed is
      // not committed now — the frame stays retryable and the transport
      // replays it from the last acknowledged cursor.
      // (The legacy #ingest's failure settlement, verbatim.)
      await Promise.allSettled(startedBlockers);
      throw error;
    }

    if (
      ctx.eventsSinceCommit > 0 &&
      this.cadence({ frameEnd: true, eventsSinceCommit: ctx.eventsSinceCommit })
    ) {
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
    this.#resolveEventWaiters(committedEvents);
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
          idempotencyKey: this.#effectIdempotencyKey("event-parse-failed", event, ctx.revision),
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
   * Re-run `reduce` + `processEvent` from the (rewound) acknowledged cursor
   * by self-pulling the journal — reprocessFrom cannot rely on the transport
   * pump, whose cursor was fixed at wake handshake. One page of lookahead so
   * every non-final frame carries a streamMaxOffset PAST its own tail (the
   * at-head pulse fires only on the genuinely final page), mirroring the
   * host's catch-up.
   */
  async #selfCatchUp(): Promise<void> {
    using pager = this.stream.readEvents({
      afterOffset: this.#requireProgress().processing.acknowledgedThroughOffset,
      limit: this.readPageSize,
    });
    let events = await pager.next();
    while (events.length > 0) {
      const lookahead = await pager.next();
      await this.#processFrame({
        events,
        streamMaxOffset: (lookahead.at(-1) ?? events.at(-1))!.offset,
      });
      events = lookahead;
    }
  }

  // ---------------------------------------------------------------------------
  // Small shared machinery.
  // ---------------------------------------------------------------------------

  /**
   * `<slug>/<key>[@<path>:<offset>]` (the LEGACY derivation, byte-identical),
   * plus `#<cursorRevision>` only when the revision is nonzero — so effects
   * committed under pre-runner code dedupe across the deploy, and only an
   * operator rewind rotates keys.
   */
  #effectIdempotencyKey(
    key: string,
    whileProcessing: Pick<StreamEvent, "offset" | "path"> | undefined,
    cursorRevision: number,
  ): string {
    const base = this.driver.idempotencyKey(key, whileProcessing);
    return cursorRevision === 0 ? base : `${base}#${cursorRevision}`;
  }

  #appendCursorControlAudit(args: {
    control: "reprocess-from" | "skip-through";
    offset: number;
    reason: string;
    cursorRevision: number;
  }): void {
    // Background + best-effort: the CAS-fenced progress commit is
    // authoritative; this fact is evidence (the keepalive's KV-over-journal
    // inversion). Keyed per revision so a platform retry never duplicates.
    this.#runInBackground(() =>
      this.stream.append({
        type: STREAM_PROCESSOR_CURSOR_CONTROL_EVENT_TYPE,
        idempotencyKey: `${this.driver.contract.slug}/cursor-control:${args.control}:${args.cursorRevision}`,
        source: { processor: this.driver.processorStamp() },
        payload: {
          control: args.control,
          processorSlug: this.driver.contract.slug,
          offset: args.offset,
          reason: args.reason,
          cursorRevision: args.cursorRevision,
          requestedAtMs: this.now(),
        },
      }),
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

  /** Serialize frames + operator controls; the chain swallows each entry's
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

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error(
        `StreamProcessorRunner for "${this.driver.contract.slug}" is disposed; it accepts no new work`,
      );
    }
  }

  #assertExpectedRevision(
    control: string,
    progress: ProcessorProgress<ProcessorState<Contract>>,
    expectedCursorRevision: number,
  ): void {
    if (progress.processing.cursorRevision !== expectedCursorRevision) {
      throw new Error(
        `${control} expected cursorRevision ${expectedCursorRevision} but the cursor is at ` +
          `${progress.processing.cursorRevision} — refusing a stale cursor control`,
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

  // Settle `waitUntilEvent` waiters whose predicate matches a just-committed
  // event. Runs after the durable commit + published-cursor advance, so
  // `snapshot()` already reflects the matched event when a waiter resolves.
  #resolveEventWaiters(events: readonly StreamEvent[]): void {
    if (events.length === 0) return;
    for (const waiter of this.#eventWaiters) {
      let matched = false;
      try {
        matched = events.some(waiter.predicate);
      } catch (error) {
        this.#eventWaiters.delete(waiter);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.reject(error);
        continue;
      }
      if (matched) {
        this.#eventWaiters.delete(waiter);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }
}
