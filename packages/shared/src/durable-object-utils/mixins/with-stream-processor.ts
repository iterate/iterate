/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";
import type { Callable } from "../../callable/types.ts";
import { CoreProcessorErrorOccurredEventType } from "../../stream-processors/core/contract.ts";
import {
  getEventSchema,
  type EventCatalog,
  type EventDefinition,
  type Processor,
  type ProcessorImplementation,
  type ProcessorStreamApi,
  type StreamEvent,
} from "../../stream-processors/stream-processor.ts";
import {
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  type EventInput,
  type StreamPath,
} from "../../streams/types.ts";
import type {
  Constructor,
  DurableObjectClass,
  DurableObjectMixinResult,
  RuntimeDurableObjectConstructor,
} from "./mixin-types.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";
import type {
  LifecycleHooksMembers,
  LifecycleHooksProtected,
  LifecycleStructuredName,
} from "./with-lifecycle-hooks.ts";

type RunnerContract = {
  slug: string;
  version: string;
  stateSchema: z.ZodType;
  initialState?: unknown;
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
  consumesAllEvents?: true;
  reduce?: unknown;
};

type RegisteredProcessor = {
  contract: RunnerContract;
  implementation: ProcessorImplementation<unknown>;
};

type RuntimeStoredProcessorState = {
  state: unknown;
  hasCompletedFirstAttach: boolean;
  liveAfterOffset: number;
  reducedThroughOffset: number;
  afterAppendCompletedThroughOffset: number;
};

type RuntimeProcessorReduction = {
  event: StreamEvent;
  previousState: unknown;
  state: unknown;
};

type RuntimeProcessorStreamApi = Omit<ProcessorStreamApi<unknown>, "append"> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<StreamEvent>;
  appendBatch(args: { events: EventInput[]; streamPath?: string }): Promise<StreamEvent[]>;
};

type StreamProcessorOptions<StructuredName extends LifecycleStructuredName, Env> = {
  streamApi(args: {
    ctx: DurableObjectState;
    env: Env;
    structuredName: StructuredName;
    streamPath: StreamPath | string;
  }): RuntimeProcessorStreamApi;
};

export type StreamProcessorRuntimeEntry = {
  afterAppendCompletedThroughOffset: number;
  reducedThroughOffset: number;
  processorSlug: string;
  streamPath: string;
};

export type StreamProcessorRuntimeState = {
  entries: StreamProcessorRuntimeEntry[];
  lastAppendDeliveryDelays: {
    deliveredAtMs: number;
    delayMs: number;
    offset: number;
    processorSlug: string;
    streamPath: string;
  }[];
  lastProcessorBatchTimings: StreamProcessorRuntimeBatchTiming[];
  lastSharedGapCatchUpTimings: StreamProcessorRuntimeSharedGapCatchUpTiming[];
  pendingWaitUntilCount: number;
  registeredProcessors: string[];
};

export type StreamProcessorRuntimeBatchTiming = {
  afterAppendDurationMs: number;
  appendCallCount: number;
  appendDurationMs: number;
  appendedEventCount: number;
  completedAtMs: number;
  inputEventCount: number;
  processorSlug: string;
  reduceDurationMs: number;
  reductionCount: number;
  streamPath: string;
  totalDurationMs: number;
};

export type StreamProcessorRuntimeSharedGapCatchUpTiming = {
  afterOffset: number;
  beforeOffset: number;
  completedAtMs: number;
  durationMs: number;
  gapEventCount: number;
  inputEventCount: number;
  streamPath: string;
};

type RuntimeProcessorTimingDraft = StreamProcessorRuntimeBatchTiming;

export abstract class StreamProcessorProtected {
  protected registerStreamProcessor(_processor: Processor<unknown>): void {
    throw new Error("StreamProcessorProtected is type-only and should never run.");
  }

  protected ensureStreamProcessorCallableSubscription(_args: {
    bindingName: string;
    durableObjectName: string;
    rpcMethod?: string;
    slug: string;
    streamPath: StreamPath | string;
  }): Promise<StreamEvent> {
    throw new Error("StreamProcessorProtected is type-only and should never run.");
  }

  protected catchUpStreamProcessors(_args: {
    signal?: AbortSignal;
    streamPath: StreamPath | string;
  }): Promise<StreamProcessorRuntimeEntry[]> {
    throw new Error("StreamProcessorProtected is type-only and should never run.");
  }

  protected consumeStreamProcessorEvent(_args: {
    event: StreamEvent;
    signal?: AbortSignal;
  }): Promise<StreamProcessorRuntimeEntry[]> {
    throw new Error("StreamProcessorProtected is type-only and should never run.");
  }

  protected consumeStreamProcessorEvents(_args: {
    events: StreamEvent[];
    signal?: AbortSignal;
  }): Promise<StreamProcessorRuntimeEntry[]> {
    throw new Error("StreamProcessorProtected is type-only and should never run.");
  }

