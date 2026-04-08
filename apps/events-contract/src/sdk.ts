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

export function createEventsClient(baseUrl: string): EventsORPCClient {
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
  reduce?(args: { event: Event; logger: ProcessorLogger; state: State }): State;
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
  appendedEvent(args: { appendedEvent: Event; sourceEvent: Event }): void;
  catchupComplete(args: {
    lastOffset?: number;
    reducedCount: number;
    state: State;
    streamPath: StreamPath;
  }): void;
  catchupStart(args: { streamPath: StreamPath }): void;
  error(args: { error: unknown; headline: string }): void;
  liveEvent(args: { event: Event }): void;
  liveReduce(args: { event: Event; state: State }): void;
  patternDecision(args: {
    alreadySubscribed: boolean;
    matched: boolean;
    streamPath: StreamPath;
    streamPattern: string;
  }): void;
  watchPattern(args: { streamPattern: string }): void;
};

export class PullSubscriptionProcessorRuntime<State> {
  #controller = new AbortController();
  #eventsClient: PullSubscriptionEventsClient;
  #processorLogger: ProcessorLogger;
  #runtimeLogger: PullSubscriptionRuntimeLogger<State>;
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
    this.#runtimeLogger = createPullSubscriptionRuntimeLogger({
      logger,
      processorSlug: processor.slug,
      scope: "stream",
    });
    this.#processor = processor;
    this.#state = structuredClone(this.#processor.initialState) as State;
    this.#streamPath = streamPath;
  }

  async run() {
    try {
      this.#runtimeLogger.catchupStart({ streamPath: this.#streamPath });

      const historyStream = await this.#eventsClient.stream(
        {
          path: this.#streamPath,
          beforeOffset: "end",
        },
        { signal: this.#controller.signal },
      );
      let lastOffset: number | undefined;
      let reducedHistoryEventCount = 0;

      for await (const event of historyStream) {
        if (this.#controller.signal.aborted) {
          return;
        }

        lastOffset = event.offset;
        reducedHistoryEventCount += 1;
        this.#reduce(event);
      }

      if (this.#controller.signal.aborted) {
        return;
      }

      this.#runtimeLogger.catchupComplete({
        lastOffset,
        reducedCount: reducedHistoryEventCount,
        state: this.#state,
        streamPath: this.#streamPath,
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

        this.#runtimeLogger.afterAppendStart({ event });
        await this.#processor.afterAppend({
          append: async (input: ProcessorAppendInput) => {
            const result = await this.#eventsClient.append({
              path: resolveAppendPath({
                currentPath: this.#streamPath,
                nextPath: input.path,
              }),
              event: input.event,
            });
            this.#runtimeLogger.appendedEvent({
              appendedEvent: result.event,
              sourceEvent: event,
            });
            return result.event;
          },
          event,
          logger: this.#processorLogger,
          state: this.#state,
        });
        this.#runtimeLogger.afterAppendComplete({ event });
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

  #reduce(event: Event) {
    if (this.#processor.reduce == null) {
      return false;
    }

    this.#state = this.#processor.reduce({
      event,
      logger: this.#processorLogger,
      state: structuredClone(this.#state),
    });
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

    this.#state = this.#processor.reduce({
      event,
      logger: this.#processorLogger,
      state: structuredClone(this.#state),
    });
  }
}

export class PullSubscriptionPatternProcessorRuntime<State> {
  #controller = new AbortController();
  #eventsClient: PullSubscriptionEventsClient;
  #fatalError: unknown;
  #processorLogger: ProcessorLogger;
  #runtimeLogger: PullSubscriptionRuntimeLogger<State>;
  #processor: Processor<State>;
  #runtimeByStreamPath = new Map<StreamPath, PullSubscriptionProcessorRuntime<State>>();
  #runPromiseByStreamPath = new Map<StreamPath, Promise<void>>();
  #streamPattern: string;

