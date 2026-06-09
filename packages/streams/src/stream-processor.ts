import { RpcTarget } from "capnweb";
import type { z } from "zod";
import type { ProcessorStream } from "./processor-runner.ts";
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

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type StreamProcessorIterateContext = {
  stream: ProcessorStream;
};

export type StreamProcessorContract = {
  slug: string;
  stateSchema: z.ZodType;
  initialState?: unknown;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
};

type ProcessorEvent<Contract> = ConsumedEvent<Contract>;

export type StreamProcessorBaseDeps<Contract, IterateContext> = {
  iterateContext: IterateContext;
  keepAliveWhile?: (work: () => Promise<unknown>) => void;
} & StreamProcessorStateStorage<ProcessorState<Contract>>;

// These arg shapes are intentionally not exported: subclass overrides annotate their
// args as `Parameters<StreamProcessor<Contract>["method"]>[0]` (enforced by the
// `iterate/stream-processor-override-args` lint rule) so there is exactly one spelling.
type ReducedEvent<Contract> = {
  event: DeepReadonly<ProcessorEvent<Contract>>;
  previousState: DeepReadonly<ProcessorState<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
};

type ReduceArgs<Contract> = {
  event: DeepReadonly<ProcessorEvent<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
};

type ProcessEventArgs<Contract> = ReducedEvent<Contract> & {
  streamMaxOffset: number;
  /**
   * The offset this batch will checkpoint through once all blocking work
   * completes — the last event offset in the batch, not this event's offset.
   */
  checkpointOffset: number;
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  runInBackground: (work: () => Promise<unknown>) => void;
};

export type StreamProcessorSnapshot<State> = {
  offset: number;
  state: State;
};

type MaybePromise<T> = T | Promise<T>;

export type StreamProcessorStateStorage<State> = {
  readState?: () => MaybePromise<StreamProcessorSnapshot<State> | undefined>;
  writeState?: (snapshot: StreamProcessorSnapshot<State>) => MaybePromise<void>;
};

export type StreamProcessorConstructorArgs<
  Contract extends StreamProcessorContract,
  Deps extends object,
  IterateContext = StreamProcessorIterateContext,
> = {
  processorKey?: string;
} & StreamProcessorBaseDeps<Contract, IterateContext> &
  Deps;

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
  readonly #processorKey: string | undefined;

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

  constructor(args: StreamProcessorConstructorArgs<Contract, Deps, IterateContext>) {
    super();
    const { iterateContext, keepAliveWhile, processorKey, readState, writeState, ...deps } = args;
    this.ctx = iterateContext;
    this.deps = deps as Deps;
    this.#processorKey = processorKey;
    this.#keepAliveWhile = keepAliveWhile;
    this.#readState = readState ?? (() => this.#memorySnapshot);
    this.#writeState =
      writeState ??
      ((snapshot) => {
        this.#memorySnapshot = snapshot;
      });
  }

  protected get processorKey(): string {
    return this.#processorKey ?? this.contract.slug;
  }

  get state(): DeepReadonly<ProcessorState<Contract>> {
    return this.#getState() as DeepReadonly<ProcessorState<Contract>>;
  }

  get checkpointOffset(): number {
    return this.#checkpointOffset;
  }

  async snapshot(): Promise<StreamProcessorSnapshot<DeepReadonly<ProcessorState<Contract>>>> {
    await this.#loadState();
    return {
      offset: this.#checkpointOffset,
      state: this.state,
    };
  }

  async processEventBatch(args: {
    events: readonly StreamEvent[];
    streamMaxOffset: number;
  }): Promise<void> {
    const next = this.#processing.then(() => this.#processEventBatch(args));
    this.#processing = next.catch(() => undefined);
    return await next;
  }

  protected reduce(args: ReduceArgs<Contract>): ProcessorState<Contract> | null | undefined {
    return args.state as ProcessorState<Contract>;
  }

  reduceEvent(args: {
    event: StreamEvent;
    state: ProcessorState<Contract>;
  }): ProcessorState<Contract> {
    return (this.#reduce(args)?.state ?? args.state) as ProcessorState<Contract>;
  }

  #reduce(args: {
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
    }).parse(args.event) as DeepReadonly<ProcessorEvent<Contract>>;

    const previousState = args.state as DeepReadonly<ProcessorState<Contract>>;
    const state = this.reduce({ event, state: previousState }) ?? previousState;
    assertObjectProcessorState({ processorSlug: this.contract.slug, value: state });

    return {
      event,
      previousState,
      state: state as DeepReadonly<ProcessorState<Contract>>,
    };
  }

  protected processEvent(_args: ProcessEventArgs<Contract>): void {}

  processReducedEvent(
    args: Omit<ReducedEvent<Contract>, "event"> & {
      event: StreamEvent;
      checkpointOffset?: number;
      streamMaxOffset?: number;
    },
  ): void {
    this.processEvent({
      ...args,
      event: args.event as DeepReadonly<ProcessorEvent<Contract>>,
      checkpointOffset: args.checkpointOffset ?? args.event.offset,
      streamMaxOffset: args.streamMaxOffset ?? args.event.offset,
      blockProcessorWhile: () => {
        throw new Error(
          "blockProcessorWhile is unavailable when processing a reduced event inline",
        );
      },
      runInBackground: (work) => this.#runInBackground(work),
    });
  }

  async #processEventBatch(args: {
    events: readonly StreamEvent[];
    streamMaxOffset: number;
  }): Promise<void> {
    await this.#loadState();

    const batchPreviousState = this.#getState();
    let nextState = batchPreviousState;
    let checkpointOffset = this.#checkpointOffset;
    const reducedEvents: ReducedEvent<Contract>[] = [];

    for (const rawEvent of args.events) {
      if (rawEvent.offset <= checkpointOffset) continue;

      const reduction = this.#reduce({
        event: rawEvent,
        state: nextState,
      });
      checkpointOffset = rawEvent.offset;

      if (reduction === undefined) continue;

      reducedEvents.push(reduction);
      nextState = reduction.state as ProcessorState<Contract>;
    }

    if (checkpointOffset === this.#checkpointOffset) return;

    if (reducedEvents.length > 0) {
      const blockingWork: Promise<unknown>[] = [];
      try {
        for (const reducedEvent of reducedEvents) {
          this.processEvent({
            ...reducedEvent,
            checkpointOffset,
            streamMaxOffset: args.streamMaxOffset,
            blockProcessorWhile: (work) => {
              blockingWork.push(this.#runKeepAliveBackedWork(work));
            },
            runInBackground: (work) => this.#runInBackground(work),
          });
        }
      } catch (error) {
        // A processEvent throw fails the batch, but work already registered for
        // earlier events must still be settled so it cannot reject unobserved.
        await Promise.allSettled(blockingWork);
        throw error;
      }

      await Promise.all(blockingWork);
    }

    this.#state = nextState;
    this.#checkpointOffset = checkpointOffset;
    await this.#saveSnapshot();
  }

  #runInBackground(work: () => Promise<unknown>): void {
    this.#runKeepAliveBackedWork(work).catch((error: unknown) => {
      console.error("stream processor background work failed", error);
    });
  }

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

  async #saveSnapshot(): Promise<void> {
    await this.#writeState({
      offset: this.#checkpointOffset,
      state: this.#getState(),
    });
  }
}