  protected waitUntilStreamProcessor(_promise: Promise<unknown>): void {
    throw new Error("StreamProcessorProtected is type-only and should never run.");
  }

  getStreamProcessorRuntimeState(): StreamProcessorRuntimeState {
    throw new Error("StreamProcessorProtected is type-only and should never run.");
  }
}

type WithStreamProcessorResult<
  TBase extends DurableObjectClass,
  StructuredName extends LifecycleStructuredName,
  InitialState,
> = DurableObjectMixinResult<
  TBase,
  StreamProcessorProtected &
    DurableObjectCoreProtected &
    LifecycleHooksMembers<StructuredName, InitialState> &
    LifecycleHooksProtected<StructuredName, InitialState>
>;

export function withStreamProcessor<
  StructuredName extends LifecycleStructuredName,
  Env,
  InitialState = undefined,
>(options: StreamProcessorOptions<StructuredName, Env>) {
  return function <TBase extends DurableObjectClass>(
    Base: TBase &
      Constructor<
        DurableObjectCoreProtected &
          LifecycleHooksMembers<StructuredName, InitialState> &
          LifecycleHooksProtected<StructuredName, InitialState>
      >,
  ): WithStreamProcessorResult<TBase, StructuredName, InitialState> {
    const BaseWithCore = Base as unknown as RuntimeDurableObjectConstructor &
      Constructor<
        DurableObjectCoreProtected &
          LifecycleHooksMembers<StructuredName, InitialState> &
          LifecycleHooksProtected<StructuredName, InitialState>
      >;

    abstract class StreamProcessorMixin extends BaseWithCore {
      readonly #processors = new Map<string, RegisteredProcessor>();
      readonly #pendingWaitUntil = new Set<Promise<unknown>>();
      readonly #localAppendTimes = new Map<
        string,
        { appendedAtMs: number; processorSlug: string }
      >();
      readonly #lastAppendDeliveryDelays: StreamProcessorRuntimeState["lastAppendDeliveryDelays"] =
        [];
      readonly #lastProcessorBatchTimings: StreamProcessorRuntimeState["lastProcessorBatchTimings"] =
        [];
      readonly #lastSharedGapCatchUpTimings: StreamProcessorRuntimeState["lastSharedGapCatchUpTimings"] =
        [];
      readonly #localFeedThroughQueue: StreamEvent[] = [];
      #deliveryLane: Promise<void> = Promise.resolve();
      #isDrainingLocalFeedThrough = false;

      protected registerStreamProcessor(processor: Processor<unknown>): void {
        const registered = processor as unknown as RegisteredProcessor;
        const existing = this.#processors.get(registered.contract.slug);
        if (existing != null) {
          throw new Error(`Stream processor "${registered.contract.slug}" is already registered.`);
        }
        this.#processors.set(registered.contract.slug, registered);
      }

      protected async ensureStreamProcessorCallableSubscription(args: {
        bindingName: string;
        durableObjectName: string;
        rpcMethod?: string;
        slug: string;
        streamPath: StreamPath | string;
      }): Promise<StreamEvent> {
        await this.ensureStarted();
        const rpcMethod = args.rpcMethod ?? "afterAppend";
        return await this.streamApiForPath(args.streamPath).append({
          event: {
            type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
            idempotencyKey: `stream-processor-callable-subscription:${args.bindingName}:${args.durableObjectName}:${args.streamPath}:${args.slug}:${rpcMethod}`,
            payload: {
              slug: args.slug,
              type: "callable",
              callable: {
                type: "workers-rpc",
                via: {
                  type: "env-binding",
                  bindingType: "durable-object-namespace",
                  bindingName: args.bindingName,
                  durableObject: {
                    name: args.durableObjectName,
                  },
                },
                rpcMethod,
                argsMode: "object",
              } satisfies Callable,
            },
          },
        });
      }

      protected async catchUpStreamProcessors(args: {
        signal?: AbortSignal;
        streamPath: StreamPath | string;
      }): Promise<StreamProcessorRuntimeEntry[]> {
        await this.ensureStarted();
        const signal = args.signal ?? new AbortController().signal;
        return await this.runInDeliveryLane(async () => {
          await Promise.all(
            [...this.#processors.values()].map(async (processor) => {
              let storedState = this.loadStoredState({ processor, streamPath: args.streamPath });
              const events = await this.streamApiForPath(args.streamPath).read({
                afterOffset: storedState.reducedThroughOffset,
                beforeOffset: "end",
              });
              const readThroughOffset = events.at(-1)?.offset ?? storedState.reducedThroughOffset;
              for (const event of events) {
                storedState = await this.consumeOneEvent({
                  event,
                  processor,
                  signal,
                  storedState,
                });
              }
              if (
                !storedState.hasCompletedFirstAttach ||
                readThroughOffset > storedState.reducedThroughOffset
              ) {
                storedState = {
                  ...storedState,
                  hasCompletedFirstAttach: true,
                  liveAfterOffset: storedState.hasCompletedFirstAttach
                    ? storedState.liveAfterOffset
                    : readThroughOffset,
                  reducedThroughOffset: Math.max(
                    storedState.reducedThroughOffset,
                    readThroughOffset,
                  ),
                  afterAppendCompletedThroughOffset: Math.max(
                    storedState.afterAppendCompletedThroughOffset,
                    readThroughOffset,
                  ),
                };
                this.saveStoredState({ processor, storedState, streamPath: args.streamPath });
              }
              await runProcessorOnStartRuntime({
                processor,
                state: storedState.state,
                streamApi: this.streamApiForProcessor({ processor, streamPath: args.streamPath }),
                signal,
                waitUntil: (promise) => this.waitUntilStreamProcessor(promise),
              });
            }),
          );
          await this.drainLocalFeedThrough(signal);
          return this.runtimeEntries();
        });
      }

      protected async consumeStreamProcessorEvent(args: {
        event: StreamEvent;
        signal?: AbortSignal;
      }): Promise<StreamProcessorRuntimeEntry[]> {
        await this.ensureStarted();
        const signal = args.signal ?? new AbortController().signal;
        return await this.runInDeliveryLane(async () => {
          await this.consumeStreamProcessorEventsWithoutLocalDrain({
            events: [args.event],
            signal,
          });
          await this.drainLocalFeedThrough(signal);
          return this.runtimeEntries();
        });
      }

      protected async consumeStreamProcessorEvents(args: {
        events: StreamEvent[];
        signal?: AbortSignal;
      }): Promise<StreamProcessorRuntimeEntry[]> {
        await this.ensureStarted();
        const signal = args.signal ?? new AbortController().signal;
        return await this.runInDeliveryLane(async () => {
          await this.consumeStreamProcessorEventsWithoutLocalDrain({
            events: args.events,
            signal,
          });
          await this.drainLocalFeedThrough(signal);
          return this.runtimeEntries();
        });
      }

      private async runInDeliveryLane<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.#deliveryLane.catch(() => undefined);
        const result = previous.then(task);
        this.#deliveryLane = result.then(
          () => undefined,
          () => undefined,
        );
        return await result;
      }

      private async consumeStreamProcessorEventsWithoutLocalDrain(args: {
        events: StreamEvent[];
        signal: AbortSignal;
      }) {
        for (const event of args.events) {
          this.recordLocalDelivery(event);
        }
        const events = await this.withSharedProcessorGapCatchUp(args.events);
        await Promise.all(
          [...this.#processors.values()].map(async (processor) => {
            await this.consumeBatchForProcessor({
              events,
              processor,
              signal: args.signal,
            });
          }),
        );
      }

      private async withSharedProcessorGapCatchUp(events: StreamEvent[]): Promise<StreamEvent[]> {
        const firstEvent = events[0];
        if (firstEvent == null) {
          return events;
        }
        if (!events.every((event) => event.streamPath === firstEvent.streamPath)) {
          return events;
        }

        const earliestReducedThroughOffset = Math.min(
          ...[...this.#processors.values()].map(
            (processor) =>
              this.loadStoredState({
                processor,
                streamPath: firstEvent.streamPath,
              }).reducedThroughOffset,
          ),
        );
        if (firstEvent.offset <= earliestReducedThroughOffset + 1) {
          return events;
        }

        const startedAt = performance.now();
        const gapEvents = await this.streamApiForPath(firstEvent.streamPath).read({
          afterOffset: earliestReducedThroughOffset,
          beforeOffset: firstEvent.offset,
        });
        this.recordSharedGapCatchUpTiming({
          afterOffset: earliestReducedThroughOffset,
          beforeOffset: firstEvent.offset,
          completedAtMs: Date.now(),
          durationMs: Math.round(performance.now() - startedAt),
          gapEventCount: gapEvents.length,
          inputEventCount: events.length,
          streamPath: firstEvent.streamPath,
        });
        if (gapEvents.length === 0) {
          return events;
        }

        return [...gapEvents, ...events].toSorted((left, right) => left.offset - right.offset);
      }

      getStreamProcessorRuntimeState(): StreamProcessorRuntimeState {
        return {
          entries: this.runtimeEntries(),
          lastAppendDeliveryDelays: [...this.#lastAppendDeliveryDelays],
          lastProcessorBatchTimings: [...this.#lastProcessorBatchTimings],
          lastSharedGapCatchUpTimings: [...this.#lastSharedGapCatchUpTimings],
          pendingWaitUntilCount: this.#pendingWaitUntil.size,
          registeredProcessors: [...this.#processors.keys()],
        };
      }

      private async consumeForProcessor(args: {
        event: StreamEvent;
        processor: RegisteredProcessor;
        signal: AbortSignal;
      }) {
        let storedState = this.loadStoredState({
          processor: args.processor,
          streamPath: args.event.streamPath,
        });

        if (args.event.offset <= storedState.afterAppendCompletedThroughOffset) {
          return;
        }

        if (args.event.offset < storedState.reducedThroughOffset) {
          await this.appendProcessorError({
            error: new Error(
              `Received event offset ${args.event.offset} after ${args.processor.contract.slug} had reduced through offset ${storedState.reducedThroughOffset}.`,
            ),
            event: args.event,
            processor: args.processor,
          });
          return;
        }

        if (args.event.offset > storedState.reducedThroughOffset + 1) {
          const gapEvents = await this.streamApiForPath(args.event.streamPath).read({
            afterOffset: storedState.reducedThroughOffset,
            beforeOffset: args.event.offset,
          });
          for (const gapEvent of gapEvents) {
            storedState = await this.consumeOneEvent({
              event: gapEvent,
              processor: args.processor,
              signal: args.signal,
              storedState,
            });
          }
        }

        await this.consumeOneEvent({
          event: args.event,
          processor: args.processor,
          signal: args.signal,
          storedState,
        });
      }

      private async consumeBatchForProcessor(args: {
        events: StreamEvent[];
        processor: RegisteredProcessor;
        signal: AbortSignal;
      }) {
        const streamPath = args.events[0]?.streamPath ?? "";
        const timing: RuntimeProcessorTimingDraft = {
          afterAppendDurationMs: 0,
          appendCallCount: 0,
          appendDurationMs: 0,
          appendedEventCount: 0,
          completedAtMs: 0,
          inputEventCount: args.events.length,
          processorSlug: args.processor.contract.slug,
          reduceDurationMs: 0,
          reductionCount: 0,
          streamPath,
          totalDurationMs: 0,
        };
        const startedAt = performance.now();
        const reduceStartedAt = performance.now();
        let storedState = this.loadStoredState({
          processor: args.processor,
          streamPath,
        });
        const reductions: RuntimeProcessorReduction[] = [];
        let hasStoredStateChanges = false;

        try {
          for (const event of args.events) {
            if (event.offset <= storedState.afterAppendCompletedThroughOffset) {
              continue;
            }

            if (event.offset < storedState.reducedThroughOffset) {
              await this.appendProcessorError({
                error: new Error(
                  `Received event offset ${event.offset} after ${args.processor.contract.slug} had reduced through offset ${storedState.reducedThroughOffset}.`,
                ),
                event,
                processor: args.processor,
              });
              continue;
            }

            if (event.offset > storedState.reducedThroughOffset + 1) {
              const gapEvents = await this.streamApiForPath(event.streamPath).read({
                afterOffset: storedState.reducedThroughOffset,
                beforeOffset: event.offset,
              });
              for (const gapEvent of gapEvents) {
                const consumed = await this.reduceOneEvent({
                  event: gapEvent,
                  persist: false,
                  processor: args.processor,
                  storedState,
                });
                storedState = consumed.storedState;
                hasStoredStateChanges = true;
                if (consumed.reduction != null) {
                  reductions.push(consumed.reduction);
                }
              }
            }

            const consumed = await this.reduceOneEvent({
              event,
              persist: false,
              processor: args.processor,
              storedState,
            });
            storedState = consumed.storedState;
            hasStoredStateChanges = true;
            if (consumed.reduction != null) {
              reductions.push(consumed.reduction);
            }
          }
          timing.reduceDurationMs = Math.round(performance.now() - reduceStartedAt);
          timing.reductionCount = reductions.length;

          if (hasStoredStateChanges) {
            this.saveStoredState({
              processor: args.processor,
              storedState,
              streamPath: args.events[0]!.streamPath,
            });
          }

          if (reductions.length === 0) {
            return;
          }

          const afterAppendStartedAt = performance.now();
          try {
            if (args.processor.implementation.afterAppendBatch != null) {
              await runProcessorAfterAppendBatchRuntime({
                processor: args.processor,
                reductions,
                streamApi: this.streamApiForProcessor({
                  processingEvent: reductions.at(-1)?.event,
                  processor: args.processor,
                  streamPath: args.events[0]!.streamPath,
                  timing,
                }),
                signal: args.signal,
                waitUntil: (promise) => this.waitUntilStreamProcessor(promise),
              });
            } else {
              for (const reduction of reductions) {
                await runProcessorAfterAppendRuntime({
                  processor: args.processor,
                  ...reduction,
                  streamApi: this.streamApiForProcessor({
                    processingEvent: reduction.event,
                    processor: args.processor,
                    streamPath: reduction.event.streamPath,
                    timing,
                  }),
                  signal: args.signal,
                  waitUntil: (promise) => this.waitUntilStreamProcessor(promise),
                });
              }
            }
          } catch (error) {
            await this.appendProcessorError({
              error,
              event: reductions.at(-1)!.event,
              processor: args.processor,
            });
          } finally {
            timing.afterAppendDurationMs = Math.round(performance.now() - afterAppendStartedAt);
          }

          storedState = {
            ...storedState,
            afterAppendCompletedThroughOffset: Math.max(
              storedState.afterAppendCompletedThroughOffset,
              reductions.at(-1)!.event.offset,
            ),
          };
          this.saveStoredState({
            processor: args.processor,
            storedState,
            streamPath: args.events[0]!.streamPath,
          });
        } finally {
          timing.completedAtMs = Date.now();
          timing.totalDurationMs = Math.round(performance.now() - startedAt);
          this.recordProcessorBatchTiming(timing);
        }
      }

      private async consumeOneEvent(args: {
        event: StreamEvent;
        processor: RegisteredProcessor;
        signal: AbortSignal;
        storedState: RuntimeStoredProcessorState;
      }): Promise<RuntimeStoredProcessorState> {
        if (args.event.offset <= args.storedState.afterAppendCompletedThroughOffset) {
          return args.storedState;
        }

        const reduction = reduceProcessorRuntime({
          processor: args.processor,
          event: args.event,
          state: args.storedState.state,
        });
        let storedState: RuntimeStoredProcessorState = {
          ...args.storedState,
          state: reduction?.state ?? args.storedState.state,
          reducedThroughOffset: Math.max(args.storedState.reducedThroughOffset, args.event.offset),
          afterAppendCompletedThroughOffset:
            reduction == null
              ? Math.max(args.storedState.afterAppendCompletedThroughOffset, args.event.offset)
              : args.storedState.afterAppendCompletedThroughOffset,
        };
        this.saveStoredState({
          processor: args.processor,
          storedState,
          streamPath: args.event.streamPath,
        });

        if (reduction == null) return storedState;

        try {
          await runProcessorAfterAppendRuntime({
            processor: args.processor,
            ...reduction,
            streamApi: this.streamApiForProcessor({
              processingEvent: args.event,
              processor: args.processor,
              streamPath: args.event.streamPath,
            }),
            signal: args.signal,
            waitUntil: (promise) => this.waitUntilStreamProcessor(promise),
          });
        } catch (error) {
          await this.appendProcessorError({
            error,
            event: args.event,
            processor: args.processor,
          });
        }

        storedState = {
          ...storedState,
          afterAppendCompletedThroughOffset: Math.max(
            storedState.afterAppendCompletedThroughOffset,
            args.event.offset,
          ),
        };
        this.saveStoredState({
          processor: args.processor,
          storedState,
          streamPath: args.event.streamPath,
        });
        return storedState;
      }

      private async reduceOneEvent(args: {
        event: StreamEvent;
        persist?: boolean;
        processor: RegisteredProcessor;
        storedState: RuntimeStoredProcessorState;
      }): Promise<{
        reduction: RuntimeProcessorReduction | null;
        storedState: RuntimeStoredProcessorState;
      }> {
        const reduction = reduceProcessorRuntime({
          processor: args.processor,
          event: args.event,
          state: args.storedState.state,
        });
        const storedState: RuntimeStoredProcessorState = {
          ...args.storedState,
          state: reduction?.state ?? args.storedState.state,
          reducedThroughOffset: Math.max(args.storedState.reducedThroughOffset, args.event.offset),
          afterAppendCompletedThroughOffset:
            reduction == null
              ? Math.max(args.storedState.afterAppendCompletedThroughOffset, args.event.offset)
              : args.storedState.afterAppendCompletedThroughOffset,
        };
        if (args.persist ?? true) {
          this.saveStoredState({
            processor: args.processor,
            storedState,
            streamPath: args.event.streamPath,
          });
        }

        return { reduction: reduction ?? null, storedState };
      }

      private loadStoredState(args: {
        processor: RegisteredProcessor;
        streamPath: StreamPath | string;
      }): RuntimeStoredProcessorState {
        const stored = this.getDurableObjectKv().get<unknown>(
          storageKey({ processor: args.processor, streamPath: args.streamPath }),
        );
        if (stored == null) {
          return createInitialStoredState(args.processor.contract);
        }
        return getStoredProcessorStateSchema(args.processor).parse(stored);
      }

      private saveStoredState(args: {
        processor: RegisteredProcessor;
        storedState: RuntimeStoredProcessorState;
        streamPath: StreamPath | string;
      }): void {
        this.getDurableObjectKv().put(
          storageKey({ processor: args.processor, streamPath: args.streamPath }),
          args.storedState,
        );
      }

      private streamApiForPath(streamPath: StreamPath | string) {
        return options.streamApi({
          ctx: this.ctx,
          env: this.env as Env,
          structuredName: this.structuredName,
          streamPath,
        });
      }

      private streamApiForProcessor(args: {
        processor: RegisteredProcessor;
        processingEvent?: StreamEvent;
        streamPath: StreamPath | string;
        timing?: RuntimeProcessorTimingDraft;
      }): RuntimeProcessorStreamApi {
        const streamApi = this.streamApiForPath(args.streamPath);
        return {
          append: async (appendArgs) => {
            const appendStartedAt = performance.now();
            const event = await streamApi.append({
              ...appendArgs,
              event: {
                ...appendArgs.event,
                metadata: addProcessorProvenance({
                  event: appendArgs.event,
                  processor: args.processor,
                  processingEvent: args.processingEvent,
                }),
              } as EventInput,
            });
            if (args.timing != null) {
              args.timing.appendCallCount += 1;
              args.timing.appendDurationMs += Math.round(performance.now() - appendStartedAt);
              args.timing.appendedEventCount += 1;
            }
            this.#localAppendTimes.set(localAppendKey(event), {
              appendedAtMs: Date.now(),
              processorSlug: args.processor.contract.slug,
            });
            this.queueLocalFeedThroughEvents({
              events: [event],
              streamPath: args.streamPath,
            });
            return event;
          },
          appendBatch: async (appendArgs) => {
            const appendStartedAt = performance.now();
            const events = await streamApi.appendBatch({
              ...appendArgs,
              events: appendArgs.events.map((event) => ({
                ...event,
                metadata: addProcessorProvenance({
                  event,
                  processor: args.processor,
                  processingEvent: args.processingEvent,
                }),
              })) as EventInput[],
            });
            if (args.timing != null) {
              args.timing.appendCallCount += 1;
              args.timing.appendDurationMs += Math.round(performance.now() - appendStartedAt);
              args.timing.appendedEventCount += events.length;
            }
            for (const event of events) {
              this.#localAppendTimes.set(localAppendKey(event), {
                appendedAtMs: Date.now(),
                processorSlug: args.processor.contract.slug,
              });
            }
            this.queueLocalFeedThroughEvents({
              events,
              streamPath: args.streamPath,
            });
            return events;
          },
          read: async (readArgs) => await streamApi.read(readArgs),
          subscribe: (subscribeArgs) => streamApi.subscribe(subscribeArgs),
        };
      }

      private queueLocalFeedThroughEvents(args: {
        events: StreamEvent[];
        streamPath: StreamPath | string;
      }) {
        for (const event of args.events) {
          if (event.streamPath !== args.streamPath) continue;
          this.#localFeedThroughQueue.push(event);
        }
      }

      private async drainLocalFeedThrough(signal: AbortSignal) {
        if (this.#isDrainingLocalFeedThrough) {
          return;
        }

        this.#isDrainingLocalFeedThrough = true;
        try {
          while (this.#localFeedThroughQueue.length > 0) {
            const queuedEvents = this.#localFeedThroughQueue.splice(0);
            const eventsByStreamPath = new Map<string, StreamEvent[]>();
            const seenEvents = new Set<string>();
            for (const event of queuedEvents) {
              const eventKey = `${event.streamPath}:${event.offset}`;
              if (seenEvents.has(eventKey)) continue;
              seenEvents.add(eventKey);
              const events = eventsByStreamPath.get(event.streamPath) ?? [];
              events.push(event);
              eventsByStreamPath.set(event.streamPath, events);
            }

            for (const events of eventsByStreamPath.values()) {
              const readyEvents = this.localFeedThroughReadyPrefix(
                events.toSorted((left, right) => left.offset - right.offset),
              );
              if (readyEvents.length === 0) {
                continue;
              }
              await this.consumeStreamProcessorEventsWithoutLocalDrain({
                events: readyEvents,
                signal,
              });
            }
          }
        } finally {
          this.#isDrainingLocalFeedThrough = false;
        }
      }

      private localFeedThroughReadyPrefix(events: StreamEvent[]): StreamEvent[] {
        const firstEvent = events[0];
        if (firstEvent == null) {
          return [];
        }

        let earliestReducedThroughOffset = Math.min(
          ...[...this.#processors.values()].map(
            (processor) =>
              this.loadStoredState({
                processor,
                streamPath: firstEvent.streamPath,
              }).reducedThroughOffset,
          ),
        );
        const readyEvents: StreamEvent[] = [];
        for (const event of events) {
          if (event.offset > earliestReducedThroughOffset + 1) {
            break;
          }
          readyEvents.push(event);
          earliestReducedThroughOffset = Math.max(earliestReducedThroughOffset, event.offset);
        }
        return readyEvents;
      }

      private async appendProcessorError(args: {
        error: unknown;
        event: StreamEvent;
        processor: RegisteredProcessor;
      }) {
        const serializedError = serializeError(args.error);
        await this.streamApiForProcessor({
          processingEvent: args.event,
          processor: args.processor,
          streamPath: args.event.streamPath,
        }).append({
          event: {
            type: CoreProcessorErrorOccurredEventType,
            idempotencyKey: [
              "stream-processor",
              args.processor.contract.slug,
              "error",
              String(args.event.offset),
            ].join(":"),
            payload: {
              message: `Processor ${args.processor.contract.slug}@${args.processor.contract.version} failed while processing offset ${args.event.offset}: ${serializedError.message}`,
              error: serializedError,
            },
          },
        });
      }

      protected waitUntilStreamProcessor(promise: Promise<unknown>) {
        this.#pendingWaitUntil.add(promise);
        void promise.finally(() => {
          this.#pendingWaitUntil.delete(promise);
        });
      }

      private recordProcessorBatchTiming(timing: StreamProcessorRuntimeBatchTiming) {
        this.#lastProcessorBatchTimings.unshift(timing);
        this.#lastProcessorBatchTimings.splice(50);
      }

      private recordSharedGapCatchUpTiming(timing: StreamProcessorRuntimeSharedGapCatchUpTiming) {
        this.#lastSharedGapCatchUpTimings.unshift(timing);
        this.#lastSharedGapCatchUpTimings.splice(50);
      }

      private recordLocalDelivery(event: StreamEvent) {
        const localAppend = this.#localAppendTimes.get(localAppendKey(event));
        if (localAppend == null) return;
        this.#localAppendTimes.delete(localAppendKey(event));
        const deliveredAtMs = Date.now();
        this.#lastAppendDeliveryDelays.unshift({
          deliveredAtMs,
          delayMs: deliveredAtMs - localAppend.appendedAtMs,
          offset: event.offset,
          processorSlug: localAppend.processorSlug,
          streamPath: event.streamPath,
        });
        this.#lastAppendDeliveryDelays.splice(20);
      }

      private runtimeEntries(): StreamProcessorRuntimeEntry[] {
        const entries: StreamProcessorRuntimeEntry[] = [];
        for (const [key] of this.getDurableObjectKv().list()) {
          const parsed = parseStorageKey(key);
          if (parsed == null) continue;
          const processor = this.#processors.get(parsed.processorSlug);
          if (processor == null) continue;
          const stored = this.loadStoredState({
            processor,
            streamPath: parsed.streamPath,
          });
          entries.push({
            afterAppendCompletedThroughOffset: stored.afterAppendCompletedThroughOffset,
            processorSlug: parsed.processorSlug,
            reducedThroughOffset: stored.reducedThroughOffset,
            streamPath: parsed.streamPath,
          });
        }
        return entries.sort((left, right) =>
          `${left.streamPath}:${left.processorSlug}`.localeCompare(
            `${right.streamPath}:${right.processorSlug}`,
          ),
        );
      }
    }

    return StreamProcessorMixin as unknown as WithStreamProcessorResult<
      TBase,
      StructuredName,
      InitialState
    >;
  };
}