  constructor({
    eventsClient,
    logger = console,
    processor,
    streamPattern,
  }: {
    eventsClient: PullSubscriptionEventsClient;
    logger?: ProcessorLogger;
    processor: Processor<State>;
    streamPattern: string;
  }) {
    this.#eventsClient = eventsClient;
    this.#processorLogger = logger;
    this.#runtimeLogger = createPullSubscriptionRuntimeLogger({
      logger,
      processorSlug: processor.slug,
      scope: "pattern",
    });
    this.#processor = processor;
    this.#streamPattern = normalizeStreamPattern(streamPattern);
  }

  async run() {
    try {
      this.#runtimeLogger.watchPattern({ streamPattern: this.#streamPattern });

      const historyStream = await this.#eventsClient.stream(
        {
          path: "/",
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
        this.#startRuntimeIfMatched(event);
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
          path: "/",
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
        this.#startRuntimeIfMatched(event);

        if (this.#fatalError != null) {
          break;
        }
      }
    } catch (error) {
      if (!(this.#controller.signal.aborted && isAbortError(error))) {
        this.#runtimeLogger.error({
          error,
          headline: `Pattern runtime failed for ${formatPattern(this.#streamPattern)}.`,
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

  stop() {
    this.#controller.abort();

    for (const runtime of this.#runtimeByStreamPath.values()) {
      runtime.stop();
    }
  }

  getStreamPaths() {
    return [...this.#runtimeByStreamPath.keys()].sort();
  }

  getState(streamPath: StreamPath) {
    return this.#runtimeByStreamPath.get(streamPath)?.getState();
  }

  #startRuntimeIfMatched(event: Event) {
    const streamPath = getDiscoveredStreamPath(event);
    if (streamPath == null) {
      return;
    }

    const matched = matchesStreamPattern(streamPath, this.#streamPattern);
    const alreadySubscribed = this.#runtimeByStreamPath.has(streamPath);
    this.#runtimeLogger.patternDecision({
      alreadySubscribed,
      matched,
      streamPath,
      streamPattern: this.#streamPattern,
    });

    if (!matched || alreadySubscribed) {
      return;
    }

    try {
      const runtime = new PullSubscriptionProcessorRuntime({
        eventsClient: this.#eventsClient,
        logger: this.#processorLogger,
        processor: this.#processor,
        streamPath,
      });
      const runPromise = runtime.run().catch((error) => {
        if (this.#controller?.signal.aborted && isAbortError(error)) {
          return;
        }

        this.#fail(
          new Error(`Processor ${runtime.getProcessorSlug()} failed for stream ${streamPath}`, {
            cause: error,
          }),
        );
      });

      this.#runtimeByStreamPath.set(streamPath, runtime);
      this.#runPromiseByStreamPath.set(streamPath, runPromise);
    } catch (error) {
      this.#fail(error);
    }
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
}: {
  logger: ProcessorLogger;
  processorSlug: string;
  scope: "pattern" | "stream";
}): PullSubscriptionRuntimeLogger<State> {
  const prefix = formatRuntimeLogPrefix({ processorSlug, scope });

  return {
    watchPattern({ streamPattern }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Watching for streams matching pattern ${formatPattern(streamPattern)}.`,
      );
    },

    patternDecision({ alreadySubscribed, matched, streamPath, streamPattern }) {
      if (matched && !alreadySubscribed) {
        logPrettyBlock(
          logger.info.bind(logger),
          prefix,
          `Subscribing to new stream ${formatPath(streamPath)} as it matches pattern ${formatPattern(streamPattern)}.`,
        );
        return;
      }

      if (matched) {
        logPrettyBlock(
          logger.info.bind(logger),
          prefix,
          `Already subscribed to stream ${formatPath(streamPath)} because it matches pattern ${formatPattern(streamPattern)}.`,
        );
        return;
      }

      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Ignoring new stream ${formatPath(streamPath)} because it does not match pattern ${formatPattern(streamPattern)}.`,
      );
    },

    catchupStart({ streamPath }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Catching up to stream ${formatPath(streamPath)}.`,
      );
    },

    catchupComplete({ lastOffset, reducedCount, state }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Reduced ${formatEventCount(reducedCount)} up to offset ${formatOffsetValue(lastOffset)}.`,
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
        `afterAppend for ${formatEventReference(event)}.`,
      );
    },

    afterAppendComplete({ event }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `afterAppend complete for ${formatEventReference(event)}.`,
      );
    },

    appendedEvent({ appendedEvent, sourceEvent }) {
      logPrettyBlock(
        logger.info.bind(logger),
        prefix,
        `Appended ${formatEventReference(appendedEvent)} while handling ${formatEventReference(sourceEvent)}.`,
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

function formatRuntimeLogPrefix(args: { processorSlug: string; scope: "pattern" | "stream" }) {
  const scope =
    args.scope === "pattern"
      ? colorize(`pattern:${args.processorSlug}`, ANSI.magenta)
      : colorize(`stream:${args.processorSlug}`, ANSI.cyan);
  return `${colorize("[", ANSI.gray)}${scope}${colorize("]", ANSI.gray)}`;
}

function formatPath(path: string) {
  return colorize(path, ANSI.cyan);
}

function formatPattern(pattern: string) {
  return colorize(pattern, ANSI.magenta);
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
