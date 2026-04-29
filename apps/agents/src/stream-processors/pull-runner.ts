import {
  catchUpProcessorFromStream,
  consumeLiveProcessorEvent,
  createStoredProcessorState,
  type ConsumedEvent,
  type EventCatalog,
  type Processor,
  type ProcessorState,
  type ProcessorStreamApi,
  type StoredProcessorState,
} from "@iterate-com/shared/stream-processors";
import type { z } from "zod";

type PullRunnerContract<Contract> = {
  stateSchema: z.ZodType;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  reduce?: (args: {
    contract: Contract;
    state: ProcessorState<Contract>;
    event: ConsumedEvent<Contract>;
  }) => ProcessorState<Contract> | null | undefined;
};

export type PullProcessorStorage<Contract extends PullRunnerContract<Contract>> = {
  load(): Promise<StoredProcessorState<Contract> | undefined>;
  save(storedState: StoredProcessorState<Contract>): Promise<void>;
};

/**
 * Runs one processor against one stream API using pull/subscription delivery.
 *
 * This is intentionally just the app-local runner shell. The shared package
 * owns processor lifecycle details (`catchUpProcessorFromStream` and
 * `consumeLiveProcessorEvent`); this function owns the deployment loop:
 * load stored state, catch up, then keep consuming subscription events.
 */
export async function runPullProcessor<Contract extends PullRunnerContract<Contract>>(args: {
  processor: Processor<Contract>;
  storage: PullProcessorStorage<Contract>;
  streamApi: ProcessorStreamApi<Contract>;
  signal: AbortSignal;
}): Promise<StoredProcessorState<Contract>> {
  let storedState =
    (await args.storage.load()) ??
    createStoredProcessorState({ contract: args.processor.contract });

  storedState = await catchUpProcessorFromStream({
    processor: args.processor,
    storedState,
    saveStoredProcessorState: args.storage.save,
    streamApi: args.streamApi,
    signal: args.signal,
  });

  try {
    for await (const event of args.streamApi.subscribe({
      afterOffset: storedState.reducedThroughOffset,
      signal: args.signal,
    })) {
      if (args.signal.aborted) {
        break;
      }

      storedState = await consumeLiveProcessorEvent({
        processor: args.processor,
        storedState,
        event,
        saveStoredProcessorState: args.storage.save,
        streamApi: args.streamApi,
        signal: args.signal,
      });
    }
  } catch (error) {
    if (!args.signal.aborted || !isAbortError(error)) {
      throw error;
    }
  }

  return storedState;
}

export function createMemoryPullProcessorStorage<
  Contract extends PullRunnerContract<Contract>,
>(args: {
  contract: Contract;
  state?: ProcessorState<Contract>;
  storedState?: StoredProcessorState<Contract>;
}): PullProcessorStorage<Contract> & {
  get(): StoredProcessorState<Contract> | undefined;
} {
  let storedState =
    args.storedState ??
    (args.state === undefined
      ? undefined
      : createStoredProcessorState({ contract: args.contract, state: args.state }));

  return {
    async load() {
      return storedState;
    },
    async save(nextStoredState) {
      storedState = structuredClone(nextStoredState);
    },
    get() {
      return storedState;
    },
  };
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
