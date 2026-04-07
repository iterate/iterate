import { z } from "zod";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import type { Context } from "hono";
import {
  matchesStreamPattern,
  PushSubscriptionProcessorRuntime,
  type Event,
  type EventsORPCClient,
  type Processor,
  type StreamPath,
} from "ai-engineer-workshop/runtime";
import {
  Event as EventSchema,
  StreamPath as StreamPathSchema,
  StreamSubscriptionConfiguredEventInput,
} from "ai-engineer-workshop/contract";

type WorkshopEventsClient = Pick<EventsORPCClient, "append" | "stream">;
type SubscriberType = "webhook" | "websocket";

type ProcessorDeploymentConfig<State> = {
  baseUrl: string;
  openAiModel?: string;
  processor: Processor<State>;
  processorDescription: string;
  processorKey: string;
  processorKind: string;
  streamPattern: string;
};

const CallbackContext = z.object({
  baseUrl: z.url(),
  streamPath: StreamPathSchema,
});

/**
 * Thin Hono adapter for push-style processors.
 *
 * Streams opt in by appending `stream/subscription/configured` events whose
 * callback URL points at this worker. Once a subscribed event arrives, the
 * shared push runtime catches the processor up from stream history, reduces the
 * incoming event, then runs `afterAppend()` with the normal `append({ event })`
 * helper from the workshop SDK.
 */
