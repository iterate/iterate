// Runtime-agnostic processor runner.
// It owns processor state/checkpointing and can run over any StreamSubscription,
// whether events arrive from browser/node inbound subscribe or from a Durable
// Object outbound requestSubscription handshake.

import type { StreamEvent, StreamEventInput } from "./shared/event.ts";
import {
  getInitialProcessorState,
  runProcessorReduce,
  type ProcessorState,
} from "./shared/stream-processors.ts";
import type { StreamSubscription } from "./subscription.ts";
import type { StreamEventBatch } from "./types.ts";
import type {
  Processor,
  ProcessorSideEffectAnchor,
  ReducedEvent,
  RunnableContract,
} from "./processor.ts";

export type Snapshot<State> = { state: State; offset: number };

export type ProcessorStorage<State> = {
  load(): Promise<Snapshot<State> | undefined> | Snapshot<State> | undefined;
  save(snapshot: Snapshot<State>): Promise<void> | void;
};

import type { ProcessorStream } from "./types.ts";
export type { ProcessorStream } from "./types.ts";

export function createProcessorRunner<Contract extends RunnableContract<Contract>, Deps>(args: {
  processor: Processor<Contract, Deps>;
  deps: Deps;
  storage?: ProcessorStorage<ProcessorState<Contract>>;
  stream: ProcessorStream;
  sideEffectAnchor?: ProcessorSideEffectAnchor;
}) {
  const { contract } = args.processor;
  const implementation = args.processor.build(args.deps);
  if (implementation.afterAppend !== undefined && implementation.afterAppendBatch !== undefined) {
    throw new Error(
      "Processor implementations must choose afterAppend or afterAppendBatch, not both.",
    );
  }
  let loaded = false;
  let snapshot: Snapshot<ProcessorState<Contract>> | undefined = undefined;
  let state = getInitialProcessorState(contract);
  const keptAlive = new Set<Promise<unknown>>();
  const shouldApplySideEffects = makeShouldApplySideEffects(args.sideEffectAnchor);

  function keepAlive(work: unknown) {
    if (
      work === undefined ||
      work === null ||
      typeof (work as Promise<unknown>).then !== "function"
    ) {
      return;
    }
    const promise = work as Promise<unknown>;
    keptAlive.add(promise);
    promise
      .finally(() => keptAlive.delete(promise))
      .catch((error: unknown) => {
        console.error("processor keepAlive promise failed", error);
      });
  }

  async function loadSnapshot() {
    if (!loaded) {
      snapshot = await args.storage?.load();
      if (snapshot !== undefined) state = snapshot.state;
      loaded = true;
    }
    return snapshot;
  }

  async function saveSnapshot(nextSnapshot: Snapshot<ProcessorState<Contract>>) {
    snapshot = nextSnapshot;
    await args.storage?.save(nextSnapshot);
  }

  function reduceBatch(argsForBatch: StreamEventBatch): ReducedBatch<Contract> | undefined {
    const checkpointOffset = snapshot?.offset ?? -1;
    let nextOffset = checkpointOffset;
    let nextState = state;
    const previousState = state;
    const events: ReducedEvent<Contract>[] = [];

    for (const event of argsForBatch.events) {
      if (event.offset <= nextOffset) continue;

      const eventPreviousState = nextState;
      const reduction = runProcessorReduce({
        processor: { contract },
        event,
        state: eventPreviousState,
      });
      nextOffset = event.offset;
      if (reduction === undefined) continue;

      nextState = reduction.state;
      events.push({
        event: reduction.event,
        previousState: eventPreviousState,
        state: nextState,
      });
    }

    if (nextOffset === checkpointOffset) return undefined;

    return {
      previousState,
      state: nextState,
      checkpointOffset: nextOffset,
      events,
    };
  }

  async function applySideEffects(argsForEffects: {
    batch: ReducedBatch<Contract>;
    streamMaxOffset: number;
  }) {
    const blockers: Promise<unknown>[] = [];

    if (implementation.afterAppendBatch !== undefined && argsForEffects.batch.events.length > 0) {
      let acceptsBlockers = true;
      implementation.afterAppendBatch({
        events: argsForEffects.batch.events,
        previousState: argsForEffects.batch.previousState,
        state: argsForEffects.batch.state,
        checkpointOffset: argsForEffects.batch.checkpointOffset,
        streamMaxOffset: argsForEffects.streamMaxOffset,
        stream: args.stream,
        shouldApplySideEffects,
        blockProcessorUntil: (work) => {
          if (!acceptsBlockers) throw new Error("blockProcessorUntil must be synchronous");
          const blocker = work();
          blockers.push(blocker);
          keepAlive(blocker);
        },
        keepAlive,
      });
      acceptsBlockers = false;
    }

    if (implementation.afterAppend !== undefined) {
      for (const reducedEvent of argsForEffects.batch.events) {
        let acceptsBlockers = true;
        implementation.afterAppend({
          event: reducedEvent.event,
          previousState: reducedEvent.previousState,
          state: reducedEvent.state,
          streamMaxOffset: argsForEffects.streamMaxOffset,
          stream: args.stream,
          shouldApplySideEffects,
          blockProcessorUntil: (work) => {
            if (!acceptsBlockers) throw new Error("blockProcessorUntil must be synchronous");
            const blocker = work();
            blockers.push(blocker);
            keepAlive(blocker);
          },
          keepAlive,
        });
        acceptsBlockers = false;
      }
    }

    if (blockers.length > 0) await Promise.all(blockers);
  }

  async function processEventBatch(argsForBatch: StreamEventBatch) {
    await loadSnapshot();
    const batch = reduceBatch(argsForBatch);
    if (batch === undefined) return;

    try {
      await applySideEffects({ batch, streamMaxOffset: argsForBatch.streamMaxOffset });
    } catch (error) {
      await appendProcessorError({ error, batch });
      throw error;
    }
    state = batch.state;
    await saveSnapshot({ state, offset: batch.checkpointOffset });
  }

  async function appendProcessorError(argsForError: {
    error: unknown;
    batch: ReducedBatch<Contract>;
  }) {
    const serializedError = serializeError(argsForError.error);
    try {
      await args.stream.append({
        event: {
          type: "events.iterate.com/stream/error-occurred",
          idempotencyKey: [
            "processor-error",
            contract.slug,
            String(argsForError.batch.checkpointOffset),
          ].join(":"),
          payload: {
            message: `Processor ${contract.slug} side effects failed at offset ${argsForError.batch.checkpointOffset}: ${serializedError.message}`,
            error: serializedError,
          },
        },
      });
    } catch (appendError) {
      console.error("failed to append processor error event", appendError);
    }
  }

  return {
    async snapshot() {
      return loadSnapshot();
    },
    processEventBatch,
    run(argsForRun: { subscription: StreamSubscription }) {
      let stopped = false;
      const processing = (async () => {
        for await (const batch of argsForRun.subscription) {
          if (stopped) break;
          await processEventBatch(batch);
        }
      })();

      return {
        async [Symbol.asyncDispose]() {
          stopped = true;
          await argsForRun.subscription[Symbol.asyncDispose]();
          await processing;
        },
      };
    },
  };
}

