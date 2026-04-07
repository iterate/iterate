import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import type { Context } from "hono";
import {
  type Event,
  type EventInput,
  type EventsORPCClient,
  type StreamProcessor,
} from "ai-engineer-workshop/runtime";
import { Event as EventSchema, StreamPath } from "ai-engineer-workshop/contract";

type AppendEvent = Omit<EventInput, "path">;
type WorkshopEventsClient = Pick<EventsORPCClient, "append" | "stream">;

export function createAfterEventHandlerApp<Bindings extends object, State>({
  getEventsClient,
  getEventsClientKey,
  getProcessor,
  getProcessorKey,
}: {
  getEventsClient: (context: Context<{ Bindings: Bindings }>) => WorkshopEventsClient;
  getEventsClientKey: (context: Context<{ Bindings: Bindings }>) => string;
  getProcessor: (context: Context<{ Bindings: Bindings }>) => StreamProcessor<State>;
  getProcessorKey: (context: Context<{ Bindings: Bindings }>) => string;
}) {
  const app = new Hono<{ Bindings: Bindings }>();
  const instances = new Map<string, ProcessorInstance<State>>();

  app.get("/__subscribe/*", async (c) => {
    const parsedStreamPath = parseSubscribedStreamPath(c);

    if (!parsedStreamPath.success) {
      return c.json(
        {
          ok: false,
          issues: parsedStreamPath.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
        400,
      );
    }

    const streamPath = parsedStreamPath.data;
    const callbackUrl = createSubscriptionCallbackUrl(c, streamPath);
    const result = await getEventsClient(c).append({
      params: { path: streamPath },
      body: {
        type: "https://events.iterate.com/events/stream/subscription/configured",
        payload: {
          callbackUrl,
          type: "websocket",
        },
      },
    });

    return c.json({
      ok: true,
      processorKey: getProcessorKey(c),
      streamPath,
      callbackUrl,
      event: result.event,
    });
  });

  app.get("/after-event-handler", async (c, next) => {
    const parsedStreamPath = StreamPath.safeParse(c.req.query("streamPath"));

    if (!parsedStreamPath.success) {
      return c.json(
        {
          ok: false,
          issues: parsedStreamPath.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
        400,
      );
    }

    const streamPath = parsedStreamPath.data;
    const eventsClientKey = getEventsClientKey(c);
    const processor = getProcessor(c);
    const processorKey = getProcessorKey(c);
    const instanceKey = `${eventsClientKey}:${processorKey}:${streamPath}`;
    let instance = instances.get(instanceKey);

    if (instance == null) {
      instance = new ProcessorInstance({
        eventsClient: getEventsClient(c),
        processor,
        streamPath,
      });
      instances.set(instanceKey, instance);
    }

    const handler = upgradeWebSocket(() => ({
      onMessage: async (messageEvent, ws) => {
        try {
          const event = await parseIncomingEvent(messageEvent.data);
          if (event == null) {
            ws.close(1008, "invalid_event");
            return;
          }
          if (event.streamPath !== streamPath) {
            ws.close(1008, "stream_path_mismatch");
            return;
          }
          await instance.consume(event);
        } catch (error) {
          console.error("[processor-runtime] failed to consume websocket event", {
            streamPath,
            error,
          });
          ws.close(1011, "processor_error");
        }
      },
      onError: (_event, ws) => {
        ws.close(1011, "processor_error");
      },
    }));

    return handler(c, next);
  });

  return app;
}

class ProcessorInstance<State> {
  readonly #eventsClient: WorkshopEventsClient;
  readonly #processor: StreamProcessor<State>;
  readonly #streamPath: string;
  #state: State;
  #lastOffset = 0;

  constructor({
    eventsClient,
    processor,
    streamPath,
  }: {
    eventsClient: WorkshopEventsClient;
    processor: StreamProcessor<State>;
    streamPath: string;
  }) {
    this.#eventsClient = eventsClient;
    this.#processor = processor;
    this.#streamPath = streamPath;
    this.#state = structuredClone(processor.initialState);
  }

  async consume(event: Event) {
    await this.#processEvent(event);
  }

  async #processEvent(event: Event) {
    if (event.offset > this.#lastOffset + 1) {
      await this.#catchUpTo(event.offset);
    }

    if (event.offset <= this.#lastOffset) {
      return;
    }

    const prevState = this.#state;
    this.#state = this.#processor.reduce(structuredClone(this.#state), event) ?? this.#state;
    this.#lastOffset = event.offset;

    await this.#processor.onEvent?.({
      append: async (nextEvent: AppendEvent) => {
        await this.#eventsClient.append({
          params: { path: this.#streamPath },
          body: nextEvent,
        });
      },
      event,
      state: this.#state,
      prevState,
    });
  }

  async #catchUpTo(targetOffset: number) {
    const history = await this.#eventsClient.stream(
      {
        path: this.#streamPath,
        offset: this.#lastOffset || undefined,
      },
      {},
    );

    for await (const historicalEvent of history) {
      if (historicalEvent.offset >= targetOffset) {
        break;
      }

      this.#state =
        this.#processor.reduce(structuredClone(this.#state), historicalEvent) ?? this.#state;
      this.#lastOffset = historicalEvent.offset;
    }
  }
}

async function parseIncomingEvent(data: string | ArrayBufferLike | Blob): Promise<Event | null> {
  if (typeof data === "string") {
    return parseEventJson(data);
  }

  try {
    if (data instanceof Blob) {
      return parseEventJson(await data.text());
    }

    return parseEventJson(new TextDecoder().decode(new Uint8Array(data)));
  } catch {
    return null;
  }
}

function parseEventJson(data: string): Event | null {
  try {
    const parsedJson: unknown = JSON.parse(data);
    const parsedEvent = EventSchema.safeParse(parsedJson);
    return parsedEvent.success ? parsedEvent.data : null;
  } catch {
    return null;
  }
}

function parseSubscribedStreamPath(c: Context) {
  const pathname = new URL(c.req.url).pathname;
  const rawPath = pathname.slice("/__subscribe".length) || "/";
  return StreamPath.safeParse(rawPath);
}

function createSubscriptionCallbackUrl(c: Context, streamPath: string) {
  const selectedProcessorKind = c.req.query("processorKind");
  const selectedOpenAiModel = c.req.query("openaiModel");
  const callbackUrl = new URL("/after-event-handler", c.req.url);

  callbackUrl.protocol = callbackUrl.protocol === "https:" ? "wss:" : "ws:";
  callbackUrl.searchParams.set("streamPath", streamPath);
  if (selectedProcessorKind != null) {
    callbackUrl.searchParams.set("processorKind", selectedProcessorKind);
  }
  if (selectedOpenAiModel != null) {
    callbackUrl.searchParams.set("openaiModel", selectedOpenAiModel);
  }

  return callbackUrl.toString();
}
