import { RpcTarget } from "capnweb";
import type { z } from "zod";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { ProcessorRuntimeState, ProcessorSnapshot } from "./rpc-types.ts";
import { SubscriberMetrics } from "./subscriber-metrics.ts";
import {
  assertObjectProcessorState,
  cachedEventSchema,
  getConsumedEventDefinition,
  getEventInputSchema,
  getResolvedEventDefinition,
  type ConsumedEvent,
  type EmittedInput,
  type EventCatalog,
  type ProcessorState,
} from "./processor-contracts.ts";

// =============================================================================
// Class-based stream processor runtime.
// =============================================================================

type MaybePromise<T> = T | Promise<T>;

/**
 * The structural slice of a processor contract that the class needs. Contracts
 * built with `defineProcessorContract(...)` satisfy this; the full contract
 * type flows through the `Contract` type parameter so event/state inference
 * reaches the hooks.
 */
export type StreamProcessorContract = {
  slug: string;
  version: string;
  stateSchema: z.ZodType;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  emits: readonly string[];
  parseEvent(event: StreamEvent): StreamEvent;
};

/**
 * Host-provided constructor dependencies shared by every processor:
 * the stream append capability, the home stream's identity (`path` /
 * `projectId`, stamped as provenance onto every emitted event), optional
 * checkpoint storage (`readState`/`writeState`), and an optional
 * `keepAliveWhile` hook for hosts whose runtime would otherwise shut down
 * while async work is in flight (e.g. a Durable Object).
 */
export type StreamProcessorBaseDeps<Contract> = {
  stream: Stream;
  /** Path of the stream this processor runs on (the stream `stream` points at). */
  path: string;
  /** Owning project, or null on a global (deployment-root) stream. */
  projectId: string | null;
  keepAliveWhile?: (work: () => Promise<unknown>) => void;
} & StreamProcessorStateStorage<ProcessorState<Contract>>;

// These arg shapes are intentionally not exported: subclass overrides annotate
// their args as `Parameters<StreamProcessor<Contract>["method"]>[0]` so there
// is exactly one spelling.
//
// State and events are passed by reference. Hooks must treat them as immutable:
// `reduce` returns a new state object instead of mutating its input.
type ReducedEvent<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};

/**
 * A consumed-type event whose shape failed the contract parse. Distinguished
 * from `undefined` (type not consumed at all) so ingest can skip the event
 * AND record the skip durably instead of silently dropping it.
 */
type ConsumedEventParseFailure = { parseError: z.ZodError };

/** What `reduce` receives: one consumed event and the state to fold it into. */
type ReduceArgs<Contract> = {
  event: ConsumedEvent<Contract>;
  state: ProcessorState<Contract>;
};

/**
 * Side-effect scheduling helpers handed to the `process*` hooks. Two
 * primitives, two guarantees — every side effect must pick one deliberately:
 *
 * - `blockProcessorWhile` — SHORT work the next event must not overtake.
 *   At-least-once: the checkpoint is held, a crash redelivers the batch, and
 *   append idempotency keys collapse the re-run. Long work does NOT belong
 *   here: it head-of-line-blocks every later event (including cancellations).
 *
 * - `runInBackground` — a DROPPABLE ATTEMPT. The checkpoint advances
 *   immediately; an eviction loses the closure silently. Every callsite must
 *   answer "what recovers the OUTCOME if this attempt drops?" — legitimate
 *   answers are "an end-of-batch reconciliation, via journaled
 *   requested/completed evidence" (LLM calls, scripts, debounce timers) or
 *   "nothing, the outcome genuinely doesn't matter" (telemetry). A naked
 *   runInBackground around consequential work with no reconciler is the bug
 *   class the 2026-06-10 / 2026-07-07 incidents came from.
 *
 * Both are keepalive-backed: while either kind of work is in flight the host
 * parks a durable alarm ahead of it, so an incarnation that dies owing work
 * is revived and the reconcilers get their batch
 * (docs/writing-stream-processors.md has the full doctrine).
 */
