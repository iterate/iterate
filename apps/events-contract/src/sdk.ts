import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "./orpc-contract.ts";
import type { Event, EventInput, EventType, JSONObject, Offset, StreamPath } from "./types.ts";

export { eventsContract } from "./orpc-contract.ts";
export type { Event, EventInput, EventType, JSONObject, Offset, StreamPath } from "./types.ts";

export type EventsClient = {
  append(input: { path: StreamPath; event: EventInput }): Promise<{
    created: boolean;
    event: Event;
    events: [Event];
  }>;
  stream(
    input: { path: StreamPath; offset?: Offset; live?: boolean },
    options: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Event>>;
};

export function createEventsClient(baseUrl: string): EventsClient {
  const client = createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
    }),
  ) as ContractRouterClient<typeof eventsContract>;

  return {
    async append(input: { path: StreamPath; event: EventInput }) {
      const result = await client.append({
        params: { path: input.path },
        body: input.event,
      });

      return {
        created: true,
        event: result.event,
        events: [result.event],
      };
    },
    async stream(
      input: { path: StreamPath; offset?: Offset; live?: boolean },
      options: { signal?: AbortSignal },
    ) {
      return client.stream(input, options);
    },
  };
}

type AppendEvent = Omit<EventInput, "path">;

export function defineProcessor<State>(processor: {
  initialState: State;
  reduce: (state: State, event: Event) => State | void;
  onEvent?: (args: {
    append: (event: AppendEvent) => Promise<void>;
    event: Event;
    state: State;
    prevState: State;
  }) => Promise<void>;
}) {
  return processor;
}

export type StreamProcessor<State> = ReturnType<typeof defineProcessor<State>>;

type PullSubscriptionEventsClient = {
  append: (input: { path: StreamPath; event: EventInput }) => Promise<{
    created: boolean;
    event: Event;
    events: Event[];
  }>;
  stream: (
    input: { path: StreamPath; offset?: number; live?: boolean },
    options: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<Event>>;
};

export class PullSubscriptionProcessorRuntime<State> {
  #controller?: AbortController;
  #eventsClient: PullSubscriptionEventsClient;
  #processor: StreamProcessor<State>;
  #state: State;
  #streamPath: StreamPath;

  constructor({
    eventsClient,
    processor,
    streamPath,
  }: {
    eventsClient: PullSubscriptionEventsClient;
    processor: StreamProcessor<State>;
    streamPath: StreamPath;
  }) {
    this.#eventsClient = eventsClient;
    this.#processor = processor;
    this.#state = processor.initialState;
    this.#streamPath = streamPath;
  }

  async run() {
    const historyStream = await this.#eventsClient.stream({ path: this.#streamPath }, {});
    let lastOffset: number | undefined;

    for await (const event of historyStream) {
      lastOffset = event.offset;
      this.#state = this.#processor.reduce(structuredClone(this.#state), event) ?? this.#state;
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
      await this.#eventsClient.append({
        path: this.#streamPath,
        event,
      });
    };

    try {
      for await (const event of liveStream) {
        if (event.offset === lastOffset) {
          continue;
        }

        const prevState = this.#state;
        this.#state = this.#processor.reduce(structuredClone(this.#state), event) ?? this.#state;

        await this.#processor.onEvent?.({
          append,
          event,
          state: this.#state,
          prevState,
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
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error != null && "name" in error && error.name === "AbortError")
  );
}
