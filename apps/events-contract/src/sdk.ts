import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "./orpc-contract.ts";
import {
  ChildStreamCreatedEvent,
  EventInput as EventInputSchema,
  GenericEventInput,
  StreamPath as StreamPathSchema,
  StreamInitializedEvent,
  type Event,
  type EventType,
  type JSONObject,
  type StreamCursor,
  type StreamPath,
} from "./types.ts";

export { eventsContract, EventInputSchema as EventInput, GenericEventInput };
export type { Event, EventType, JSONObject, StreamPath } from "./types.ts";

export type EventsORPCClient = ContractRouterClient<typeof eventsContract>;

const DEFAULT_EVENTS_BASE_URL = "https://events.iterate.com";
// HACK:
// Pull runtimes intentionally do not track durable "last processed" offsets.
// That means they are safe to point at an existing stream with lots of history:
// we reduce that history to rebuild state, but we do not re-run afterAppend()
// and accidentally repeat side effects.
//
// That default is still what we want in general.
//
// The awkward product problem is a narrower case: in includeChildren mode we can
// discover a brand new child stream from the live tail of the parent. That child
// often already has a tiny seed history when we attach to it:
//   1. stream/initialized
//   2. maybe 1-2 user/domain events
//
// In that case, "never run afterAppend() for history" feels wrong, because the
// stream was just created and those first few events are effectively happening
// "right now".
//
// So we have a deliberately narrow hack:
// - only for child runtimes discovered from the *live* tail of the parent
// - only if the child history is tiny
// - only if the first event is stream/initialized
// - only if that initialized event is very recent
//
// If all of those are true, we replay afterAppend() for that small catch-up
// window. We do *not* make this a general catch-up policy, because doing so
// would reintroduce duplicated side effects when attaching to older streams.
const LIVE_DISCOVERED_HISTORY_AFTER_APPEND_REPLAY_MAX_AGE_MS = 10_000;
const LIVE_DISCOVERED_HISTORY_AFTER_APPEND_REPLAY_MAX_EVENT_COUNT = 5;

export function createEventsClient(baseUrl: string = DEFAULT_EVENTS_BASE_URL): EventsORPCClient {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
    }),
  ) as EventsORPCClient;
}

export type RelativeStreamPath = `.${string}`;
export type ProcessorAppendInput = {
  event: import("./types.ts").EventInput;
  path?: StreamPath | RelativeStreamPath;
};

export type ProcessorLogger = Pick<Console, "debug" | "error" | "info" | "log" | "warn">;

type ProcessorMethods<State> = {
  reduce?(args: { event: Event; logger: ProcessorLogger; state: State }): State | void;
  afterAppend?(args: {
    append: (input: ProcessorAppendInput) => Event | Promise<Event>;
    event: Event;
    logger: ProcessorLogger;
    state: State;
  }): Promise<void>;
};

export type Processor<State = undefined> = {
  slug: string;
  initialState?: State;
} & ProcessorMethods<State>;

/**
 * A BuiltinProcessor runs in-process inside the Durable Object, so it can
 * synchronously reject events via `beforeAppend` before they are committed.
 * Non-builtin processors cannot do this because they may execute across the
 * network where synchronous rejection is not possible.
 */
export type BuiltinProcessor<TState = Record<string, unknown>> = {
  slug: string;
  initialState: TState;
  beforeAppend?(args: { event: import("./types.ts").EventInput; state: TState }): void;
  reduce?(args: { event: Event; state: TState }): TState;
  afterAppend?(args: {
    append: (event: import("./types.ts").EventInput) => Event | Promise<Event>;
    event: Event;
    state: TState;
  }): Promise<void>;
};

export function defineProcessor<const TState = undefined>(
  factory: () => Processor<TState>,
): Processor<TState> {
  return factory();
}

export function defineBuiltinProcessor<const TState>(
  factory: () => BuiltinProcessor<TState>,
): BuiltinProcessor<TState> {
  return factory();
}