function storageKey(args: { processor: RegisteredProcessor; streamPath: StreamPath | string }) {
  return `stream-processor:${encodeURIComponent(String(args.streamPath))}:${args.processor.contract.slug}:stored-state`;
}

function parseStorageKey(key: string): { processorSlug: string; streamPath: string } | null {
  const match = /^stream-processor:([^:]+):([^:]+):stored-state$/.exec(key);
  if (match == null) return null;
  return {
    streamPath: decodeURIComponent(match[1] ?? ""),
    processorSlug: match[2] ?? "",
  };
}

function localAppendKey(event: Pick<StreamEvent, "offset" | "streamPath">) {
  return `${event.streamPath}:${event.offset}`;
}

function getStoredProcessorStateSchema(
  processor: RegisteredProcessor,
): z.ZodType<RuntimeStoredProcessorState> {
  return z.object({
    state: processor.contract.stateSchema,
    hasCompletedFirstAttach: z.boolean(),
    liveAfterOffset: z.number().int().nonnegative(),
    reducedThroughOffset: z.number().int().nonnegative(),
    afterAppendCompletedThroughOffset: z.number().int().nonnegative(),
  }) as z.ZodType<RuntimeStoredProcessorState>;
}

function createInitialStoredState(contract: RunnerContract): RuntimeStoredProcessorState {
  return {
    state: contract.stateSchema.parse(contract.initialState),
    hasCompletedFirstAttach: false,
    liveAfterOffset: 0,
    reducedThroughOffset: 0,
    afterAppendCompletedThroughOffset: 0,
  };
}

