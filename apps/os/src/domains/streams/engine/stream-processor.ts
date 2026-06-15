import { RpcTarget } from "capnweb";
import type { z } from "zod";
import type { ProcessorStream } from "./types.ts";
import type { StreamEvent } from "./shared/event.ts";
import {
  assertObjectProcessorState,
  getConsumedEventDefinition,
  getEventSchema,
  getInitialProcessorState,
  type ConsumedEvent,
  type EventCatalog,
  type ProcessorState,
} from "./shared/stream-processors.ts";

/**
 * Platform capabilities the host hands every processor, exposed to subclasses
 * as `this.ctx`. Today that is just the stream append surface; richer hosts can
 * substitute their own context type via the class's `IterateContext` parameter.
 */
export type StreamProcessorIterateContext = {
  stream: ProcessorStream;
};

/**
 * The structural slice of a processor contract that the class needs. Contracts
 * built with `defineProcessorContract(...)` satisfy this; the full contract
 * type flows through the `Contract` type parameter so event/state inference
 * reaches the hooks.
 */
export type StreamProcessorContract = {
  slug: string;
  stateSchema: z.ZodType;
  initialState?: unknown;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
};

/**
 * Host-provided constructor dependencies shared by every processor:
 * the iterate context, optional checkpoint storage (`readState`/`writeState`),
 * and an optional `keepAliveWhile` hook for hosts whose runtime would otherwise
 * shut down while async work is in flight (e.g. a Durable Object).
 */
export type StreamProcessorBaseDeps<Contract, IterateContext> = {
  iterateContext: IterateContext;
  keepAliveWhile?: (work: () => Promise<unknown>) => void;
} & StreamProcessorStateStorage<ProcessorState<Contract>>;

// These arg shapes are intentionally not exported: subclass overrides annotate their
// args as `Parameters<StreamProcessor<Contract>["method"]>[0]` (enforced by the
// `iterate/stream-processor-override-args` lint rule) so there is exactly one spelling.
//
// State and events are passed by reference. Hooks must treat them as immutable:
// `reduce` returns a new state object instead of mutating its input.
type ReducedEvent<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};

type ReduceArgs<Contract> = {
  event: ConsumedEvent<Contract>;
  state: ProcessorState<Contract>;
};

type SideEffectHelpers = {
  /** Hold the checkpoint (and the next batch) until this work completes. */
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  /** Fire-and-forget work; failures are caught and logged. */
  runInBackground: (work: () => Promise<unknown>) => void;
};

type ProcessEventArgs<Contract> = ReducedEvent<Contract> &
  SideEffectHelpers & {
    streamMaxOffset: number;
    /**
     * The offset this batch will checkpoint through once all blocking work
     * completes — the last event offset in the batch, not this event's offset.
     */
    checkpointOffset: number;
  };

