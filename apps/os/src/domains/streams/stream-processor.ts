import { RpcTarget } from "capnweb";
import type { z } from "zod";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import type { ProcessorRuntimeState, ProcessorSnapshot } from "./rpc-types.ts";
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
  stateSchema: z.ZodType;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  emits: readonly string[];
  parseEvent(event: StreamEvent): StreamEvent;
};

/**
 * Host-provided constructor dependencies shared by every processor:
 * the stream append capability, optional checkpoint storage
 * (`readState`/`writeState`), and an optional `keepAliveWhile` hook for hosts
 * whose runtime would otherwise shut down while async work is in flight (e.g.
 * a Durable Object).
 */
export type StreamProcessorBaseDeps<Contract> = {
  stream: Stream;
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
    /** Append one or more events listed in `contract.emits`. */
    append: (...input: EmittedInput<Contract>[]) => Promise<StreamEvent[]>;
    streamMaxOffset: number;
    /**
     * The offset this batch will checkpoint through once all blocking work
     * completes — the last event offset in the batch, not this event's offset.
     */
    checkpointOffset: number;
  };

/** What `processEventBatch` receives: the whole delivered batch plus its reductions. */
type ProcessEventBatchArgs<Contract> = SideEffectHelpers & {
  /** Append one or more events listed in `contract.emits`. */
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

/** Callback registered via `onStateChange`; may be a remote RPC stub. */
type StateChangeCallback<State> = (snapshot: StreamProcessorSnapshot<State>) => unknown;
/** A state-change callback after retention: disposal releases the duplicated stub. */
type RetainedStateChangeCallback<State> = StateChangeCallback<State> &
  Disposable & {
    onRpcBroken?(callback: (error: unknown) => void): void;
  };

/**
 * One registered `onStateChange` subscriber. `deliver` pushes a checkpoint
 * snapshot into the retained callback and observes the result; `drop` removes
 * the subscription and releases the retained stub. All removal paths (explicit
 * unsubscribe, sync throw, async delivery rejection, transport brokenness) go
 * through `drop`, so membership in the subscription set is the single source
 * of truth that `ping()` reports to clients.
 */
type StateChangeSubscription<State> = {
  deliver(snapshot: StreamProcessorSnapshot<State>): void;
  drop(): void;
};

/**
 * In-process handle returned by `StreamProcessor.onStateChange`.
 * `unsubscribe()` (or disposal) drops the subscription; `isLive()` backs the
 * RPC facade's `ping()`.
 */
export type StreamProcessorStateSubscriptionHandle = Disposable & {
  isLive(): boolean;
  unsubscribe(): void;
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
 * Subclasses override up to three hooks:
 *
 * - `reduce` — pure projection of one consumed event into the next state
 * - `processEvent` — synchronous per-event side effects; what most processors
 *   implement
 * - `processEventBatch` — batch-level side effects (e.g. one SQLite
 *   transaction); the default implementation calls `processEvent` once per
 *   reduced event
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
  protected readonly deps: Deps;

  #checkpointOffset = 0;
  // eslint-disable-next-line no-unused-private-class-members -- oxlint false positive: #loadState reads and assigns this via ??=.
  #loaded: Promise<void> | undefined;
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
  readonly #stateChangeSubscriptions = new Set<StateChangeSubscription<ProcessorState<Contract>>>();
  readonly #eventWaiters = new Set<EventWaiter>();

  constructor(args: StreamProcessorConstructorArgs<Contract, Deps>) {
    super();
    // Base deps are destructured out; everything else is the subclass's Deps.
    const { stream, keepAliveWhile, readState, writeState, ...deps } = args;
    this.stream = stream;
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

  async onStateChange(
    cb: StateChangeCallback<ProcessorState<Contract>>,
  ): Promise<StreamProcessorStateSubscriptionHandle> {
    await this.#loadState();
    const retained = retainStateChangeCallback(cb);
    const subscriptions = this.#stateChangeSubscriptions;
    const subscription: StateChangeSubscription<ProcessorState<Contract>> = {
      deliver(snapshot) {
        let result: unknown;
        try {
          result = retained(snapshot);
        } catch (error) {
          // A disposed/broken stub can throw synchronously at call time.
          subscription.drop();
          throw error;
        }
        if (isThenable(result)) {
          // Delivery stays fire-and-forget, but the rejection must be
          // observed: a dead remote rejects every push, and swallowing that
          // would keep the dead callback registered (and its ping() lying)
          // forever. State pushes coalesce to one per checkpointed batch, so
          // the resolve frame per push is affordable — unlike the per-event
          // stream fast path (see retainProcessEventBatch).
          void Promise.resolve(result)
            .then(undefined, (error: unknown) => {
              if (!subscriptions.has(subscription)) return;
              console.error(
                "stream processor state change delivery failed; dropping subscription",
                error,
              );
              subscription.drop();
            })
            .finally(() => disposeIgnoredRpcResult(result));
          return;
        }
        disposeIgnoredRpcResult(result);
      },
      drop() {
        if (!subscriptions.delete(subscription)) return;
        retained[Symbol.dispose]();
      },
    };
    subscriptions.add(subscription);
    // Transport-level death signal, best-effort (see retainStateChangeCallback
    // on why registration is defensive): the delivery-rejection path above is
    // the guaranteed cleanup; this one is just earlier when available.
    retained.onRpcBroken?.(() => subscription.drop());

    // The initial push: current state IS the first paint. A synchronously
    // failing callback never becomes a subscription (deliver dropped it).
    subscription.deliver({ offset: this.#checkpointOffset, state: this.#getState() });

    return {
      isLive: () => subscriptions.has(subscription),
      unsubscribe: () => subscription.drop(),
      [Symbol.dispose]: () => subscription.drop(),
    };
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
  protected buildEmittedEvent(event: EmittedInput<Contract>): EmittedInput<Contract> {
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
      this.processEvent({
        ...reducedEvent,
        streamMaxOffset: args.streamMaxOffset,
        checkpointOffset: args.checkpointOffset,
        blockProcessorWhile: args.blockProcessorWhile,
        runInBackground: args.runInBackground,
        append: args.append,
      });
    }
  }

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
      await this.processEventBatch({
        events,
        reducedEvents,
        previousState,
        state,
        streamMaxOffset: args.streamMaxOffset,
        checkpointOffset,
        append: (...input) => this.#appendEmitted(...input),
        blockProcessorWhile: (work) => {
          blockingWork.push(this.#runKeepAliveBackedWork(work));
        },
        runInBackground: (work) => this.runInBackground(work),
      });
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
      this.runInBackground(() =>
        this.stream.append({
          type: "events.iterate.com/stream/error-occurred",
          idempotencyKey: `processor-event-parse-failed:${this.contract.slug}:${event.offset}`,
          payload: {
            message,
            error: { name: error.name, message: error.message },
          },
        }),
      );
    }
  }

  #appendEmitted(...input: EmittedInput<Contract>[]): Promise<StreamEvent[]> {
    const events = input.map((event) => this.buildEmittedEvent(event) as StreamEventInput);
    return this.stream.append(...events);
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

  #notifyStateChange(snapshot: StreamProcessorSnapshot<ProcessorState<Contract>>): void {
    for (const subscription of [...this.#stateChangeSubscriptions]) {
      try {
        subscription.deliver(snapshot);
      } catch (error) {
        // deliver() already dropped the subscription on a synchronous throw.
        console.error("stream processor state change callback failed", error);
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
        this.#state ??= this.contract.stateSchema.parse({}) as ProcessorState<Contract>;
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
        return;
      }
      this.#state = parsed.data as ProcessorState<Contract>;
      this.#checkpointOffset = snapshot.offset;
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

function retainStateChangeCallback<State>(
  cb: StateChangeCallback<State>,
): RetainedStateChangeCallback<State> {
  const retainable = cb as StateChangeCallback<State> &
    Partial<Disposable> & {
      dup?(): RetainedStateChangeCallback<State>;
      onRpcBroken?(callback: (error: unknown) => void): void;
    };
  const retained = retainable.dup?.() ?? retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  const wrapped: RetainedStateChangeCallback<State> = Object.assign(
    (snapshot: StreamProcessorSnapshot<State>) => retained(snapshot),
    {
      [Symbol.dispose]() {
        dispose?.();
      },
    },
  );
  // Same defensive wiring as retainProcessEventBatch (stream-connections.ts):
  // Cap'n Web stubs intercept onRpcBroken locally but expose no own property
  // descriptors, and a Workers RPC property access can fabricate a pipelined
  // method that rejects at call time — so wire whatever the stub claims to
  // have and swallow registration failures.
  const onRpcBroken = retained.onRpcBroken;
  if (typeof onRpcBroken === "function") {
    wrapped.onRpcBroken = (brokenCallback: (error: unknown) => void) => {
      try {
        const result = onRpcBroken.call(retained, brokenCallback) as unknown;
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => {
            // Pipelined fake: the remote has no onRpcBroken method.
          });
        }
      } catch {
        // Registration is best-effort.
      }
    };
  }
  return wrapped;
}

/** Shared thenable probe for RPC results (stubs are thenable-shaped). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Dispose an ignored RPC call result. Reading a Cap'n Web / Workers RPC method
 * yields a disposable stub even when the caller ignores the value; dropping it
 * without disposal leaks the remote reference. Exported so the stream
 * connection code shares one implementation.
 */
export function disposeIgnoredRpcResult(result: unknown): void {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    Symbol.dispose in result
  ) {
    (result as Disposable)[Symbol.dispose]();
  }
}