type PullSubscriptionEventsClient = {
  append: (input: { path: StreamPath; event: import("./types.ts").EventInput }) => Promise<{
    event: Event;
  }>;
  stream: (
    input: { path: StreamPath; afterOffset?: StreamCursor; beforeOffset?: StreamCursor },
    options: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<Event>>;
};

type PullSubscriptionRuntimeLogger<State> = {
  afterAppendComplete(args: { event: Event }): void;
  afterAppendStart(args: { event: Event }): void;
  appendedEvent(args: {
    appendedEvent: Event;
    sourceEvent: Event;
    targetPath?: StreamPath | RelativeStreamPath;
  }): void;
  catchupComplete(args: {
    lastOffset?: number;
    reducedCount: number;
    state: State;
    streamPath: StreamPath;
  }): void;
  error(args: { error: unknown; headline: string }): void;
  liveEvent(args: { event: Event }): void;
  liveReduce(args: { event: Event; state: State }): void;
  patternDecision(args: {
    alreadySubscribed: boolean;
    matched: boolean;
    streamPath: StreamPath;
    streamPattern: string;
  }): void;
  subscriptionStart(args: { streamPath: StreamPath }): void;
};

type HistoryAfterAppendReplayConfig = {
  maxAgeMs: number;
  maxEventCount: number;
};

class PullSubscriptionProcessorRuntime<State> {
  #controller = new AbortController();
  #eventsClient: PullSubscriptionEventsClient;
  #historyAfterAppendReplay: HistoryAfterAppendReplayConfig | undefined;
  #processorLogger: ProcessorLogger;
  #runtimeLogger: PullSubscriptionRuntimeLogger<State>;
  #processor: Processor<State>;
  #state: State;
  #streamPath: StreamPath;

  constructor({
    eventsClient,
    historyAfterAppendReplay,
    logger = console,
    processor,
    streamPath,
  }: {
    eventsClient: PullSubscriptionEventsClient;
    historyAfterAppendReplay?: HistoryAfterAppendReplayConfig;
    logger?: ProcessorLogger;
    processor: Processor<State>;
    streamPath: StreamPath;
  }) {
    this.#eventsClient = eventsClient;
    this.#historyAfterAppendReplay = historyAfterAppendReplay;
    this.#processorLogger = logger;
    this.#runtimeLogger = createPullSubscriptionRuntimeLogger({
      logger,
      processorSlug: processor.slug,
      scope: "stream",
      streamPath,
    });
    this.#processor = processor;
    this.#state = structuredClone(this.#processor.initialState) as State;
    this.#streamPath = streamPath;
  }

  async run() {
    try {
      const historyStream = await this.#eventsClient.stream(
        {
          path: this.#streamPath,
          beforeOffset: "end",
        },
        { signal: this.#controller.signal },
      );
      let lastOffset: number | undefined;
      let reducedHistoryEventCount = 0;
      // This buffer exists only for the narrow "fresh child discovered live"
      // hack described above.
      //
      // Important detail: afterAppend() must observe the reducer state as it
      // looked immediately after *that specific event*, not the final state
      // after all history has been reduced.
      //
      // To preserve that behavior without adding persistent offset tracking or
      // refactoring the runtime around a second reducer pass, we capture a tiny
      // list of { event, postReduceState } pairs while catching up.
      //
      // We only even allocate this buffer when a caller explicitly opted this
      // runtime into history-side replay.
      const historyAfterAppendEntries: Array<{ event: Event; state: State }> | undefined =
        this.#processor.afterAppend != null && this.#historyAfterAppendReplay != null
          ? []
          : undefined;
      // Once the history grows beyond our tiny cap, we permanently abandon the
      // replay idea for this runtime. That keeps the hack obviously bounded and
      // avoids "surprising" work on real historical streams.
      let historyAfterAppendExceededMaxEventCount = false;

      for await (const event of historyStream) {
        if (this.#controller.signal.aborted) {
          return;
        }

        lastOffset = event.offset;
        reducedHistoryEventCount += 1;
        this.#reduce(event);

        if (historyAfterAppendEntries == null || historyAfterAppendExceededMaxEventCount) {
          continue;
        }

        if (historyAfterAppendEntries.length >= this.#historyAfterAppendReplay!.maxEventCount) {
          // We intentionally stop buffering instead of trimming or doing
          // something clever. If the history is not tiny, we treat it as normal
          // catch-up history and do not run history-side afterAppend().
          historyAfterAppendExceededMaxEventCount = true;
          continue;
        }

        historyAfterAppendEntries.push({
          // Snapshot the post-reduce state for this exact event so a later
          // afterAppend() replay observes the same state shape/counts it would
          // have seen if the runtime had been attached at append time.
          event,
          state: structuredClone(this.#state) as State,
        });
      }

      if (this.#controller.signal.aborted) {
        return;
      }

      if (this.#processor.reduce != null) {
        this.#runtimeLogger.catchupComplete({
          lastOffset,
          reducedCount: reducedHistoryEventCount,
          state: this.#state,
          streamPath: this.#streamPath,
        });
      }

      await this.#replayFreshHistoryAfterAppend({
        entries: historyAfterAppendEntries,
        exceededMaxEventCount: historyAfterAppendExceededMaxEventCount,
      });

      const liveStream = await this.#eventsClient.stream(
        {
          path: this.#streamPath,
          afterOffset: toLiveTailCursor(lastOffset),
        },
        {
          signal: this.#controller.signal,
        },
      );

      for await (const event of liveStream) {
        if (event.offset === lastOffset) {
          continue;
        }

        lastOffset = event.offset;
        const didReduce = this.#reduce(event);
        if (didReduce) {
          this.#runtimeLogger.liveReduce({ event, state: this.#state });
        } else {
          this.#runtimeLogger.liveEvent({ event });
        }

        if (this.#processor.afterAppend == null) {
          continue;
        }

        await this.#runAfterAppend({
          event,
          state: this.#state,
        });
      }
    } catch (error) {
      if (this.#controller.signal.aborted && isAbortError(error)) {
        return;
      }

      this.#runtimeLogger.error({
        error,
        headline: `Processor runtime failed for stream ${formatPath(this.#streamPath)}.`,
      });
      throw error;
    }
  }

  stop() {
    this.#controller.abort();
  }

  getState() {
    return this.#state;
  }

  getProcessorSlug() {
    return this.#processor.slug;
  }

  async #replayFreshHistoryAfterAppend(args: {
    entries: Array<{ event: Event; state: State }> | undefined;
    exceededMaxEventCount: boolean;
  }) {
    // This whole method is an intentional compromise.
    //
    // Normal pull-runtime semantics:
    // - history rebuilds state
    // - live events get afterAppend()
    //
    // Special-case semantics here:
    // - if this runtime was spawned because we *just now* discovered a child
    //   stream on the live tail of the parent
    // - and that child looks like a freshly created stream with a tiny history
    // then replay afterAppend() for that tiny history window.
    //
    // The goal is to recover the intuitive behavior for brand new streams
    // without turning historical catch-up into a side-effect replay engine.
    if (
      this.#processor.afterAppend == null ||
      this.#historyAfterAppendReplay == null ||
      args.entries == null ||
      args.entries.length === 0 ||
      args.exceededMaxEventCount
    ) {
      return;
    }

    const firstEvent = args.entries[0]?.event;
    // Require stream/initialized as the first event. This keeps the hack tied
    // to streams that really look newly created, rather than any arbitrary
    // stream whose recent history happened to be short.
    if (firstEvent == null || !StreamInitializedEvent.safeParse(firstEvent).success) {
      return;
    }

    const initializedAt = Date.parse(firstEvent.createdAt);
    // Age gate: if the stream was not initialized recently, we fall back to the
    // normal "history is reduce-only" behavior. This avoids replaying side
    // effects when a runtime merely attaches late to an already-existing stream.
    if (
      !Number.isFinite(initializedAt) ||
      Date.now() - initializedAt > this.#historyAfterAppendReplay.maxAgeMs
    ) {
      return;
    }

    for (const entry of args.entries) {
      // Each entry carries the post-reduce state for *that* source event.
      // This is the key correctness property for the hack.
      await this.#runAfterAppend(entry);
    }
  }

  async #runAfterAppend(args: { event: Event; state: State }) {
    if (this.#processor.afterAppend == null) {
      return;
    }

    this.#runtimeLogger.afterAppendStart({ event: args.event });
    await this.#processor.afterAppend({
      append: async (input: ProcessorAppendInput) => {
        const resolvedPath = resolveAppendPath({
          currentPath: this.#streamPath,
          nextPath: input.path,
        });
        const result = await this.#eventsClient.append({
          path: resolvedPath,
          event: input.event,
        });
        this.#runtimeLogger.appendedEvent({
          appendedEvent: result.event,
          sourceEvent: args.event,
          targetPath: input.path,
        });
        return result.event;
      },
      event: args.event,
      logger: this.#processorLogger,
      state: args.state,
    });
    this.#runtimeLogger.afterAppendComplete({ event: args.event });
  }

  #reduce(event: Event) {
    if (this.#processor.reduce == null) {
      return false;
    }

    const nextState = this.#processor.reduce({
      event,
      logger: this.#processorLogger,
      state: structuredClone(this.#state),
    });
    if (nextState === undefined) {
      return false;
    }

    this.#state = nextState as State;
    return true;
  }
}

