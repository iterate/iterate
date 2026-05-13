import type { z } from "zod";
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
  type StreamEvent,
} from "./stream-processor.ts";
import { CoreProcessorContract, CoreProcessorErrorOccurredEventType } from "./core/contract.ts";

type PullRunnerContract<Contract> = {
  slug: string;
  version: string;
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
 * This is intentionally just the runner shell. The shared package
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
    afterAppendError: async ({ error, reduction }) => {
      await appendAfterAppendError({
        error,
        event: reduction.event,
        processor: args.processor,
        streamApi: args.streamApi,
      });
    },
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
        afterAppendError: async ({ error, reduction }) => {
          await appendAfterAppendError({
            error,
            event: reduction.event,
            processor: args.processor,
            streamApi: args.streamApi,
          });
        },
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

async function appendAfterAppendError<Contract extends PullRunnerContract<Contract>>(args: {
  error: unknown;
  event: StreamEvent;
  processor: Processor<Contract>;
  streamApi: ProcessorStreamApi<Contract>;
}) {
  const serializedError = serializeError(args.error);
  const streamApi = args.streamApi as unknown as ProcessorStreamApi<typeof CoreProcessorContract>;

  await streamApi.append({
    event: {
      type: CoreProcessorErrorOccurredEventType,
      idempotencyKey: [
        "pull-processor-runner",
        args.processor.contract.slug,
        "after-append-error",
        args.event.streamPath,
        String(args.event.offset),
      ].join(":"),
      metadata: {
        provenance: {
          processor: {
            slug: args.processor.contract.slug,
            version: args.processor.contract.version,
          },
          whileProcessingEvent: {
            streamPath: args.event.streamPath,
            offset: args.event.offset,
            type: args.event.type,
          },
        },
      },
      payload: {
        message: `Processor ${args.processor.contract.slug}@${args.processor.contract.version} afterAppend failed: ${serializedError.message}`,
        error: serializedError,
      },
    },
  });
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

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
