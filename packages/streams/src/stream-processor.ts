import { RpcTarget } from "capnweb";
import type { z } from "zod";
import type { ProcessorStream } from "./processor-runner.ts";
import type { StreamEvent } from "./shared/event.ts";
import {
  getInitialProcessorState,
  runProcessorReduce,
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

export type StreamProcessorContract<Self> = {
  slug: string;
  stateSchema: z.ZodType;
  initialState?: unknown;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
};

type ProcessorEvent<Contract> = Contract extends { consumes: readonly string[] }
  ? "*" extends Contract["consumes"][number]
    ? StreamEvent
    : ConsumedEvent<Contract>
  : ConsumedEvent<Contract>;

export type StreamProcessorBaseDeps<Contract, IterateContext> = {
  iterateContext: IterateContext;
  keepAliveWhile?: <Result>(work: () => Promise<Result>) => void;
} & StreamProcessorStateStorage<ProcessorState<Contract>>;

export type ReducedEvent<Contract> = {
  event: DeepReadonly<ProcessorEvent<Contract>>;
  previousState: DeepReadonly<ProcessorState<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
};

export type ReduceArgs<Contract> = {
  event: ProcessorEvent<Contract>;
  state: ProcessorState<Contract>;
};

export type ProcessEventArgs<Contract> = ReducedEvent<Contract> & {
  streamMaxOffset: number;
  checkpointOffset: number;
  blockProcessorWhile: <Result>(work: () => Promise<Result>) => void;
  runInBackground: <Result>(work: () => Promise<Result>) => void;
};

export type ProcessEventsArgs<Contract> = {
  events: readonly ReducedEvent<Contract>[];
  previousState: DeepReadonly<ProcessorState<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
  checkpointOffset: number;
  streamMaxOffset: number;
  blockProcessorWhile: <Result>(work: () => Promise<Result>) => void;
  runInBackground: <Result>(work: () => Promise<Result>) => void;
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
  Contract extends StreamProcessorContract<Contract>,
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
  Contract extends StreamProcessorContract<Contract>,
  Deps extends object = object,
  IterateContext = StreamProcessorIterateContext,
> extends RpcTarget {
  abstract readonly contract: Contract;
  protected readonly ctx: IterateContext;
  protected readonly deps: Deps;
  readonly #processorKey: string | undefined;

  #checkpointOffset = 0;
  #loaded: Promise<void> | undefined;
  #processing: Promise<void> = Promise.resolve();
  #state: ProcessorState<Contract> | undefined;
  #blockingWork: Promise<unknown>[] = [];
  #memorySnapshot: StreamProcessorSnapshot<ProcessorState<Contract>> | undefined;
  readonly #keepAliveWhile: (<Result>(work: () => Promise<Result>) => void) | undefined;
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
    return args.state;
  }

  #reduce(args: {
    event: StreamEvent;
    state: ProcessorState<Contract>;
  }): ReturnType<typeof runProcessorReduce<Contract>> {
    return runProcessorReduce({
      event: args.event,
      processor: {
        contract: {
          ...this.contract,
          reduce: ({
            state,
            event,
          }: {
            state: ProcessorState<Contract>;
            event: ConsumedEvent<Contract>;
          }) =>
            this.reduce({
              event: event as ProcessorEvent<Contract>,
              state,
            }),
        },
      },
      state: args.state,
    });
  }

  protected processEvents(args: ProcessEventsArgs<Contract>): void {
    for (const reducedEvent of args.events) {
      this.processEvent({
        ...reducedEvent,
        checkpointOffset: args.checkpointOffset,
        streamMaxOffset: args.streamMaxOffset,
        blockProcessorWhile: args.blockProcessorWhile,
        runInBackground: args.runInBackground,
      });
    }
  }

  protected processEvent(_args: ProcessEventArgs<Contract>): void {}

  processReducedEvent(
    args: ReducedEvent<Contract> & {
      checkpointOffset?: number;
      streamMaxOffset?: number;
    },
  ): void {
    this.processEvent({
      ...args,
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

      reducedEvents.push({
        event: reduction.event as DeepReadonly<ProcessorEvent<Contract>>,
        previousState: nextState as DeepReadonly<ProcessorState<Contract>>,
        state: reduction.state as DeepReadonly<ProcessorState<Contract>>,
      });
      nextState = reduction.state;
    }

    if (checkpointOffset === this.#checkpointOffset) return;

    if (reducedEvents.length > 0) {
      this.#blockingWork = [];
      this.processEvents({
        events: reducedEvents,
        previousState: batchPreviousState as DeepReadonly<ProcessorState<Contract>>,
        state: nextState as DeepReadonly<ProcessorState<Contract>>,
        checkpointOffset,
        streamMaxOffset: args.streamMaxOffset,
        blockProcessorWhile: (work) => this.#blockProcessorWhile(work),
        runInBackground: (work) => this.#runInBackground(work),
      });

      await this.#awaitBlockingWork();
    }

    this.#state = nextState;
    this.#checkpointOffset = checkpointOffset;
    await this.#saveSnapshot();
  }

  #blockProcessorWhile<Result>(work: () => Promise<Result>): void {
    this.#blockingWork.push(this.#runKeepAliveBackedWork(work));
  }

  #runInBackground<Result>(work: () => Promise<Result>): void {
    this.#runKeepAliveBackedWork(work).catch((error: unknown) => {
      console.error("stream processor background work failed", error);
    });
  }

  async #runKeepAliveBackedWork<Result>(work: () => Promise<Result>): Promise<Result> {
    if (this.#keepAliveWhile === undefined) return await work();

    return await new Promise<Result>((resolve, reject) => {
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

  async #awaitBlockingWork(): Promise<void> {
    if (this.#blockingWork.length === 0) return;
    await Promise.all(this.#blockingWork);
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
    })();
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
