import { RpcTarget } from "cloudflare:workers";
import type { z } from "zod";
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

export type StreamProcessorContract<Self> = {
  slug: string;
  stateSchema: z.ZodType;
  initialState?: unknown;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  reduce?: (args: {
    contract: Self;
    state: ProcessorState<Self>;
    event: ConsumedEvent<Self>;
  }) => ProcessorState<Self> | null | undefined;
};

export type StreamProcessorDeps<IterateContext> = {
  iterateContext: IterateContext;
  keepAliveWhile?: <Result>(work: () => Promise<Result>) => void;
};

export type ReducedEvent<Contract> = {
  event: DeepReadonly<ConsumedEvent<Contract>>;
  previousState: DeepReadonly<ProcessorState<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
};

export type ReduceArgs<Contract> = {
  event: DeepReadonly<ConsumedEvent<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
};

export type ProcessEventArgs<Contract> = ReducedEvent<Contract> & {
  streamMaxOffset: number;
  blockProcessorWhile: <Result>(work: () => Promise<Result>) => void;
  runInBackground: <Result>(work: () => Promise<Result>) => void;
};

export type ProcessEventsArgs<Contract> = {
  events: readonly ReducedEvent<Contract>[];
  previousState: DeepReadonly<ProcessorState<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
  streamMaxOffset: number;
};

export type StreamProcessorSnapshot<State> = {
  offset: number;
  state: State;
};

export type SyncSqlStorage = {
  exec<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): Row[] };
};

export type StreamProcessorConstructorArgs<
  Contract extends StreamProcessorContract<Contract>,
  Deps extends StreamProcessorDeps<unknown>,
> = {
  contract: Contract;
  deps: Deps;
  processorKey?: string;
  sql?: SyncSqlStorage;
};

export abstract class StreamProcessor<
  Contract extends StreamProcessorContract<Contract>,
  Deps extends StreamProcessorDeps<unknown>,
> extends RpcTarget {
  readonly contract: Contract;
  protected readonly ctx: Deps["iterateContext"];
  protected readonly deps: Deps;
  protected readonly processorKey: string;
  protected readonly sql: SyncSqlStorage | undefined;

  #checkpointOffset = 0;
  #processing: Promise<void> = Promise.resolve();
  #state: ProcessorState<Contract>;
  #blockingWork: Promise<unknown>[] = [];

  protected constructor(args: StreamProcessorConstructorArgs<Contract, Deps>) {
    super();
    this.contract = args.contract;
    this.ctx = args.deps.iterateContext;
    this.deps = args.deps;
    this.processorKey = args.processorKey ?? args.contract.slug;
    this.sql = args.sql;

    this.#ensureStorageSchema();
    const snapshot = this.#loadSnapshot();
    this.#state = snapshot?.state ?? getInitialProcessorState(args.contract);
    this.#checkpointOffset = snapshot?.offset ?? 0;
  }

  get state(): DeepReadonly<ProcessorState<Contract>> {
    return this.#state as DeepReadonly<ProcessorState<Contract>>;
  }

  get checkpointOffset(): number {
    return this.#checkpointOffset;
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
    return this.contract.reduce?.({
      contract: this.contract,
      event: args.event as ConsumedEvent<Contract>,
      state: args.state as ProcessorState<Contract>,
    });
  }

  protected processEvents(args: ProcessEventsArgs<Contract>): void {
    for (const reducedEvent of args.events) {
      this.processEvent({
        ...reducedEvent,
        streamMaxOffset: args.streamMaxOffset,
        blockProcessorWhile: (work) => this.#blockProcessorWhile(work),
        runInBackground: (work) => this.#runInBackground(work),
      });
    }
  }

  protected processEvent(_args: ProcessEventArgs<Contract>): void {}

  async #processEventBatch(args: {
    events: readonly StreamEvent[];
    streamMaxOffset: number;
  }): Promise<void> {
    for (const rawEvent of args.events) {
      if (rawEvent.offset <= this.#checkpointOffset) continue;

      const previousState = this.#state;
      const reduction = runProcessorReduce({
        event: rawEvent,
        processor: { contract: this.contract },
        state: previousState,
      });

      if (reduction === undefined) {
        this.#checkpointOffset = rawEvent.offset;
        this.#saveSnapshot();
        continue;
      }

      const reducedEvent: ReducedEvent<Contract> = {
        event: reduction.event as DeepReadonly<ConsumedEvent<Contract>>,
        previousState: previousState as DeepReadonly<ProcessorState<Contract>>,
        state: reduction.state as DeepReadonly<ProcessorState<Contract>>,
      };

      this.#blockingWork = [];
      this.processEvents({
        events: [reducedEvent],
        previousState: reducedEvent.previousState,
        state: reducedEvent.state,
        streamMaxOffset: args.streamMaxOffset,
      });

      await this.#awaitBlockingWork();

      this.#state = reduction.state;
      this.#checkpointOffset = rawEvent.offset;
      this.#saveSnapshot();
    }
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
    if (this.deps.keepAliveWhile === undefined) return await work();

    return await new Promise<Result>((resolve, reject) => {
      this.deps.keepAliveWhile!(async () => {
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

  #ensureStorageSchema(): void {
    this.sql?.exec(`
      create table if not exists stream_processor_snapshots (
        processor_key text primary key,
        state_json text not null,
        offset integer not null
      )
    `);
  }

  #loadSnapshot(): StreamProcessorSnapshot<ProcessorState<Contract>> | undefined {
    const row = this.sql
      ?.exec<{ stateJson: string; offset: number }>(
        `
          select state_json as stateJson, offset
          from stream_processor_snapshots
          where processor_key = ?
          limit 1
        `,
        this.processorKey,
      )
      .toArray()[0];

    if (row === undefined) return undefined;
    return {
      offset: Number(row.offset),
      state: this.contract.stateSchema.parse(JSON.parse(row.stateJson)) as ProcessorState<Contract>,
    };
  }

  #saveSnapshot(): void {
    this.sql?.exec(
      `
        insert into stream_processor_snapshots (processor_key, state_json, offset)
        values (?, ?, ?)
        on conflict(processor_key) do update set
          state_json = excluded.state_json,
          offset = excluded.offset
      `,
      this.processorKey,
      JSON.stringify(this.#state),
      this.#checkpointOffset,
    );
  }
}
