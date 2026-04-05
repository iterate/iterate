import { posix as path } from "node:path";
import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "./orpc-contract.ts";
import {
  ChildStreamCreatedEvent,
  StreamInitializedEvent,
  type Event,
  type EventInput,
  type EventType,
  type JSONObject,
  type StreamPath,
} from "./types.ts";

export { eventsContract } from "./orpc-contract.ts";
export type { Event, EventInput, EventType, JSONObject, StreamPath } from "./types.ts";

export type EventsORPCClient = ContractRouterClient<typeof eventsContract>;

export function createEventsClient(baseUrl: string): EventsORPCClient {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
    }),
  ) as EventsORPCClient;
}

type AppendEvent = Omit<EventInput, "path">;

export type Processor<State = Record<string, unknown>> = {
  slug: string;
  initialState: State;
  reduce?(args: { event: Event; state: State }): State;
  afterAppend?(args: {
    append: (event: AppendEvent) => Event | Promise<Event>;
    event: Event;
    state: State;
  }): Promise<void>;
};

type PullSubscriptionEventsClient = {
  append: (input: { path: StreamPath; event: EventInput }) => Promise<{
    event: Event;
  }>;
  stream: (
    input: { path: StreamPath; offset?: number; live?: boolean },
    options: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<Event>>;
};

export class PullSubscriptionProcessorRuntime<State> {
  #controller?: AbortController;
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
    const historyStream = await this.#eventsClient.stream({ path: this.#streamPath }, {});
    let lastOffset: number | undefined;

    for await (const event of historyStream) {
      lastOffset = event.offset;
      this.#reduce(event);
    }

    this.#controller = new AbortController();

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

    const append = async (event: AppendEvent) => {
      const result = await this.#eventsClient.append({
        path: this.#streamPath,
        event,
      });
      return result.event;
    };

    try {
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
    this.#controller?.abort();
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
  #controller?: AbortController;
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
    this.#controller = new AbortController();

    const historyStream = await this.#eventsClient.stream({ path: "/" }, {});
    let lastOffset: number | undefined;

    for await (const event of historyStream) {
      if (this.#controller.signal.aborted) {
        break;
      }

      lastOffset = event.offset;
      this.#startRuntimeIfMatched(event);
    }

    if (this.#fatalError != null) {
      this.stop();
      await this.#waitForStreamRuntimes();
      throw this.#fatalError;
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

    try {
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
    this.#controller?.abort();

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

    if (!path.matchesGlob(streamPath, this.#streamPattern)) {
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