export class PushSubscriptionProcessorRuntime<State> {
  #eventsClient: PullSubscriptionEventsClient;
  #lastOffset = 0;
  #pending = Promise.resolve();
  #processorLogger: ProcessorLogger;
  #processor: Processor<State>;
  #state: State;
  #streamPath: StreamPath;

  constructor({
    eventsClient,
    logger = console,
    processor,
    streamPath,
  }: {
    eventsClient: PullSubscriptionEventsClient;
    logger?: ProcessorLogger;
    processor: Processor<State>;
    streamPath: StreamPath;
  }) {
    this.#eventsClient = eventsClient;
    this.#processorLogger = logger;
    this.#processor = processor;
    this.#state = structuredClone(this.#processor.initialState) as State;
    this.#streamPath = streamPath;
  }

  async consume(event: Event) {
    const next = this.#pending.then(() => this.#consumeEvent(event));
    this.#pending = next.catch(() => {});
    await next;
  }

  getState() {
    return this.#state;
  }

  getProcessorSlug() {
    return this.#processor.slug;
  }

  async #consumeEvent(event: Event) {
    if (event.streamPath !== this.#streamPath) {
      throw new Error(
        `Push runtime for ${this.#streamPath} received event for ${event.streamPath}`,
      );
    }

    if (event.offset > this.#lastOffset + 1) {
      await this.#catchUpTo(event.offset);
    }