async function runProcessorOnStartRuntime(args: {
  processor: RegisteredProcessor;
  state: unknown;
  streamApi: RuntimeProcessorStreamApi;
  signal: AbortSignal;
  waitUntil: (promise: Promise<unknown>) => void;
}) {
  const onStart = args.processor.implementation.onStart as
    | ((input: {
        state: unknown;
        streamApi: RuntimeProcessorStreamApi;
        signal: AbortSignal;
        waitUntil: (promise: Promise<unknown>) => void;
      }) => Promise<void> | void)
    | undefined;
  await onStart?.({
    state: args.state,
    streamApi: args.streamApi,
    signal: args.signal,
    waitUntil: args.waitUntil,
  });
}

async function runProcessorAfterAppendRuntime(args: {
  processor: RegisteredProcessor;
  event: StreamEvent;
  previousState: unknown;
  state: unknown;
  streamApi: RuntimeProcessorStreamApi;
  signal: AbortSignal;
  waitUntil: (promise: Promise<unknown>) => void;
}) {
  const afterAppend = args.processor.implementation.afterAppend as
    | ((input: {
        event: StreamEvent;
        previousState: unknown;
        state: unknown;
        streamApi: RuntimeProcessorStreamApi;
        signal: AbortSignal;
        waitUntil: (promise: Promise<unknown>) => void;
      }) => Promise<void> | void)
    | undefined;
  await afterAppend?.({
    event: args.event,
    previousState: args.previousState,
    state: args.state,
    streamApi: args.streamApi,
    signal: args.signal,
    waitUntil: args.waitUntil,
  });
}

