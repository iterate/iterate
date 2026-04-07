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

export type Processor<State = Record<string, unknown>> = {
  slug: string;
  initialState: State;
  reduce?(args: { event: Event; state: State }): State;
  afterAppend?(args: {
    append: (input: ProcessorAppendInput) => Event | Promise<Event>;
    event: Event;
    state: State;
  }): Promise<void>;
};

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

export function defineProcessor<const TState>(factory: () => Processor<TState>): Processor<TState> {
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
    input: { path: StreamPath; offset?: number; live?: boolean },
    options: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<Event>>;
};

export class PullSubscriptionProcessorRuntime<State> {
  #controller = new AbortController();
  #eventsClient: PullSubscriptionEventsClient;
  #processor: Processor<State>;
  #state: State;
  #streamPath: StreamPath;

  constructor({
    eventsClient,
    processor,
    streamPath,
  }: {
    eventsClient: PullSubscriptionEventsClient;
    processor: Processor<State>;
    streamPath: StreamPath;
  }) {
    this.#eventsClient = eventsClient;
    this.#processor = processor;
    this.#state = structuredClone(this.#processor.initialState);
    this.#streamPath = streamPath;
  }

  async run() {
    const append = async (input: ProcessorAppendInput) => {
      const result = await this.#eventsClient.append({
        path: resolveAppendPath({
          currentPath: this.#streamPath,
          nextPath: input.path,
        }),
        event: input.event,
      });
      return result.event;
    };

    try {
      const historyStream = await this.#eventsClient.stream(
        { path: this.#streamPath },
        { signal: this.#controller.signal },
      );
      let lastOffset: number | undefined;

      for await (const event of historyStream) {
        if (this.#controller.signal.aborted) {
          return;
        }

        lastOffset = event.offset;
        this.#reduce(event);
      }

      if (this.#controller.signal.aborted) {
        return;
      }

      const liveStream = await this.#eventsClient.stream(
        {
          path: this.#streamPath,
          offset: lastOffset,
          live: true,
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
        this.#reduce(event);

        await this.#processor.afterAppend?.({
          append,
          event,
          state: this.#state,
        });
      }
    } catch (error) {
      if (this.#controller.signal.aborted && isAbortError(error)) {
        return;
      }

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
      return;
    }

    this.#state = this.#processor.reduce({
      event,
      state: structuredClone(this.#state),
    });
  }
}

export class PullSubscriptionPatternProcessorRuntime<State> {
  #controller = new AbortController();
  #eventsClient: PullSubscriptionEventsClient;
  #fatalError: unknown;
  #processor: Processor<State>;
  #runtimeByStreamPath = new Map<StreamPath, PullSubscriptionProcessorRuntime<State>>();
  #runPromiseByStreamPath = new Map<StreamPath, Promise<void>>();
  #streamPattern: string;

  constructor({
    eventsClient,
    processor,
    streamPattern,
  }: {
    eventsClient: PullSubscriptionEventsClient;
    processor: Processor<State>;
    streamPattern: string;
  }) {
    this.#eventsClient = eventsClient;
    this.#processor = processor;
    this.#streamPattern = normalizeStreamPattern(streamPattern);
  }

  async run() {
    try {
      const historyStream = await this.#eventsClient.stream(
        { path: "/" },
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
          offset: lastOffset,
          live: true,
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

    if (!matchesStreamPattern(streamPath, this.#streamPattern)) {
      return;
    }

    if (this.#runtimeByStreamPath.has(streamPath)) {
      return;
    }

    try {
      const runtime = new PullSubscriptionProcessorRuntime({
        eventsClient: this.#eventsClient,
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

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error != null && "name" in error && error.name === "AbortError")
  );
}

function getDiscoveredStreamPath(event: Event): StreamPath | null {
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

function normalizeStreamPattern(streamPattern: string) {
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

function matchesStreamPattern(streamPath: string, streamPattern: string) {
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
