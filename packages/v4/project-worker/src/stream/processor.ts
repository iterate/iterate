// A processor is a pure author class driven by ProcessorEngine. The engine owns the serial
// delivery chain, checkpoint, durable replay, version re-reduce and live-state publication.
// Push ranges prove contiguous scans: `(after, through]`. Durable events can be replayed from the
// log; ephemerals are push-only and never cause a checkpoint write.

import type { z } from "zod";
import { reportIssue } from "../lib/errors.ts";
import { LiveState } from "./live-state.ts";
import type { ReduceCheckpointStore } from "./reduce-checkpoint.ts";
import type { StreamEvent, StreamEventInput } from "./events.ts";

export type EventDefinition = { description?: string; payloadSchema: z.ZodType };

export type ProcessorContract<State = unknown> = {
  slug: string;
  /** Bumping this re-reduces state from offset zero without rerunning side effects. */
  version: string;
  description?: string;
  /** `*` consumes every durable event; ephemerals need their type named explicitly. */
  consumes: readonly string[];
  /** Event types this processor may append. */
  emits: readonly string[];
  initialState: () => State;
};

export type ProcessorStream = {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]> | StreamEvent[];
  read(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number; atHead: boolean }>;
};

export type ScannedRange = { after: number; through: number };
export type ReduceArgs<State> = { event: StreamEvent; state: State };
export type ProcessEventArgs<State> = {
  event: StreamEvent | null;
  state: State;
  previousState: State;
  append: (...events: StreamEventInput[]) => Promise<StreamEvent[]>;
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  runInBackground: (work: () => Promise<unknown>) => void;
  delivery: { caughtUp: boolean };
};

/** The shared consumes rule for engines, subscriptions and inline reductions. */
export function consumesEvent(
  consumes: readonly string[] | undefined,
  event: { type: string; ephemeral?: boolean },
): boolean {
  if (event.ephemeral) return consumes?.includes(event.type) ?? false;
  return consumes === undefined || consumes.includes("*") || consumes.includes(event.type);
}

const reducesEvent = (consumes: readonly string[], event: { type: string; ephemeral?: boolean }) =>
  event.type !== "events.iterate.com/live-state/changed" && consumesEvent(consumes, event);

/** The author surface: a contract, pure reduce, effects, projection and idempotency helper. */
export abstract class StreamProcessor<State> {
  abstract readonly contract: ProcessorContract<State>;

  reduce(_args: ReduceArgs<State>): State | null | undefined {
    return undefined;
  }

  processEvent(_args: ProcessEventArgs<State>): undefined {}

  projectLiveState(state: State): unknown {
    return state;
  }

  idempotencyKey(key: string, event?: StreamEvent): string {
    return event ? `${this.contract.slug}/${key}@${event.offset}` : `${this.contract.slug}/${key}`;
  }
}

type Waiter = { offset: number; resolve: () => void };
type Cursor = { reducerVersion: string; reducedThroughOffset: number };

export class ProcessorEngine<State> {
  readonly processor: StreamProcessor<State>;
  readonly #contract: ProcessorContract<State>;
  readonly #stream: ProcessorStream;
  readonly #storage: ReduceCheckpointStore;
  readonly #liveState: LiveState<unknown>;
  readonly #waiters: Waiter[] = [];
  #chain: Promise<void> = Promise.resolve();
  #state: State;
  #cursor: number;
  #staleCheckpoint?: { reducedThroughOffset: number; state: State };
  #pushedThrough?: number;
  #latchedRefusal?: Error;