async function runProcessorAfterAppendBatchRuntime(args: {
  processor: RegisteredProcessor;
  reductions: RuntimeProcessorReduction[];
  streamApi: RuntimeProcessorStreamApi;
  signal: AbortSignal;
  waitUntil: (promise: Promise<unknown>) => void;
}) {
  const afterAppendBatch = args.processor.implementation.afterAppendBatch as
    | ((input: {
        reductions: RuntimeProcessorReduction[];
        streamApi: RuntimeProcessorStreamApi;
        signal: AbortSignal;
        waitUntil: (promise: Promise<unknown>) => void;
      }) => Promise<void> | void)
    | undefined;
  await afterAppendBatch?.({
    reductions: args.reductions,
    streamApi: args.streamApi,
    signal: args.signal,
    waitUntil: args.waitUntil,
  });
}

function reduceProcessorRuntime(args: {
  processor: RegisteredProcessor;
  event: StreamEvent;
  state: unknown;
}): RuntimeProcessorReduction | undefined {
  const eventDefinition = getConsumedEventDefinition({
    contract: args.processor.contract,
    eventType: args.event.type,
  });
  if (eventDefinition == null) return undefined;

  const event = getEventSchema({
    type: args.event.type,
    payloadSchema: eventDefinition.payloadSchema,
  }).parse(args.event);
  const previousState = args.state;
  const reduce = args.processor.contract.reduce as
    | ((input: { contract: RunnerContract; state: unknown; event: StreamEvent }) => unknown)
    | undefined;
  const nextState =
    reduce?.({
      contract: args.processor.contract,
      state: args.state,
      event,
    }) ?? args.state;

  if (typeof nextState !== "object" || nextState === null || Array.isArray(nextState)) {
    throw new Error(`Processor "${args.processor.contract.slug}" state must be an object.`);
  }

  return {
    event,
    previousState,
    state: nextState,
  };
}