export function createAfterEventHandlerApp<Bindings extends object, State>({
  getConfig,
  getEventsClient,
}: {
  getConfig: (context: Context<{ Bindings: Bindings }>) => ProcessorDeploymentConfig<State>;
  getEventsClient: (baseUrl: string) => WorkshopEventsClient;
}) {
  const app = new Hono<{ Bindings: Bindings }>();
  const runtimes = new Map<string, PushSubscriptionProcessorRuntime<State>>();

  app.get("/", (c) => {
    const config = getConfig(c);
    return c.text(
      renderUsageText({
        callbackBaseUrl: new URL(c.req.url),
        config,
      }),
    );
  });

  app.get("/after-event-handler", async (c, next) => {
    const config = getConfig(c);
    const callbackContext = parseCallbackContext(c, config.baseUrl);
    if (!callbackContext.success) {
      return c.json({ ok: false, issues: formatIssues(callbackContext.error.issues) }, 400);
    }

    const streamPath = callbackContext.data.streamPath;
    if (!matchesStreamPattern(streamPath, config.streamPattern)) {
      return c.json(
        {
          ok: false,
          issues: [
            {
              message: `stream path does not match processor pattern ${config.streamPattern}`,
              path: ["streamPath"],
            },
          ],
        },
        400,
      );
    }

    const runtime = getOrCreateRuntime({
      config,
      eventsClient: getEventsClient(callbackContext.data.baseUrl),
      runtimes,
      streamPath,
    });

    const handler = upgradeWebSocket(() => ({
      onMessage: async (messageEvent, ws) => {
        try {
          const event = await parseIncomingEvent(messageEvent.data);
          if (event == null || event.streamPath !== streamPath) {
            ws.close(1008, "invalid_event");
            return;
          }

          await runtime.consume(event);
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

  app.post("/after-event-handler", async (c) => {
    const config = getConfig(c);
    const callbackContext = parseCallbackContext(c, config.baseUrl);
    if (!callbackContext.success) {
      return c.json({ ok: false, issues: formatIssues(callbackContext.error.issues) }, 400);
    }

    const eventResult = await parseBodyEvent(c);
    if (!eventResult.success) {
      return c.json({ ok: false, issues: formatIssues(eventResult.error.issues) }, 400);
    }

    const streamPath = callbackContext.data.streamPath;
    if (eventResult.data.streamPath !== streamPath) {
      return c.json(
        {
          ok: false,
          issues: [
            {
              message: "event streamPath does not match callback stream path",
              path: ["streamPath"],
            },
          ],
        },
        400,
      );
    }

    if (!matchesStreamPattern(streamPath, config.streamPattern)) {
      return c.json({ ok: true, skipped: true });
    }

    const runtime = getOrCreateRuntime({
      config,
      eventsClient: getEventsClient(callbackContext.data.baseUrl),
      runtimes,
      streamPath,
    });
    await runtime.consume(eventResult.data);

    return c.json({ ok: true });
  });

  return app;
}

function getOrCreateRuntime<State>(args: {
  config: ProcessorDeploymentConfig<State>;
  eventsClient: WorkshopEventsClient;
  runtimes: Map<string, PushSubscriptionProcessorRuntime<State>>;
  streamPath: StreamPath;
}) {
  const runtimeKey = JSON.stringify([
    args.config.baseUrl,
    args.config.processorKey,
    args.config.streamPattern,
    args.streamPath,
  ]);
  const existing = args.runtimes.get(runtimeKey);
  if (existing != null) {
    return existing;
  }

  const runtime = new PushSubscriptionProcessorRuntime({
    eventsClient: args.eventsClient,
    processor: args.config.processor,
    streamPath: args.streamPath,
  });
  args.runtimes.set(runtimeKey, runtime);
  return runtime;
}

function renderUsageText<State>(args: {
  callbackBaseUrl: URL;
  config: ProcessorDeploymentConfig<State>;
}) {
  const exampleStreamPath = StreamPathSchema.parse("/example/demo");
  const websocketEvent = createSubscriptionConfiguredEvent({
    callbackUrl: createProcessorCallbackUrl({
      callbackBaseUrl: args.callbackBaseUrl,
      config: args.config,
      streamPath: exampleStreamPath,
      subscriberType: "websocket",
    }),
    slug: `processor:${args.config.processorKey}:websocket`,
    subscriberType: "websocket",
  });
  const webhookEvent = createSubscriptionConfiguredEvent({
    callbackUrl: createProcessorCallbackUrl({
      callbackBaseUrl: args.callbackBaseUrl,
      config: args.config,
      streamPath: exampleStreamPath,
      subscriberType: "webhook",
    }),
    slug: `processor:${args.config.processorKey}:webhook`,
    subscriberType: "webhook",
  });

  return [
    `This deployment runs the "${args.config.processorKey}" processor.`,
    "",
    args.config.processorDescription,
    "",
    `It only accepts subscribed streams whose path matches: ${args.config.streamPattern}`,
    "",
    "How to use it:",
    `1. Pick a stream path that matches ${args.config.streamPattern}.`,
    "2. Append one stream/subscription/configured event to that stream.",
    "3. Future events on that stream will be pushed here over websocket or webhook.",
    "",
    `Example stream path: ${exampleStreamPath}`,
    `Events base URL used by this deployment: ${args.config.baseUrl}`,
    "",
    "Websocket subscription event:",
    JSON.stringify(websocketEvent, null, 2),
    "",
    "Webhook subscription event:",
    JSON.stringify(webhookEvent, null, 2),
    "",
    "Example curl to append the websocket subscription event:",
    [
      "curl -sS -X POST",
      `  '${args.config.baseUrl}/api/streams/${encodeStreamPath(exampleStreamPath)}'`,
      "  -H 'content-type: application/json'",
      `  --data '${JSON.stringify(websocketEvent)}'`,
    ].join(" \\\n"),
    "",
    "After that, append your normal events to the same stream path.",
  ].join("\n");
}

function createProcessorCallbackUrl<State>(args: {
  callbackBaseUrl: URL;
  config: ProcessorDeploymentConfig<State>;
  streamPath: StreamPath;
  subscriberType: SubscriberType;
}) {
  const callbackUrl = new URL("/after-event-handler", args.callbackBaseUrl);
  callbackUrl.searchParams.set("baseUrl", args.config.baseUrl);
  callbackUrl.searchParams.set("streamPath", args.streamPath);
  callbackUrl.searchParams.set("streamPattern", args.config.streamPattern);
  callbackUrl.searchParams.set("processorKind", args.config.processorKind);

  if (args.config.openAiModel != null) {
    callbackUrl.searchParams.set("openaiModel", args.config.openAiModel);
  }

  if (args.subscriberType === "websocket") {
    callbackUrl.protocol = toWebsocketProtocol(callbackUrl);
  }

  return callbackUrl.toString();
}

function createSubscriptionConfiguredEvent(args: {
  callbackUrl: string;
  slug: string;
  subscriberType: SubscriberType;
}) {
  return StreamSubscriptionConfiguredEventInput.parse({
    type: "https://events.iterate.com/events/stream/subscription/configured",
    payload: {
      callbackUrl: args.callbackUrl,
      slug: args.slug,
      type: args.subscriberType,
    },
  });
}

function parseCallbackContext(c: Context, defaultBaseUrl: string) {
  return CallbackContext.safeParse({
    baseUrl: c.req.query("baseUrl") ?? defaultBaseUrl,
    streamPath: c.req.query("streamPath"),
  });
}

async function parseBodyEvent(c: Context) {
  try {
    return EventSchema.safeParse(await c.req.json());
  } catch {
    return EventSchema.safeParse(undefined);
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

function formatIssues(
  issues: Array<{
    message: string;
    path: PropertyKey[];
  }>,
) {
  return issues.map((issue) => ({
    message: issue.message,
    path: issue.path,
  }));
}

function encodeStreamPath(streamPath: StreamPath) {
  return streamPath.replaceAll("/", "%2F");
}

function toWebsocketProtocol(url: URL) {
  return url.protocol === "https:" ? "wss:" : "ws:";
}