export type ProcessorRunner = ReturnType<typeof createProcessorRunner>;

type ReducedBatch<Contract> = {
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
  checkpointOffset: number;
  events: ReducedEvent<Contract>[];
};

function makeShouldApplySideEffects(anchor: ProcessorSideEffectAnchor | undefined) {
  return (args: { event: Pick<StreamEvent, "offset" | "createdAt">; gracePeriodMs?: number }) => {
    if (anchor === undefined) return true;
    if (args.event.offset > anchor.offset) return true;

    const gracePeriodMs = args.gracePeriodMs ?? 0;
    if (gracePeriodMs <= 0) return false;

    const anchorTime = Date.parse(anchor.createdAt);
    const eventTime = Date.parse(args.event.createdAt);
    if (!Number.isFinite(anchorTime) || !Number.isFinite(eventTime)) return false;
    return eventTime >= anchorTime - gracePeriodMs;
  };
}

function serializeError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      ...(error.name.trim() === "" ? {} : { name: error.name }),
      message: error.message || String(error),
      ...(typeof error.stack === "string" && error.stack.trim() !== ""
        ? { stack: error.stack }
        : {}),
    };
  }

  try {
    const message = JSON.stringify(error);
    return { message: message == null ? String(error) : message };
  } catch {
    return { message: String(error) };
  }
}