type ProcessEventBatchArgs<Contract> = SideEffectHelpers & {
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
 */
export type StreamProcessorSnapshot<State> = {
  offset: number;
  state: State;
};

type MaybePromise<T> = T | Promise<T>;
type StateChangeCallback<State> = (state: State) => unknown;
type RetainedStateChangeCallback<State> = StateChangeCallback<State> & Disposable;
type RetainableStateChangeCallback<State> = StateChangeCallback<State> &
  Partial<Disposable> & {
    dup?(): RetainedStateChangeCallback<State>;
  };
export type StreamProcessorStateUnsubscribe = (() => void) & Disposable;

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
 * into one object, e.g. `new BrowserRawEventsProcessor({ iterateContext, sql,
 * readState, writeState })`.
 */
export type StreamProcessorConstructorArgs<
  Contract extends StreamProcessorContract,
  Deps extends object,
  IterateContext = StreamProcessorIterateContext,
> = StreamProcessorBaseDeps<Contract, IterateContext> & Deps;

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
// Extending RpcTarget is a convenience for exposing processors directly over Cap'n Web.
// The processing model should not fundamentally depend on RPC; we may remove this base
// class dependency once processor hosting has settled.
export abstract class StreamProcessor<
  Contract extends StreamProcessorContract,
  Deps extends object = object,
  IterateContext = StreamProcessorIterateContext,
> extends RpcTarget {
  abstract readonly contract: Contract;
  protected readonly ctx: IterateContext;
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
  readonly #stateChangeCallbacks = new Set<RetainedStateChangeCallback<ProcessorState<Contract>>>();

  constructor(args: StreamProcessorConstructorArgs<Contract, Deps, IterateContext>) {
    super();
    // Base deps are destructured out; everything else is the subclass's Deps.
    const { iterateContext, keepAliveWhile, readState, writeState, ...deps } = args;
    this.ctx = iterateContext;
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
  ): Promise<StreamProcessorStateUnsubscribe> {
    await this.#loadState();
    const retained = retainStateChangeCallback(cb);
    this.#stateChangeCallbacks.add(retained);

    let disposed = false;
    const unsubscribe = Object.assign(
      () => {
        if (disposed) return;
        disposed = true;
        this.#stateChangeCallbacks.delete(retained);
        retained[Symbol.dispose]();
      },
      { [Symbol.dispose]: () => unsubscribe() },
    );

    try {
      this.#callStateChangeCallback(retained, this.#getState());
    } catch (error) {
      unsubscribe();
      throw error;
    }

    return unsubscribe;
  }

  /**
   * One-time async setup, run before the checkpoint is first read — whether
   * that happens via `snapshot()` or the first ingested batch. Override for
   * work that can invalidate the stored checkpoint, such as schema migrations
   * that reset projection tables, so it always lands before the resume cursor
   * is decided. Failures reject the triggering call and retry on the next one.
   */
  protected async prepare(): Promise<void> {}

  /**
   * Pure projection of one consumed event into the next state. Defaults to
   * identity; returning `null`/`undefined` also keeps the current state.
   */
  protected reduce(args: ReduceArgs<Contract>): ProcessorState<Contract> | null | undefined {
    return args.state;
  }

  /** Synchronous per-event side-effect hook, called by the default `processEventBatch`. */
  protected processEvent(_args: ProcessEventArgs<Contract>): void {}

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
      });
    }
  }

  /**
   * Reduce one raw stream event against explicit state, without touching the
   * processor's own state or checkpoint. Returns `undefined` for events this
   * processor does not consume. Used by the batch loop and by processors that
   * are also run inline with externally-owned state (the stream core).
   */
  protected reduceRawEvent(args: {
    event: StreamEvent;
    state: ProcessorState<Contract>;
  }): ReducedEvent<Contract> | undefined {
    const eventDefinition = getConsumedEventDefinition({
      contract: this.contract,
      eventType: args.event.type,
    });
    if (eventDefinition === undefined) return undefined;

    // Rebuilding the parser from the catalog key and payload schema keeps replay
    // and live delivery on the same validation path.
    const event = getEventSchema({
      type: args.event.type,
      payloadSchema: eventDefinition.payloadSchema,
    }).parse(args.event) as ConsumedEvent<Contract>;

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

    for (const event of args.events) {
      if (event.offset <= checkpointOffset) continue;
      events.push(event);
      checkpointOffset = event.offset;

      const reduction = this.reduceRawEvent({ event, state });
      if (reduction === undefined) continue;
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
    if (!Object.is(previousState, state)) this.#notifyStateChange(state);
  }

  #notifyStateChange(state: ProcessorState<Contract>): void {
    for (const callback of [...this.#stateChangeCallbacks]) {
      try {
        this.#callStateChangeCallback(callback, state);
      } catch (error) {
        this.#stateChangeCallbacks.delete(callback);
        callback[Symbol.dispose]();
        console.error("stream processor state change callback failed", error);
      }
    }
  }

  #callStateChangeCallback(
    callback: StateChangeCallback<ProcessorState<Contract>>,
    state: ProcessorState<Contract>,
  ): void {
    disposeIgnoredRpcResult(callback(state));
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
        this.#state ??= getInitialProcessorState(this.contract);
        return;
      }
      this.#state = this.contract.stateSchema.parse(snapshot.state) as ProcessorState<Contract>;
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
    this.#state ??= getInitialProcessorState(this.contract);
    return this.#state;
  }
}

function retainStateChangeCallback<State>(
  cb: StateChangeCallback<State>,
): RetainedStateChangeCallback<State> {
  const retainable = cb as RetainableStateChangeCallback<State>;
  const retained = retainable.dup?.() ?? retainable;
  const dispose = retained[Symbol.dispose]?.bind(retained);
  return Object.assign((state: State) => retained(state), {
    [Symbol.dispose]() {
      dispose?.();
    },
  });
}

function disposeIgnoredRpcResult(result: unknown): void {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    Symbol.dispose in result
  ) {
    (result as Disposable)[Symbol.dispose]();
  }
}