    if (event.offset <= this.#lastOffset) {
      return;
    }

    this.#reduce(event);
    this.#lastOffset = event.offset;

    await this.#processor.afterAppend?.({
      append: this.#append,
      event,
      logger: this.#processorLogger,
      state: this.#state,
    });
  }

  async #catchUpTo(targetOffset: number) {
    const historyStream = await this.#eventsClient.stream(
      {
        path: this.#streamPath,
        afterOffset: this.#lastOffset > 0 ? this.#lastOffset : "start",
        beforeOffset: targetOffset,
      },
      {},
    );

    for await (const event of historyStream) {
      if (event.offset <= this.#lastOffset) {
        continue;
      }

      this.#reduce(event);
      this.#lastOffset = event.offset;
    }
  }

  #append = async (input: ProcessorAppendInput) => {
    const result = await this.#eventsClient.append({
      path: resolveAppendPath({
        currentPath: this.#streamPath,
        nextPath: input.path,
      }),
      event: input.event,
    });
    return result.event;
  };

  #reduce(event: Event) {
    if (this.#processor.reduce == null) {
      return;
    }

    const nextState = this.#processor.reduce({
      event,
      logger: this.#processorLogger,
      state: structuredClone(this.#state),
    });
    if (nextState === undefined) {
      return;
    }

    this.#state = nextState as State;
  }
}

/**
 * Unified pull-based processor runtime that subscribes to a stream and
 * processes events through catch-up replay followed by a live tail.
 *
 * When `includeChildren` is `true` (the default), the runtime processes
 * the stream at `path` directly, watches `path` for `child-stream-created`
 * events, and spawns an independent processor instance for each discovered
 * descendant stream. The stream tree propagates structural events to
 * ancestors, so all descendants are automatically discovered without
 * polling the root stream.
 *
 * When `includeChildren` is `false`, only the single stream at `path`
 * is processed directly.
 */
export class PullProcessorRuntime<State> {
  #controller = new AbortController();
  #eventsClient: PullSubscriptionEventsClient;
  #fatalError: unknown;
  #includeChildren: boolean;
  #path: StreamPath;
  #processorLogger: ProcessorLogger;
  #processor: Processor<State>;
  #runtimeLogger: PullSubscriptionRuntimeLogger<State>;
  #runtimeByStreamPath = new Map<StreamPath, PullSubscriptionProcessorRuntime<State>>();
  #runPromiseByStreamPath = new Map<StreamPath, Promise<void>>();