  constructor(
    processor: StreamProcessor<State>,
    deps: { stream: ProcessorStream; storage: ReduceCheckpointStore },
  ) {
    this.processor = processor;
    this.#contract = processor.contract;
    this.#stream = deps.stream;
    this.#storage = deps.storage;
    const checkpoint = this.#storage.read<State>(this.#contract.slug);
    if (checkpoint?.reducerVersion === this.#contract.version) {
      this.#state = checkpoint.state ?? this.#contract.initialState();
      this.#cursor = checkpoint.reducedThroughOffset;
    } else {
      this.#state = this.#contract.initialState();
      this.#cursor = 0;
      if (checkpoint)
        this.#staleCheckpoint = {
          reducedThroughOffset: checkpoint.reducedThroughOffset,
          state: checkpoint.state ?? this.#state,
        };
    }
    let seed: unknown;
    try {
      seed = processor.projectLiveState(this.#staleCheckpoint?.state ?? this.#state);
    } catch (error) {
      reportIssue("processor.live-state", error, { slug: this.#contract.slug });
    }
    this.#liveState = new LiveState(this.#stream, this.#contract.slug, seed);
  }

  async liveSnapshot(): Promise<{ rev: number; state: unknown }> {
    if (!this.#atPushedHead()) await this.catchUpFromLog();
    return this.#liveState.snapshot();
  }

  publishLiveState(): void {
    try {
      this.#liveState.set(this.processor.projectLiveState(this.#state));
    } catch (error) {
      reportIssue("processor.live-state", error, { slug: this.#contract.slug });
    }
  }

  processEventBatch(events: StreamEvent[], range: ScannedRange): Promise<void> {
    this.#pushedThrough = Math.max(this.#pushedThrough ?? 0, range.through);
    return this.#onChain(async () => {
      await this.#rereduceIfNeeded();
      await this.#replayDurable(range.after);
      await this.#applyBatch(events, range, range.through >= this.#pushedThrough!);
    });
  }

  catchUpFromLog(): Promise<void> {
    return this.#onChain(async () => {
      await this.#rereduceIfNeeded();
      await this.#replayDurable();
    });
  }

  async snapshot(): Promise<{ offset: number; state: State }> {
    if (!this.#atPushedHead()) await this.catchUpFromLog();
    return { offset: this.#cursor, state: this.#state };
  }

  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    const { offset, timeoutMs = 10_000 } = input;
    return new Promise<void>((resolve, reject) => {
      if (this.#cursor >= offset) return resolve();
      const waiter: Waiter = {
        offset,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `processor "${this.#contract.slug}" did not reach offset ${offset} in ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.#waiters.push(waiter);
      void this.catchUpFromLog().catch((error) => {
        const index = this.#waiters.indexOf(waiter);
        if (index === -1) return;
        this.#waiters.splice(index, 1);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  #atPushedHead(): boolean {
    return this.#pushedThrough !== undefined && this.#cursor >= this.#pushedThrough;
  }

  #onChain(work: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(() => {
      if (this.#latchedRefusal) throw this.#latchedRefusal;
      return work();
    });
    this.#chain = run.catch(() => {});
    return run;
  }

  /** Replay durable pages through `target`, or to the durable head when it is absent. */
  async #replayDurable(target = Number.POSITIVE_INFINITY): Promise<void> {
    while (this.#cursor < target) {
      const after = this.#cursor;
      const page = await this.#stream.read(after, 500);
      if (page.scannedThroughOffset <= after) return;
      const through = Math.min(page.scannedThroughOffset, target);
      const atHead = target === Number.POSITIVE_INFINITY && page.atHead;
      await this.#applyBatch(
        page.events.filter((event) => event.offset <= through),
        { after, through },
        atHead,
      );
      if (atHead || through === target) return;
    }
  }

  async #rereduceIfNeeded(): Promise<void> {
    const stale = this.#staleCheckpoint;
    if (!stale) return;
    let state = this.#contract.initialState();
    let cursor = 0;
    while (cursor < stale.reducedThroughOffset) {
      const page = await this.#stream.read(cursor, 500);
      for (const event of page.events)
        if (
          event.offset <= stale.reducedThroughOffset &&
          reducesEvent(this.#contract.consumes, event)
        )
          state = this.processor.reduce({ event, state }) ?? state;
      if (page.scannedThroughOffset <= cursor) break;
      cursor = Math.min(page.scannedThroughOffset, stale.reducedThroughOffset);
    }
    this.#writeCheckpoint(
      { reducerVersion: this.#contract.version, reducedThroughOffset: stale.reducedThroughOffset },
      state,
      true,
    );
    this.#state = state;
    this.#cursor = stale.reducedThroughOffset;
    this.#staleCheckpoint = undefined;
    this.publishLiveState();
    this.#resolveWaiters(this.#cursor);
  }

  async #applyBatch(events: StreamEvent[], range: ScannedRange, atHead: boolean): Promise<void> {
    const cursor = this.#cursor;
    const stateBefore = this.#state;
    let state = stateBefore;
    const consumable = events.filter(
      (event) =>
        reducesEvent(this.#contract.consumes, event) && (event.ephemeral || event.offset > cursor),
    );
    for (const [index, event] of consumable.entries())
      state = await this.#reduceAndProcess(event, state, atHead && index === consumable.length - 1);
    if (atHead && !consumable.length) state = await this.#reduceAndProcess(null, state, true);

    const nextCursor = Math.max(cursor, range.through);
    if (events.some((event) => !event.ephemeral) && nextCursor > cursor)
      this.#writeCheckpoint(
        { reducerVersion: this.#contract.version, reducedThroughOffset: nextCursor },
        state,
        state !== stateBefore,
      );
    this.#state = state;
    this.#cursor = nextCursor;
    this.#resolveWaiters(nextCursor);
    this.publishLiveState();
  }

  async #reduceAndProcess(
    event: StreamEvent | null,
    state: State,
    caughtUp: boolean,
  ): Promise<State> {
    const { slug, version, emits } = this.#contract;
    const previousState = state;
    if (event) {
      try {
        state = this.processor.reduce({ event, state }) ?? state;
      } catch (error) {
        reportIssue("processor.reduce", error, { slug, offset: event.offset });
      }
    }
    let blockers: Promise<unknown> = Promise.resolve();
    this.processor.processEvent({
      event,
      state,
      previousState,
      append: async (...emittedEvents) => {
        for (const emitted of emittedEvents) {
          if (!emits.includes(emitted.type))
            throw new Error(
              `processor "${slug}" emits ${JSON.stringify(emitted.type)} without declaring it`,
            );
          emitted.source = {
            processor: {
              slug,
              version,
              ...(event && { whileProcessing: { offset: event.offset, type: event.type } }),
            },
          };
        }
        return await this.#stream.append(...emittedEvents);
      },
      blockProcessorWhile: (work) => {
        blockers = blockers.then(() => work());
      },
      runInBackground: (work) => {
        void work().catch((error) => reportIssue("processor.background", error, { slug }));
      },
      delivery: { caughtUp },
    });
    for (let awaited: Promise<unknown> | undefined; awaited !== blockers; ) {
      awaited = blockers;
      await awaited;
    }
    return state;
  }

  #writeCheckpoint(cursor: Cursor, state: State, stateChanged: boolean): void {
    try {
      this.#storage.write(this.#contract.slug, cursor, state, stateChanged);
    } catch (error) {
      if ((error as { retryable?: unknown } | null)?.retryable === false)
        this.#latchedRefusal = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  #resolveWaiters(cursor: number): void {
    for (const waiter of this.#waiters.splice(0)) {
      if (cursor >= waiter.offset) waiter.resolve();
      else this.#waiters.push(waiter);
    }
  }
}