type SideEffectHelpers = {
  /** Hold the checkpoint (and the next batch) until this work completes. */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** A droppable attempt; failures are caught and logged, evictions lose it. */
  runInBackground: (work: () => Promise<unknown>) => void;
};

/** What `processEvent` receives: one reduction result plus batch context and helpers. */
type ProcessEventArgs<Contract> = ReducedEvent<Contract> &
  SideEffectHelpers & {
    /**
     * Append one or more events listed in `contract.emits` to this stream,
     * stamped with `source.processor` provenance pointing at THIS event as
     * `whileProcessing`. The binding is a closure, so appends made later from
     * `blockProcessorWhile`/`runInBackground` work scheduled here still stamp
     * the event that was being processed.
     */
    append: (...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    /** Like `append`, onto a sibling stream (resolved via `stream.at(path)`). */
    appendTo: (path: string, ...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    streamMaxOffset: number;
    /**
     * The offset this batch will checkpoint through once all blocking work
     * completes — the last event offset in the batch, not this event's offset.
     */
    checkpointOffset: number;
  };

/** What `processEventBatch` receives: the whole delivered batch plus its reductions. */
type ProcessEventBatchArgs<Contract> = SideEffectHelpers & {
  /**
   * Append one or more events listed in `contract.emits`, stamped with
   * `source.processor` but no `whileProcessing`: a batch-level append is
   * derived from the whole fold, not one event, and the stamp says so by
   * omission. Per-event attribution comes from the `processEvent` lane
   * (`super.processEventBatch(args)` keeps it running).
   */
  append: (...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
  /** New events past the checkpoint, in stream order, consumed or not. */
  events: readonly StreamEvent[];
  /** The consumed subset of `events`, each with its reduction result. */
  reducedEvents: readonly ReducedEvent<Contract>[];
  /** Processor state when the batch started. */
  previousState: ProcessorState<Contract>;
  /** Processor state after every event in the batch has been reduced. */
  state: ProcessorState<Contract>;
  streamMaxOffset: number;
  checkpointOffset: number;
};

/**
 * A durable checkpoint: the reduced state plus the highest stream offset that
 * has been fully reduced and processed. Written atomically per batch.
 *
 * The canonical shapes live in rpc-types.ts (`ProcessorSnapshot` /
 * `ProcessorRuntimeState`, the published contract); these are aliases under
 * the engine's historical names so the two can never drift apart.
 */
export type StreamProcessorSnapshot<State> = ProcessorSnapshot<State>;

/**
 * A processor's inspectable live state. `snapshot` is the durable checkpoint;
 * `runtime` is operational data useful to UIs and operators but not part of
 * replay correctness.
 */
export type StreamProcessorRuntimeState<State> = ProcessorRuntimeState<State> & {
  snapshot: StreamProcessorSnapshot<State>;
};

/** A pending `waitUntilEvent` waiter: the match predicate, the resolver to fire
 *  when a delivered event matches, and an optional timeout handle to clear on
 *  resolution (so a satisfied waiter never later rejects). */
type EventWaiter = {
  predicate: (event: StreamEvent) => boolean;
  reject: (error: unknown) => void;
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Where checkpoints live. Hosts inject these; when omitted the processor keeps
 * an in-memory snapshot, which is enough for tests and stateless experiments.
 * `readState` is called once, lazily, before the first batch; `writeState` is
 * called after each successful batch.
 */
export type StreamProcessorStateStorage<State> = {
  readState?: () => MaybePromise<StreamProcessorSnapshot<State> | undefined>;
  writeState?: (snapshot: StreamProcessorSnapshot<State>) => MaybePromise<void>;
};

/**
 * Constructor args are the base deps plus the subclass's own `Deps` flattened
 * into one object, e.g. `new BrowserRawEventsProcessor({ stream, sql,
 * readState, writeState })`.
 */
export type StreamProcessorConstructorArgs<
  Contract extends StreamProcessorContract,
  Deps extends object,
> = StreamProcessorBaseDeps<Contract> & Deps;

/**
 * Class-based stream processor.
 *
 * The model in one sentence: the host feeds ordered event batches into
 * `ingest`, the base reduces each new event into state, hands the batch to the
 * `process*` hooks for side effects, and checkpoints state + offset once all
 * blocking work has completed.
 *
 * `ingest` is host plumbing; the `process*` family is the authoring surface.
 * Subclasses override up to four hooks:
 *
 * - `reduce` — pure projection of one consumed event into the next state
 * - `processEvent` — synchronous per-event side effects; what most processors
 *   implement
 * - `processEventBatch` — batch-level side effects (e.g. one SQLite
 *   transaction); the default implementation calls `processEvent` once per
 *   reduced event
 * - `reconcile` — desired-vs-actual reconciliation over the batch's final
 *   fold; the base calls it only for AT-HEAD batches, so overrides never
 *   need their own mid-refold gate
 *
 * plus an optional one-time `prepare` for setup that must land before the
 * checkpoint is first read (e.g. schema migrations that reset it).
 *
 * Every hook runs inside the serialized batch section: a later batch never
 * starts until the previous one has completed or failed, and the checkpoint is
 * only written after the hooks (plus any `blockProcessorWhile` work) succeed.
 * `ingest` itself must not be overridden.
 */
export abstract class StreamProcessor<
  Contract extends StreamProcessorContract,
  Deps extends object = object,
> extends RpcTarget {
  abstract readonly contract: Contract;
  protected readonly stream: Stream;
  /** Path of the home stream — the one `this.stream` points at. */
  protected readonly path: string;
  /** Owning project, or null on a global (deployment-root) stream. */
  protected readonly projectId: string | null;
  protected readonly deps: Deps;

  /**
   * Self-measured consumption metrics (see subscriber-metrics.ts): every
   * home-stream append and every ingested batch feeds it, closing the
   * consume-your-own-appends loop on the processor's own clock. HOSTS merge
   * `subscriberMetrics.report()` into the `getRuntimeState` answer they give
   * the stream (`runtime.metrics`) — merged host-side so a subclass
   * overriding `getRuntimeState` with its own `runtime` bag cannot
   * accidentally drop it. In-memory; resets with the isolate.
   */
  readonly subscriberMetrics = new SubscriberMetrics(Date.now());

  #checkpointOffset = 0;
  // eslint-disable-next-line no-unused-private-class-members -- oxlint false positive: #loadState reads and assigns this via ??=.
  #loaded: Promise<void> | undefined;
  #hasLoaded = false;
  #processing: Promise<void> = Promise.resolve();
  #state: ProcessorState<Contract> | undefined;
  #memorySnapshot: StreamProcessorSnapshot<ProcessorState<Contract>> | undefined;
  readonly #keepAliveWhile: ((work: () => Promise<unknown>) => void) | undefined;
  readonly #readState: () => MaybePromise<
    StreamProcessorSnapshot<ProcessorState<Contract>> | undefined
  >;
  readonly #writeState: (
    snapshot: StreamProcessorSnapshot<ProcessorState<Contract>>,
  ) => MaybePromise<void>;
  readonly #stateChangeObservers = new Set<
    (snapshot: StreamProcessorSnapshot<ProcessorState<Contract>>) => void
  >();
  readonly #eventWaiters = new Set<EventWaiter>();

  constructor(args: StreamProcessorConstructorArgs<Contract, Deps>) {
    super();
    // Base deps are destructured out; everything else is the subclass's Deps.
    const { stream, path, projectId, keepAliveWhile, readState, writeState, ...deps } = args;
    this.stream = stream;
    this.path = path;
    this.projectId = projectId;
    this.deps = deps as Deps;
    this.#keepAliveWhile = keepAliveWhile;
    this.#readState = readState ?? (() => this.#memorySnapshot);
    this.#writeState =
      writeState ??
      ((snapshot) => {
        this.#memorySnapshot = snapshot;
      });
  }

  /** Current reduced state. Initial state until the first batch loads/reduces. */
  get state(): ProcessorState<Contract> {
    return this.#getState();
  }

  /** Highest stream offset this processor has durably processed through. */
  get checkpointOffset(): number {
    return this.#checkpointOffset;
  }

  /** Loads (once) and returns the current checkpoint. Hosts use the offset as the replay cursor. */
  async snapshot(): Promise<StreamProcessorSnapshot<ProcessorState<Contract>>> {
    await this.#loadState();
    return {
      offset: this.#checkpointOffset,
      state: this.#getState(),
    };
  }

  /** Returns the broad processor runtime view; subclasses may add operational `runtime` data. */
  async getRuntimeState(): Promise<StreamProcessorRuntimeState<ProcessorState<Contract>>> {
    return { snapshot: await this.snapshot() };
  }

  /**
   * The host-facing sink. Batches are serialized in memory: a later batch never
   * starts until the previous one completed or failed. Do not override this —
   * extend `processEventBatch` instead.
   */
  async ingest(args: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void> {
    const next = this.#processing.then(() => this.#ingest(args));
    this.#processing = next.catch(() => undefined);
    return await next;
  }

  /**
   * Resolve once the processor INGESTS an event matching `predicate` — or, with
   * the `{ offset }` form, once the fold has caught up to that stream offset.
   *
   * The promise settles inside the serialized ingest section AFTER the batch is
   * durably checkpointed, so by the time it resolves `this.state` already
   * reflects the matched event. That makes the `{ offset }` form a
   * read-your-writes barrier: append an event, then `await
   * waitUntilEvent({ offset })` on the offset `append` returned, and your next
   * read is guaranteed to see your write.
   *
   * `{ offset }` short-circuits when the checkpoint is already at/past the
   * offset, otherwise waits for the first delivered event at or beyond it. The
   * predicate form only observes FUTURE deliveries (it does not scan history).
   * Keying on the delivered event — not on a state change — matters: the
   * checkpoint advances for every event including ones `reduce` ignores, so
   * this resolves even when the matched event produced no state change (where
   * waiting on `onStateChange` would hang).
   *
   * `predicate` runs on every newly delivered event (consumed or not). If it
   * throws, only that waiter rejects. `timeoutMs` bounds the wait: on timeout
   * the promise REJECTS (and the waiter is dropped); omit it to wait forever.
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
      await this.#loadState();
      if (this.#checkpointOffset >= args.offset) return;
      const { offset, timeoutMs } = args;
      // No await between the check above and registering the waiter below, so a
      // batch cannot advance the checkpoint past `offset` in the gap and be missed.
      return await this.waitUntilEvent({ predicate: (event) => event.offset >= offset, timeoutMs });
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
   * One-time async setup, run before the checkpoint is first read — whether
   * that happens via `snapshot()` or the first ingested batch. Override for
   * work that can invalidate the stored checkpoint, such as schema migrations
   * that reset projection tables, so it always lands before the resume cursor
   * is decided. Failures reject the triggering call and retry on the next one.
   */
  protected async prepare(): Promise<void> {}

  /** Build and validate an append input for an event listed in `contract.emits`. */
  #buildEmittedEvent(event: EmittedInput<Contract>): EmittedInput<Contract> {
    if (!this.contract.emits.includes(event.type)) {
      throw new Error(
        `Processor "${this.contract.slug}" cannot build emitted event "${event.type}".`,
      );
    }
    const eventDefinition = getResolvedEventDefinition({
      contract: this.contract,
      eventType: event.type,
    });
    if (eventDefinition === undefined) {
      throw new Error(`Unresolved stream processor emits event type "${event.type}".`);
    }
    return getEventInputSchema({
      type: event.type,
      payloadSchema: eventDefinition.payloadSchema,
    }).parse(event) as EmittedInput<Contract>;
  }

  /**
   * Pure projection of one consumed event into the next state. Defaults to
   * identity; returning `null`/`undefined` also keeps the current state.
   */
  protected reduce(args: ReduceArgs<Contract>): ProcessorState<Contract> | null | undefined {
    return args.state;
  }

  /** Synchronous per-event side-effect hook, called by the default `processEventBatch`. */
  protected processEvent(_args: ProcessEventArgs<Contract>): undefined {}

  /**
   * Batch-level side-effect hook. Runs inside the serialized section, after the
   * whole batch has been reduced and before the checkpoint is written, so an
   * override can e.g. commit all projection writes in one SQLite transaction.
   * Call `super.processEventBatch(args)` to keep the per-event `processEvent` calls.
   */
  protected async processEventBatch(args: ProcessEventBatchArgs<Contract>): Promise<void> {
    for (const reducedEvent of args.reducedEvents) {
      // Event-bound append lanes: everything appended through them (including
      // later, from work scheduled here) is stamped as emitted while
      // processing THIS event.
      const whileProcessing = reducedEvent.event;
      this.processEvent({
        ...reducedEvent,
        streamMaxOffset: args.streamMaxOffset,
        checkpointOffset: args.checkpointOffset,
        blockProcessorWhile: args.blockProcessorWhile,
        runInBackground: args.runInBackground,
        append: (...input) => this.#appendStamped({ target: this.stream, whileProcessing }, input),
        appendTo: (path, ...input) =>
          this.#appendStamped({ target: this.stream.at(path), whileProcessing }, input),
      });
    }
  }

  /**
   * Desired-vs-actual reconciliation hook — the obligation pattern's home
   * (docs/writing-stream-processors.md): compare the batch's final fold (open
   * obligations, schedules that should fire) against this incarnation's live
   * work, then start undriven attempts and settle dead ones through
   * idempotent appends.
   *
   * The base calls it after `processEventBatch`, and ONLY when the batch
   * reaches the stream head (`checkpointOffset >= streamMaxOffset`). A
   * mid-catch-up fold shows obligations whose outcomes sit in later pages;
   * reconciling it would re-drive real vendor calls and journal false
   * failures — the gate lives here so no override can forget it. Defaults to
   * a no-op.
   */
  protected async reconcile(_args: ProcessEventBatchArgs<Contract>): Promise<void> {}

  /**
   * Reduce one raw stream event against explicit state, without touching the
   * processor's own state or checkpoint. Returns `undefined` for events this
   * processor does not consume, and a {@link ConsumedEventParseFailure} for
   * events of a consumed TYPE whose shape fails the contract parse — streams
   * accept raw appends by design, so a malformed event is a fact of the log,
   * not an exception: throwing here would wedge the checkpoint on it forever.
   */
  #reduceRawEvent(args: {
    event: StreamEvent;
    state: ProcessorState<Contract>;
  }): ReducedEvent<Contract> | ConsumedEventParseFailure | undefined {
    const eventDefinition = getConsumedEventDefinition({
      contract: this.contract,
      eventType: args.event.type,
    });
    if (eventDefinition === undefined) return undefined;

    // Rebuilding the parser from the catalog key and payload schema keeps replay
    // and live delivery on the same validation path. Cached: constructing the
    // zod wrapper per event cost ~20µs on the hot reduce path.
    const parsed = cachedEventSchema({
      type: args.event.type,
      payloadSchema: eventDefinition.payloadSchema,
    }).safeParse(args.event);
    if (!parsed.success) return { parseError: parsed.error };
    const event = parsed.data as ConsumedEvent<Contract>;

    const state = this.reduce({ event, state: args.state }) ?? args.state;
    assertObjectProcessorState({ processorSlug: this.contract.slug, value: state });

    return { event, previousState: args.state, state };
  }

  /** Fire-and-forget async work backed by the host's keep-alive, with failures logged. */
  protected runInBackground(work: () => Promise<unknown>): void {
    this.#runKeepAliveBackedWork(work).catch((error: unknown) => {
      console.error("stream processor background work failed", error);
    });
  }

  async #ingest(args: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void> {
    const ingestStartedAtMs = Date.now();
    await this.#loadState();

    const previousState = this.#getState();
    let state = previousState;
    let checkpointOffset = this.#checkpointOffset;
    const events: StreamEvent[] = [];
    const reducedEvents: ReducedEvent<Contract>[] = [];
    const parseFailures: { event: StreamEvent; error: z.ZodError }[] = [];

    for (const event of args.events) {
      if (event.offset <= checkpointOffset) continue;
      events.push(event);
      checkpointOffset = event.offset;

      const reduction = this.#reduceRawEvent({ event, state });
      if (reduction === undefined) continue;
      if ("parseError" in reduction) {
        parseFailures.push({ event, error: reduction.parseError });
        continue;
      }
      reducedEvents.push(reduction);
      state = reduction.state;
    }

    if (events.length === 0) return;

    const blockingWork: Promise<unknown>[] = [];
    try {
      const batchArgs: ProcessEventBatchArgs<Contract> = {
        events,
        reducedEvents,
        previousState,
        state,
        streamMaxOffset: args.streamMaxOffset,
        checkpointOffset,
        append: (...input) => this.append(...input),
        blockProcessorWhile: (work) => {
          blockingWork.push(this.#runKeepAliveBackedWork(work));
        },
        runInBackground: (work) => this.runInBackground(work),
      };
      await this.processEventBatch(batchArgs);
      // Reconciliation sees only at-head folds; the final catch-up page
      // qualifies by construction (see the reconcile doc comment).
      if (checkpointOffset >= args.streamMaxOffset) {
        await this.reconcile(batchArgs);
      }
      await Promise.all(blockingWork);
    } catch (error) {
      // A failed batch must still settle work it already registered so nothing
      // rejects unobserved. The checkpoint is not written, so the batch stays
      // retryable — the host re-handshakes from the checkpoint on failure and
      // the stream replays it (see createStreamProcessorHost).
      await Promise.allSettled(blockingWork);
      throw error;
    }

    // Persist before advancing in-memory state. If the durable write fails, the
    // batch must stay retryable: the redelivered batch re-reduces from the old
    // state and tries the write again. Advancing #state/#checkpointOffset first
    // would make the retry a silent no-op (every event filtered out, nothing
    // re-saved), so a transient write failure would lose the batch durably.
    await this.#writeState({ offset: checkpointOffset, state });
    this.#state = state;
    this.#checkpointOffset = checkpointOffset;
    // The state now reflects a folded journal prefix — which is what isLoaded
    // asserts. This is how a processor whose checkpoint was DISCARDED at load
    // (schema mismatch) becomes loaded again: the refold lands here.
    this.#hasLoaded = true;
    // The checkpoint is durable and the state advanced — the batch is
    // genuinely CONSUMED, which is the moment self-measured metrics report.
    const newestEventCreatedAtMs = Date.parse(events.at(-1)!.createdAt);
    this.subscriberMetrics.noteBatchIngested({
      ingestedThroughOffset: checkpointOffset,
      ...(Number.isFinite(newestEventCreatedAtMs) ? { newestEventCreatedAtMs } : {}),
      eventCount: events.length,
      ingestStartedAtMs,
      atMs: Date.now(),
    });
    if (!Object.is(previousState, state)) {
      this.#notifyStateChange({ offset: checkpointOffset, state });
    }
    this.#resolveEventWaiters(events);

    // Record skipped unparseable events AFTER the checkpoint commits, in the
    // background: the raw event in the log is the authoritative record and the
    // idempotency key dedupes redelivery, so a failing record append can never
    // re-poison the batch it just rescued.
    for (const { event, error } of parseFailures) {
      const message =
        `stream processor "${this.contract.slug}" skipped event at offset ` +
        `${event.offset} ("${event.type}"): it fails the contract's schema`;
      console.error(message, error);
      // Raw `stream.append`, not the emitted lane: `stream/error-occurred` is
      // core-owned and deliberately absent from subclass `emits` — this is the
      // runtime speaking, not the processor author. It still carries the full
      // provenance stamp (which processor skipped which event).
      this.runInBackground(() =>
        this.stream.append({
          type: "events.iterate.com/stream/error-occurred",
          idempotencyKey: this.idempotencyKey("event-parse-failed", event),
          source: { processor: this.#processorStamp(event) },
          payload: {
            message,
            error: { name: error.name, message: error.message },
          },
        }),
      );
    }
  }

  /**
   * Append events listed in `contract.emits` to this processor's own stream,
   * stamped with `source.processor` provenance (no `whileProcessing`: this
   * lane is for appends outside any batch — alarm handlers, DO methods — and
   * for batch-level decisions derived from the whole fold). Inside
   * `processEvent`, prefer the event-bound `args.append`.
   */
  protected append(...input: EmittedInput<Contract>[]): Promise<StreamEvent[]> {
    return this.#appendStamped({ target: this.stream }, input);
  }

  /** Like {@link append}, onto a sibling stream (resolved via `stream.at(path)`). */
  protected appendTo(path: string, ...input: EmittedInput<Contract>[]): Promise<StreamEvent[]> {
    return this.#appendStamped({ target: this.stream.at(path) }, input);
  }

  /**
   * Processor-scoped idempotency key: `<slug>/<key>`, plus `@<path>:<offset>`
   * when the append is a deterministic consequence of processing one event —
   * a redelivered batch then dedupes instead of double-appending. The path
   * makes fan-in safe: two same-slug processors on different streams
   * forwarding into one target can never collide. Omit `whileProcessing` for
   * state-derived appends and fold the deciding state into `key` instead
   * (e.g. a generation counter).
   */
  protected idempotencyKey(
    key: string,
    whileProcessing?: Pick<StreamEvent, "offset" | "path">,
  ): string {
    const base = `${this.contract.slug}/${key}`;
    if (whileProcessing === undefined) return base;
    return `${base}@${whileProcessing.path}:${whileProcessing.offset}`;
  }

  /**
   * The provenance stamp for one append lane. Always overwrites any
   * caller-supplied `source.processor`: the stamp describes THIS append, and
   * ancestry stays walkable through `whileProcessing` (and `crossPostedFrom`
   * for cross-post copies, which preserve the original stamp).
   */
  #processorStamp(whileProcessing?: Pick<StreamEvent, "offset" | "type">) {
    return {
      slug: this.contract.slug,
      version: this.contract.version,
      stream: { path: this.path, projectId: this.projectId },
      ...(whileProcessing === undefined
        ? {}
        : { whileProcessing: { offset: whileProcessing.offset, type: whileProcessing.type } }),
    };
  }

  #appendStamped(
    args: { target: Stream; whileProcessing?: Pick<StreamEvent, "offset" | "type"> },
    input: EmittedInput<Contract>[],
  ): Promise<StreamEvent[]> {
    const processor = this.#processorStamp(args.whileProcessing);
    const events = input.map((event) => {
      const built = this.#buildEmittedEvent(event) as StreamEventInput;
      return { ...built, source: { ...built.source, processor } };
    });
    // Home-stream appends feed the consume-own-append loop: the committed
    // offsets come back through this processor's own subscription, and
    // noteBatchIngested closes the sample. Sibling-stream appends (appendTo)
    // never loop back here, so they are not timed.
    if (args.target !== this.stream) return args.target.append(...events);
    const t0 = Date.now();
    return Promise.resolve(this.stream.append(...events)).then((committed) => {
      const maxCommittedOffset = committed.reduce((max, event) => Math.max(max, event.offset), 0);
      if (maxCommittedOffset > 0) {
        this.subscriberMetrics.noteAppendCommitted({ maxCommittedOffset, t0, atMs: Date.now() });
      }
      return committed;
    });
  }

  // Settle `waitUntilEvent` waiters whose predicate matches a just-delivered
  // event. Runs after the durable write + checkpoint advance, so `this.state` is
  // current when a waiter's promise resolves (the read-your-writes guarantee).
  #resolveEventWaiters(events: readonly StreamEvent[]): void {
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

  /**
   * The current reduced state, synchronously (the schema default until the first
   * load). Lets a host assemble its live state without an async hop.
   */
  get currentState(): ProcessorState<Contract> {
    return this.#getState();
  }

  /**
   * Whether `currentState` IS the fold rather than the schema default. Hosts
   * gate live-state assembly on it: assembling a cold processor's default would
   * push patches that wipe real facts to subscribers. True after a checkpoint
   * loads cleanly (or was found absent on a fresh processor), after any ingested
   * batch (the state then reflects the journal prefix), or via {@link markLoaded}.
   * A checkpoint DISCARDED at load (schema mismatch after a state-shape deploy)
   * leaves this false — the state is the default with a refold pending, exactly
   * what the gate exists to keep away from subscribers.
   */
  get isLoaded(): boolean {
    return this.#hasLoaded;
  }

  /**
   * The host's confirmation that the journal has been folded through head, for
   * the one case ingest can't cover: a clean catch-up that delivered ZERO
   * batches. Then whatever `currentState` is — including the schema default
   * over an empty journal — is by construction the fold.
   */
  markLoaded(): void {
    this.#hasLoaded = true;
  }

  /**
   * Observe reduced-state changes IN-PROCESS: the observer is a local function
   * (the host wires it to refresh its live-state engine), not a retained RPC
   * stub. Returns an unsubscribe.
   */
  observeStateChanges(
    observer: (snapshot: StreamProcessorSnapshot<ProcessorState<Contract>>) => void,
  ): () => void {
    this.#stateChangeObservers.add(observer);
    return () => void this.#stateChangeObservers.delete(observer);
  }

  #notifyStateChange(snapshot: StreamProcessorSnapshot<ProcessorState<Contract>>): void {
    for (const observer of [...this.#stateChangeObservers]) {
      try {
        observer(snapshot);
      } catch (error) {
        console.error("stream processor state-change observer failed", error);
      }
    }
  }

  // keepAliveWhile is fire-and-forget from the host's point of view (it only
  // keeps the runtime alive while the work runs), so this bridges the work's
  // result/failure back into a promise the batch loop can await.
  async #runKeepAliveBackedWork(work: () => Promise<unknown>): Promise<unknown> {
    if (this.#keepAliveWhile === undefined) return await work();

    return await new Promise<unknown>((resolve, reject) => {
      this.#keepAliveWhile!(async () => {
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

  async #loadState(): Promise<void> {
    this.#loaded ??= (async () => {
      await this.prepare();
      const snapshot = await this.#readState();
      if (snapshot === undefined) {
        // Fresh processor, no checkpoint: nothing has been observed yet, so
        // the schema default IS the fold of the (empty) delivered prefix.
        this.#state ??= this.contract.stateSchema.parse({}) as ProcessorState<Contract>;
        this.#hasLoaded = true;
        return;
      }
      // The checkpoint is a disposable CACHE of the fold (see
      // docs/domain-objects-and-stream-processors.md); the journal is the
      // authority. A snapshot that fails the current schema — the normal
      // aftermath of deploying a state-shape change — is a cache miss, not an
      // error: discard it and refold from offset 0. Wedging here would turn
      // every schema evolution into a permanently unresponsive processor
      // (snapshot() and ingest() rethrowing forever), with the recovery
      // machinery itself crash-looping on the parse.
      const parsed = this.contract.stateSchema.safeParse(snapshot.state);
      if (!parsed.success) {
        console.error(
          `stream processor "${this.contract.slug}" checkpoint no longer fits its state schema; discarding the cache and refolding from the journal`,
          parsed.error,
        );
        this.#state ??= this.contract.stateSchema.parse({}) as ProcessorState<Contract>;
        // Deliberately NOT loaded: the state is the schema default with a
        // refold pending — exactly what the isLoaded gate keeps away from
        // live-state subscribers. The refold flips it: ingest (a replayed
        // delivery or the host's catch-up), or the host's zero-batch
        // {@link markLoaded} confirmation.
        return;
      }
      this.#state = parsed.data as ProcessorState<Contract>;
      this.#checkpointOffset = snapshot.offset;
      this.#hasLoaded = true;
    })().catch((error: unknown) => {
      // Clear the memoized load so a later batch retries the snapshot read
      // instead of replaying this rejection forever.
      this.#loaded = undefined;
      throw error;
    });
    await this.#loaded;
  }

  #getState(): ProcessorState<Contract> {
    this.#state ??= this.contract.stateSchema.parse({}) as ProcessorState<Contract>;
    return this.#state;
  }
}