  constructor({
    eventsClient,
    includeChildren = true,
    logger = console,
    path,
    processor,
  }: {
    /** Client used to read from and append to streams. Defaults to the public events API. */
    eventsClient?: PullSubscriptionEventsClient;
    /**
     * The runtime always processes the stream at `path`.
     * When `true` (default), it also watches `path` for
     * `child-stream-created` events and runs the processor on each
     * discovered descendant stream.
     */
    includeChildren?: boolean;
    /** Logger forwarded to the processor's `reduce` and `afterAppend` hooks. */
    logger?: ProcessorLogger;
    /** Stream path to subscribe to. */
    path: string;
    /** Processor definition with `reduce` and/or `afterAppend` hooks. */
    processor: Processor<State>;
  }) {
    this.#eventsClient = eventsClient ?? (createEventsClient() as PullSubscriptionEventsClient);
    this.#includeChildren = includeChildren;
    this.#path = normalizePathPrefix(path);
    this.#processorLogger = logger;
    this.#processor = processor;
    this.#runtimeLogger = createPullSubscriptionRuntimeLogger({
      logger,
      processorSlug: processor.slug,
      scope: includeChildren ? "pattern" : "stream",
      streamPath: includeChildren ? undefined : this.#path,
    });

    const runtime = new PullSubscriptionProcessorRuntime({
      eventsClient: this.#eventsClient,
      logger,
      processor,
      streamPath: this.#path,
    });
    this.#runtimeByStreamPath.set(this.#path, runtime);
  }

  /**
   * Start the runtime. Replays historical events, then follows the live
   * tail until {@link stop} is called or a fatal error occurs.
   */
  async run() {
    if (this.#includeChildren) {
      return this.#runWithChildren();
    }
    return this.#runSingle();
  }

  /** Abort all active subscriptions and stop the runtime. */
  stop() {
    this.#controller.abort();

    for (const runtime of this.#runtimeByStreamPath.values()) {
      runtime.stop();
    }
  }

  /**
   * Returns the sorted list of stream paths the runtime is subscribed to.
   * In single-stream mode this is `[path]`. In child-discovery mode this
   * includes `path` itself plus any discovered descendant paths.
   */
  getStreamPaths(): StreamPath[] {
    if (!this.#includeChildren) {
      return [this.#path];
    }
    return [...this.#runtimeByStreamPath.keys()].sort();
  }

  /**
   * Returns the reduced processor state.
   *
   * In single-stream mode (`includeChildren: false`), call with no
   * argument to get the state. In child-discovery mode, pass a specific
   * root or descendant stream path. Returns `undefined` when the path has
   * no active subscription.
   */
  getState(path?: StreamPath): State | undefined {
    if (!this.#includeChildren) {
      return this.#runtimeByStreamPath.get(this.#path)?.getState();
    }
    if (path == null) {
      return undefined;
    }
    return this.#runtimeByStreamPath.get(path)?.getState();
  }

  /** Returns the processor's slug identifier. */
  getProcessorSlug() {
    return this.#processor.slug;
  }

  async #runSingle() {
    const runtime = this.#runtimeByStreamPath.get(this.#path);
    if (runtime == null || this.#controller.signal.aborted) {
      return;
    }
    this.#runtimeLogger.subscriptionStart({ streamPath: this.#path });
    await runtime.run();
  }

  async #runWithChildren() {
    const streamPattern = createDescendantStreamPattern(this.#path);
    this.#runtimeLogger.subscriptionStart({ streamPath: this.#path });
    this.#startRuntime(this.#path);

    try {
      const historyStream = await this.#eventsClient.stream(
        {
          path: this.#path,
          beforeOffset: "end",
        },
        { signal: this.#controller.signal },
      );
      let lastOffset: number | undefined;

      for await (const event of historyStream) {
        if (this.#controller.signal.aborted) {
          break;
        }

        lastOffset = event.offset;
        this.#startChildRuntimeIfDiscovered(event, streamPattern, false);
      }

      if (this.#fatalError != null || this.#controller.signal.aborted) {
        this.stop();
        await this.#waitForStreamRuntimes();

        if (this.#fatalError != null) {
          throw this.#fatalError;
        }

        return;
      }

      const liveStream = await this.#eventsClient.stream(
        {
          path: this.#path,
          afterOffset: toLiveTailCursor(lastOffset),
        },
        { signal: this.#controller.signal },
      );

      for await (const event of liveStream) {
        if (event.offset === lastOffset) {
          continue;
        }

        lastOffset = event.offset;
        this.#startChildRuntimeIfDiscovered(event, streamPattern, true);

        if (this.#fatalError != null) {
          break;
        }
      }
    } catch (error) {
      if (!(this.#controller.signal.aborted && isAbortError(error))) {
        this.#runtimeLogger.error({
          error,
          headline: `Child discovery failed for ${formatPath(this.#path)}.`,
        });
        this.#fail(error);
      }
    }

    this.stop();
    await this.#waitForStreamRuntimes();

    if (this.#fatalError != null) {
      throw this.#fatalError;
    }
  }

  #startChildRuntimeIfDiscovered(
    event: Event,
    streamPattern: string,
    discoveredDuringLiveTail: boolean,
  ) {
    const discoveredPath = getDiscoveredStreamPath(event);
    if (discoveredPath == null) {
      return;
    }

    const alreadySubscribed = this.#runtimeByStreamPath.has(discoveredPath);
    this.#runtimeLogger.patternDecision({
      alreadySubscribed,
      matched: true,
      streamPath: discoveredPath,
      streamPattern,
    });

    if (alreadySubscribed) {
      return;
    }

    try {
      const runtime = new PullSubscriptionProcessorRuntime({
        eventsClient: this.#eventsClient,
        // HACK:
        // Only child streams discovered from the parent's live tail are allowed
        // to do the tiny history-side afterAppend() replay.
        //
        // Child streams discovered while replaying the parent's own history are
        // treated as ordinary historical streams. Those should rebuild state but
        // should not re-fire side effects.
        historyAfterAppendReplay: discoveredDuringLiveTail
          ? {
              maxAgeMs: LIVE_DISCOVERED_HISTORY_AFTER_APPEND_REPLAY_MAX_AGE_MS,
              maxEventCount: LIVE_DISCOVERED_HISTORY_AFTER_APPEND_REPLAY_MAX_EVENT_COUNT,
            }
          : undefined,
        logger: this.#processorLogger,
        processor: this.#processor,
        streamPath: discoveredPath,
      });
      this.#runtimeByStreamPath.set(discoveredPath, runtime);
      this.#startRuntime(discoveredPath);
    } catch (error) {
      this.#fail(error);
    }
  }

  #startRuntime(streamPath: StreamPath) {
    const runtime = this.#runtimeByStreamPath.get(streamPath);
    if (runtime == null || this.#runPromiseByStreamPath.has(streamPath)) {
      return;
    }

    const runPromise = runtime.run().catch((error) => {
      if (this.#controller.signal.aborted && isAbortError(error)) {
        return;
      }

      this.#fail(
        new Error(`Processor ${runtime.getProcessorSlug()} failed for stream ${streamPath}`, {
          cause: error,
        }),
      );
    });

    this.#runPromiseByStreamPath.set(streamPath, runPromise);
  }

  async #waitForStreamRuntimes() {
    await Promise.allSettled(this.#runPromiseByStreamPath.values());
  }

  #fail(error: unknown) {
    if (this.#fatalError != null) {
      return;
    }

    this.#fatalError = error;
    this.stop();
  }
}