function getConsumedEventDefinition(args: {
  contract: RunnerContract;
  eventType: string;
}): EventDefinition | undefined {
  if (!args.contract.consumes.includes(args.eventType)) {
    if (args.contract.consumesAllEvents === true) {
      return {
        payloadSchema: z.unknown(),
      };
    }
    return undefined;
  }

  const eventDefinition = getResolvedEventDefinition({
    contract: args.contract,
    eventType: args.eventType,
  });
  if (eventDefinition == null) {
    throw new Error(`Unresolved stream processor consumes event type "${args.eventType}".`);
  }
  return eventDefinition;
}

function getResolvedEventDefinition(args: {
  contract: RunnerContract;
  eventType: string;
}): EventDefinition | undefined {
  const localEventDefinition = args.contract.events[args.eventType];
  if (localEventDefinition != null) return localEventDefinition;

  for (const dependency of args.contract.processorDeps ?? []) {
    const dependencyEvents = getDependencyEvents(dependency);
    const dependencyEventDefinition = dependencyEvents?.[args.eventType];
    if (dependencyEventDefinition != null) return dependencyEventDefinition;
  }

  return undefined;
}

function getDependencyEvents(dependency: unknown): EventCatalog | undefined {
  if (
    typeof dependency === "object" &&
    dependency !== null &&
    "events" in dependency &&
    typeof dependency.events === "object" &&
    dependency.events !== null
  ) {
    return dependency.events as EventCatalog;
  }

  if (typeof dependency === "object" && dependency !== null) {
    return dependency as EventCatalog;
  }

  return undefined;
}

function addProcessorProvenance(args: {
  event: EventInput;
  processor: RegisteredProcessor;
  processingEvent?: StreamEvent;
}) {
  const existingMetadata = args.event.metadata ?? {};
  const existingProvenance =
    typeof existingMetadata.provenance === "object" &&
    existingMetadata.provenance !== null &&
    !Array.isArray(existingMetadata.provenance)
      ? existingMetadata.provenance
      : {};

  return {
    ...existingMetadata,
    provenance: {
      ...existingProvenance,
      processor: {
        slug: args.processor.contract.slug,
        version: args.processor.contract.version,
      },
      ...(args.processingEvent == null
        ? {}
        : {
            whileProcessingEvent: {
              streamPath: args.processingEvent.streamPath,
              offset: args.processingEvent.offset,
              type: args.processingEvent.type,
            },
          }),
    },
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
