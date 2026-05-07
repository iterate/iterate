/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";
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
} from "../../stream-processors/stream-processor.ts";
import {
  CoreProcessorContract,
  CoreProcessorErrorOccurredEventType,
} from "../../stream-processors/core/contract.ts";
import type {
  Constructor,
  DurableObjectClass,
  DurableObjectMixinResult,
  RuntimeDurableObjectConstructor,
} from "./mixin-types.ts";
import type {
  LifecycleHooksMembers,
  LifecycleHooksProtected,
  LifecycleStructuredName,
} from "./with-lifecycle-hooks.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";

type RunnerContract<Contract> = {
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

export type StreamProcessorRunnerState<Contract> = StoredProcessorState<Contract>;

export function wrapProcessorStreamApiWithProvenance<
  Contract extends {
    slug: string;
    version: string;
  },
>(args: {
  processor: { contract: Contract };
  processingEvent?: StreamEvent;
  streamApi: ProcessorStreamApi<Contract>;
}): ProcessorStreamApi<Contract> {
  const { processingEvent, processor, streamApi } = args;

  return {
    append: async (appendArgs) => {
      const existingMetadata = appendArgs.event.metadata ?? {};
      const existingProvenance =
        typeof existingMetadata.provenance === "object" &&
        existingMetadata.provenance !== null &&
        !Array.isArray(existingMetadata.provenance)
          ? existingMetadata.provenance
          : {};

      return await streamApi.append({
        ...appendArgs,
        event: {
          ...appendArgs.event,
          metadata: {
            ...existingMetadata,
            provenance: {
              ...existingProvenance,
              processor: {
                slug: processor.contract.slug,
                version: processor.contract.version,
              },
              ...(processingEvent == null
                ? {}
                : {
                    whileProcessingEvent: {
                      streamPath: processingEvent.streamPath,
                      offset: processingEvent.offset,
                      type: processingEvent.type,
                    },
                  }),
            },
          },
        },
      });
    },
    read: async (readArgs) => await streamApi.read(readArgs),
    subscribe: (subscribeArgs) => streamApi.subscribe(subscribeArgs),
  };
}

export abstract class StreamProcessorRunnerProtected<
  Contract extends RunnerContract<Contract> = RunnerContract<unknown>,
> {
  protected catchUpStreamProcessor(_args?: {
    signal?: AbortSignal;
  }): Promise<StreamProcessorRunnerState<Contract>> {
    throw new Error("StreamProcessorRunnerProtected is type-only and should never run.");
  }

  protected consumeStreamProcessorEvent(_args: {
    event: StreamEvent;
    signal?: AbortSignal;
  }): Promise<StreamProcessorRunnerState<Contract>> {
    throw new Error("StreamProcessorRunnerProtected is type-only and should never run.");
  }

  protected startStreamProcessorSubscription(_args?: {
    signal?: AbortSignal;
  }): Promise<StreamProcessorRunnerState<Contract>> {
    throw new Error("StreamProcessorRunnerProtected is type-only and should never run.");
  }

  protected getStreamProcessorRunnerState(): StreamProcessorRunnerState<Contract> {
    throw new Error("StreamProcessorRunnerProtected is type-only and should never run.");
  }
}

type StreamProcessorRunnerOptions<
  StructuredName extends LifecycleStructuredName,
  Env,
  Contract extends RunnerContract<Contract>,
> = {
  /**
   * Build the processor instance for one Durable Object wake.
   *
   * The mixin caches the returned object. That matters for processors that keep
   * runtime-only closure state such as timers, abort controllers, sockets, or
   * request sequence counters. Reduced state still lives in Durable Object
   * storage; this is only warm-instance state.
   */
  processor(args: {
    ctx: DurableObjectState;
    env: Env;
    structuredName: StructuredName;
    instance: unknown;
  }): Processor<Contract>;
  /**
   * Create the scoped stream API for this processor.
   *
   * In Cloudflare Workers this is usually a named WorkerEntrypoint from
   * `ctx.exports` with `props: { streamPath: structuredName.streamPath }`.
   */
  streamApi(args: {
    ctx: DurableObjectState;
    env: Env;
    structuredName: StructuredName;
    processor: Processor<Contract>;
  }): ProcessorStreamApi<Contract>;
};

type WithStreamProcessorRunnerResult<
  TBase extends DurableObjectClass,
  StructuredName extends LifecycleStructuredName,
  InitialState,
  Contract extends RunnerContract<Contract>,
> = DurableObjectMixinResult<
  TBase,
  StreamProcessorRunnerProtected<Contract> &
    DurableObjectCoreProtected &
    LifecycleHooksMembers<StructuredName, InitialState> &
    LifecycleHooksProtected<StructuredName, InitialState>
>;

/**
 * Adds protected Durable Object runner methods for one stream processor.
 *
 * The mixin owns local persisted processor state and the generic
 * reducer/hook sequencing. It is deliberately single-processor: if a caller
 * wants to run Agent + Codemode as one deployment unit, compose those processor
 * implementations into one processor first, then pass that processor here.
 *
 * Storage key shape is `stream-processor:<processor-slug>:stored-state`.
 * This assumes one processor instance is bound to one stream path for now.
 */
export function withStreamProcessorRunner<
  StructuredName extends LifecycleStructuredName,
  Env,
  Contract extends RunnerContract<Contract>,
  InitialState = undefined,
>(options: StreamProcessorRunnerOptions<StructuredName, Env, Contract>) {
  return function <TBase extends DurableObjectClass>(
    Base: TBase &
      Constructor<
        DurableObjectCoreProtected &
          LifecycleHooksMembers<StructuredName, InitialState> &
          LifecycleHooksProtected<StructuredName, InitialState>
      >,
  ): WithStreamProcessorRunnerResult<TBase, StructuredName, InitialState, Contract> {
    const BaseWithCore = Base as unknown as RuntimeDurableObjectConstructor &
      Constructor<
        DurableObjectCoreProtected &
          LifecycleHooksMembers<StructuredName, InitialState> &
          LifecycleHooksProtected<StructuredName, InitialState>
      >;

    abstract class StreamProcessorRunnerMixin extends BaseWithCore {
      #streamProcessorRunnerProcessor: Processor<Contract> | undefined;

      protected async catchUpStreamProcessor(args?: {
        signal?: AbortSignal;
      }): Promise<StreamProcessorRunnerState<Contract>> {
        await this.ensureStarted();
        const processor = this.streamProcessorRunnerProcessor();
        const storedState = this.loadStreamProcessorStoredState(processor);

        return await catchUpProcessorFromStream({
          processor,
          storedState,
          saveStoredProcessorState: async (nextStoredState) => {
            this.saveStreamProcessorStoredState({
              processor,
              storedState: nextStoredState,
            });
          },
          streamApi: this.streamProcessorRunnerStreamApi(),
          streamApiForEvent: (event) =>
            this.streamProcessorRunnerStreamApi({ processingEvent: event }),
          afterAppendError: async ({ error, reduction }) => {
            await this.appendStreamProcessorAfterAppendError({
              error,
              event: reduction.event,
              processor,
            });
          },
          signal: args?.signal ?? new AbortController().signal,
        });
      }

      protected async consumeStreamProcessorEvent(args: {
        event: StreamEvent;
        signal?: AbortSignal;
      }): Promise<StreamProcessorRunnerState<Contract>> {
        await this.ensureStarted();
        const processor = this.streamProcessorRunnerProcessor();
        const storedState = this.loadStreamProcessorStoredState(processor);

        return await consumeLiveProcessorEvent({
          processor,
          storedState,
          event: args.event,
          saveStoredProcessorState: async (nextStoredState) => {
            this.saveStreamProcessorStoredState({
              processor,
              storedState: nextStoredState,
            });
          },
          streamApi: this.streamProcessorRunnerStreamApi(),
          streamApiForEvent: (event) =>
            this.streamProcessorRunnerStreamApi({ processingEvent: event }),
          afterAppendError: async ({ error, reduction }) => {
            await this.appendStreamProcessorAfterAppendError({
              error,
              event: reduction.event,
              processor,
            });
          },
          signal: args.signal ?? new AbortController().signal,
        });
      }

      protected async startStreamProcessorSubscription(args?: {
        signal?: AbortSignal;
      }): Promise<StreamProcessorRunnerState<Contract>> {
        const signal = args?.signal ?? new AbortController().signal;
        let storedState = await this.catchUpStreamProcessor({ signal });

        try {
          for await (const event of this.streamProcessorRunnerStreamApi().subscribe({
            afterOffset: storedState.reducedThroughOffset,
            signal,
          })) {
            if (signal.aborted) {
              break;
            }

            storedState = await this.consumeStreamProcessorEvent({ event, signal });
          }
        } catch (error) {
          if (!signal.aborted || !isAbortError(error)) {
            throw error;
          }
        }

        return storedState;
      }

      protected getStreamProcessorRunnerState(): StreamProcessorRunnerState<Contract> {
        return this.loadStreamProcessorStoredState(this.streamProcessorRunnerProcessor());
      }

      private loadStreamProcessorStoredState(
        processor: Processor<Contract>,
      ): StoredProcessorState<Contract> {
        const stored = this.getDurableObjectKv().get<unknown>(storageKey(processor));
        if (stored == null) {
          return createStoredProcessorState({ contract: processor.contract });
        }

        return getStoredProcessorStateSchema(processor).parse(stored);
      }

      private saveStreamProcessorStoredState(args: {
        processor: Processor<Contract>;
        storedState: StoredProcessorState<Contract>;
      }): void {
        this.getDurableObjectKv().put(storageKey(args.processor), args.storedState);
      }

      private streamProcessorRunnerProcessor(): Processor<Contract> {
        this.#streamProcessorRunnerProcessor ??= options.processor({
          ctx: this.ctx,
          env: this.env as Env,
          structuredName: this.structuredName,
          instance: this,
        });
        return this.#streamProcessorRunnerProcessor;
      }

      private streamProcessorRunnerStreamApi(args?: {
        processingEvent?: StreamEvent;
      }): ProcessorStreamApi<Contract> {
        const processor = this.streamProcessorRunnerProcessor();
        const streamApi = options.streamApi({
          ctx: this.ctx,
          env: this.env as Env,
          structuredName: this.structuredName,
          processor,
        });
        return wrapProcessorStreamApiWithProvenance({
          processingEvent: args?.processingEvent,
          processor,
          streamApi,
        });
      }

      private async appendStreamProcessorAfterAppendError(args: {
        error: unknown;
        event: StreamEvent;
        processor: Processor<Contract>;
      }): Promise<void> {
        const serializedError = serializeError(args.error);
        const streamApi = this.streamProcessorRunnerStreamApi({
          processingEvent: args.event,
        }) as unknown as ProcessorStreamApi<typeof CoreProcessorContract>;

        await streamApi.append({
          event: {
            type: CoreProcessorErrorOccurredEventType,
            idempotencyKey: [
              "stream-processor-runner",
              args.processor.contract.slug,
              "after-append-error",
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
    }

    // Preserve Base<Env> so this remains legal after composition:
    // class AgentProcessorDO extends withStreamProcessorRunner(options)(Base)<Env> {}
    return StreamProcessorRunnerMixin as unknown as WithStreamProcessorRunnerResult<
      TBase,
      StructuredName,
      InitialState,
      Contract
    >;
  };
}

function storageKey(processor: { contract: { slug: string } }): string {
  return `stream-processor:${processor.contract.slug}:stored-state`;
}

function getStoredProcessorStateSchema<Contract extends RunnerContract<Contract>>(
  processor: Processor<Contract>,
): z.ZodType<StoredProcessorState<Contract>> {
  return z.object({
    state: processor.contract.stateSchema,
    hasCompletedFirstAttach: z.boolean(),
    liveAfterOffset: z.number().int().nonnegative(),
    reducedThroughOffset: z.number().int().nonnegative(),
    afterAppendCompletedThroughOffset: z.number().int().nonnegative(),
  }) as z.ZodType<StoredProcessorState<Contract>>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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