function createPullSubscriptionRuntimeLogger<State>({
  logger,
  processorSlug,
  scope,
  streamPath,
}: {
  logger: ProcessorLogger;
  processorSlug: string;
  scope: "pattern" | "stream";
  streamPath?: StreamPath;
}): PullSubscriptionRuntimeLogger<State> {
  const prefix = formatRuntimeLogPrefix({ processorSlug, scope, streamPath });

  return {
    patternDecision({ alreadySubscribed, matched, streamPath }) {
      if (alreadySubscribed) {
        return;
      }

      if (!matched) {
        return;
      }

      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Subscribing to stream ${formatPath(streamPath)}.`,
      );
    },

    subscriptionStart({ streamPath }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Subscribing to stream ${formatPath(streamPath)}.`,
      );
    },

    catchupComplete({ lastOffset, reducedCount, state }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Catch-up reduced ${formatEventCount(reducedCount)} up to offset ${formatOffsetValue(lastOffset)}.`,
        [
          {
            label: "Reduced state:",
            value: formatPrettyJson(state),
          },
        ],
      );
    },

    liveReduce({ event, state }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Live reduce for ${formatEventReference(event)}.`,
        [
          { label: "Input event:", value: formatPrettyJson(event) },
          { label: "Reduced state:", value: formatPrettyJson(state) },
        ],
      );
    },

    liveEvent({ event }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Received live event ${formatEventReference(event)}.`,
        [{ label: "Input event:", value: formatPrettyJson(event) }],
      );
    },

    afterAppendStart({ event }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Running afterAppend for ${formatEventReference(event)}.`,
      );
    },

    afterAppendComplete({ event }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `afterAppend complete for ${formatEventReference(event)}.`,
      );
    },

    appendedEvent({ appendedEvent, sourceEvent, targetPath }) {
      const targetSuffix = targetPath ? ` to ${formatPath(appendedEvent.streamPath)}` : "";
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Appended ${formatEventReference(appendedEvent)}${targetSuffix} while handling ${formatEventReference(sourceEvent)}.`,
      );
    },

    error({ error, headline }) {
      logPrettyBlock(logger.error.bind(logger), prefix, colorize(headline, ANSI.red), [
        { label: "Error:", value: formatPrettyError(error) },
      ]);
    },
  };
}

const ANSI = {
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  magenta: "\u001b[35m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
} as const;

function logPrettyBlock(
  log: (...args: unknown[]) => void,
  prefix: string,
  headline: string,
  sections: Array<{ label: string; value?: string }> = [],
) {
  const lines = [`${prefix} ${headline}`];

  for (const section of sections) {
    lines.push(`  ${colorize(section.label, ANSI.gray)}`);
    if (section.value != null) {
      lines.push(indentBlock(section.value, 4));
    }
  }

  log(lines.join("\n"));
}

function formatRuntimeLogPrefix(args: {
  processorSlug: string;
  scope: "pattern" | "stream";
  streamPath?: string;
}) {
  if (args.scope === "stream" && args.streamPath) {
    const inner = `${colorize(args.processorSlug, ANSI.cyan)}${colorize(":", ANSI.gray)}${colorize(args.streamPath, ANSI.cyan)}`;
    return `${colorize("[", ANSI.gray)}${inner}${colorize("]", ANSI.gray)}`;
  }

  const scope =
    args.scope === "pattern"
      ? colorize(`pattern:${args.processorSlug}`, ANSI.magenta)
      : colorize(`stream:${args.processorSlug}`, ANSI.cyan);
  return `${colorize("[", ANSI.gray)}${scope}${colorize("]", ANSI.gray)}`;
}

function formatPath(path: string) {
  return colorize(path, ANSI.cyan);
}

function formatEventType(eventType: string) {
  return colorize(eventType, ANSI.green);
}

function formatEventOffset(offset: number) {
  return colorize(`#${offset}`, ANSI.yellow);
}

function formatOffsetValue(offset: number | undefined) {
  return offset == null ? colorize("none", ANSI.gray) : colorize(String(offset), ANSI.yellow);
}

function toLiveTailCursor(lastOffset: number | undefined): StreamCursor {
  return lastOffset == null ? "start" : lastOffset;
}

function formatEventCount(count: number) {
  return `${colorize(String(count), ANSI.yellow)} event${count === 1 ? "" : "s"}`;
}

function formatEventReference(event: Pick<Event, "offset" | "streamPath" | "type">) {
  return `${formatEventType(event.type)} ${formatEventOffset(event.offset)} ${formatPath(event.streamPath)}`;
}

function indentBlock(value: string, spaces: number) {
  const indentation = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n");
}

function formatPrettyJson(value: unknown) {
  return colorizeJson(safeJSONStringify(value));
}

function safeJSONStringify(value: unknown) {
  const seen = new WeakSet<object>();

  return (
    JSON.stringify(
      value,
      (_key, currentValue) => {
        if (typeof currentValue === "bigint") {
          return `${currentValue}n`;
        }

        if (currentValue instanceof Error) {
          return {
            message: currentValue.message,
            name: currentValue.name,
            stack: currentValue.stack,
          };
        }

        if (currentValue instanceof Map) {
          return Object.fromEntries(currentValue.entries());
        }

        if (currentValue instanceof Set) {
          return [...currentValue.values()];
        }

        if (typeof currentValue === "function") {
          return `[Function ${currentValue.name || "anonymous"}]`;
        }

        if (typeof currentValue === "symbol") {
          return currentValue.toString();
        }

        if (typeof currentValue === "object" && currentValue != null) {
          if (seen.has(currentValue)) {
            return "[Circular]";
          }

          seen.add(currentValue);
        }

        return currentValue;
      },
      2,
    ) ?? "null"
  );
}

function colorizeJson(json: string) {
  return json.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (token) => {
      if (token.startsWith('"') && token.endsWith(":")) {
        return colorize(token, ANSI.blue);
      }

      if (token.startsWith('"')) {
        return colorize(token, ANSI.green);
      }

      if (token === "true" || token === "false") {
        return colorize(token, ANSI.magenta);
      }

      if (token === "null") {
        return colorize(token, ANSI.gray);
      }

      return colorize(token, ANSI.yellow);
    },
  );
}

function formatPrettyError(error: unknown) {
  if (error instanceof Error) {
    return colorize(error.stack ?? `${error.name}: ${error.message}`, ANSI.red);
  }

  if (typeof error === "string") {
    return colorize(error, ANSI.red);
  }

  return formatPrettyJson(error);
}

function colorize(text: string, color: string) {
  return `${color}${text}${ANSI.reset}`;
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error != null && "name" in error && error.name === "AbortError")
  );
}

export function getDiscoveredStreamPath(event: Event): StreamPath | null {
  const childStreamCreatedEvent = ChildStreamCreatedEvent.safeParse(event);
  if (childStreamCreatedEvent.success) {
    return childStreamCreatedEvent.data.payload.childPath;
  }

  const streamInitializedEvent = StreamInitializedEvent.safeParse(event);
  if (streamInitializedEvent.success && streamInitializedEvent.data.streamPath === "/") {
    return streamInitializedEvent.data.streamPath;
  }

  return null;
}

export function normalizeStreamPattern(streamPattern: string) {
  return streamPattern.startsWith("/") ? streamPattern : `/${streamPattern}`;
}

function normalizePathPrefix(pathPrefix: string) {
  if (pathPrefix === "/") {
    return StreamPathSchema.parse(pathPrefix);
  }

  return StreamPathSchema.parse(normalizeStreamPattern(pathPrefix).replace(/\/+$/, ""));
}

function createDescendantStreamPattern(pathPrefix: string) {
  const normalizedPrefix = normalizePathPrefix(pathPrefix);
  return normalizedPrefix === "/" ? "/**" : `${normalizedPrefix}/**`;
}

function resolveAppendPath({
  currentPath,
  nextPath,
}: {
  currentPath: StreamPath;
  nextPath?: StreamPath | RelativeStreamPath;
}) {
  if (nextPath == null) {
    return currentPath;
  }

  if (nextPath.startsWith("/")) {
    return StreamPathSchema.parse(nextPath);
  }

  const normalizedRelativePath = normalizeRelativeAppendPath(nextPath);
  if (!isRelativeStreamPath(normalizedRelativePath)) {
    throw new Error(`append path must be absolute or dot-relative. Received: ${nextPath}`);
  }

  const segments = toPathSegments(currentPath);

  for (const segment of normalizedRelativePath.split("/")) {
    if (segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(`append path cannot walk above root. Received: ${nextPath}`);
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return StreamPathSchema.parse(`/${segments.join("/")}`);
}

function normalizeRelativeAppendPath(path: string) {
  if (path === "." || path === "..") {
    return path;
  }

  return path.replace(/\/+$/, "");
}

function isRelativeStreamPath(path: string): path is RelativeStreamPath {
  return path === "." || path === ".." || path.startsWith("./") || path.startsWith("../");
}

export function matchesStreamPattern(streamPath: string, streamPattern: string) {
  const pathSegments = toPathSegments(streamPath);
  const patternSegments = toPathSegments(streamPattern);
  return matchesPathSegments(pathSegments, patternSegments);
}

function toPathSegments(value: string) {
  return value.split("/").filter(Boolean);
}

function matchesPathSegments(pathSegments: string[], patternSegments: string[]): boolean {
  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  const [patternHead, ...patternTail] = patternSegments;

  if (patternHead === "**") {
    if (patternTail.length === 0) {
      return true;
    }

    for (let index = 0; index <= pathSegments.length; index += 1) {
      if (matchesPathSegments(pathSegments.slice(index), patternTail)) {
        return true;
      }
    }

    return false;
  }

  const [pathHead, ...pathTail] = pathSegments;
  if (pathHead == null) {
    return false;
  }

  if (patternHead === "*") {
    return matchesPathSegments(pathTail, patternTail);
  }

  return patternHead === pathHead && matchesPathSegments(pathTail, patternTail);
}
