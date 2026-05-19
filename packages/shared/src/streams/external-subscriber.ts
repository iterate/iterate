import { z } from "zod";
import {
  connectCallableWebSocket,
  dispatchCallable,
} from "@iterate-com/shared/callable/runtime.ts";
import type { CallableContext, FetchCallable } from "@iterate-com/shared/callable/types.ts";
import { match } from "schematch";
import type { BuiltinProcessor } from "./builtin-processor.ts";
import { getCompiledJsonata } from "./compiled-jsonata.ts";
import {
  StreamSocketAppendFrame,
  StreamSocketErrorFrame,
  StreamSocketEventFrame,
} from "./stream-socket-types.ts";
import {
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  type Event,
  type EventInput,
  type ExternalSubscriber,
  type ExternalSubscriberState,
  type ExternalWebsocketSubscriber,
  StreamSubscriptionConfiguredEvent,
} from "./types.ts";

export type ExternalSubscriberPublishFailure = {
  error: unknown;
  event: Event;
  subscriber: ExternalSubscriber;
};

type SubscriberConnection = {
  targetKey: string;
  socket: WebSocket;
};

const SerializedOutboundPayload = z.string();
const connectionsBySubscriberKey = new Map<string, SubscriberConnection>();
const connectPromisesBySubscriberKey = new Map<string, Promise<WebSocket>>();
const connectionGenerationBySubscriberKey = new Map<string, number>();

export const externalSubscriberProcessor = {
  slug: "external-subscriber",
  initialState: {
    subscribersBySlug: {},
  },

  reduce({ event, state }) {
    const configured = StreamSubscriptionConfiguredEvent.safeParse(event);
    if (!configured.success) {
      return state;
    }

    return {
      subscribersBySlug: {
        ...state.subscribersBySlug,
        [configured.data.payload.slug]: configured.data.payload,
      },
    };
  },

  async afterAppend({ append, callableContext, event, state }) {
    await publishExternalSubscribers({
      append: (input) => Promise.resolve(append(input)),
      callableContext: callableContext ?? {},
      event,
      state,
    });
  },
} satisfies BuiltinProcessor<ExternalSubscriberState>;

export async function publishExternalSubscribers(args: {
  append: (event: EventInput) => Promise<Event>;
  callableContext: CallableContext;
  event: Event;
  onError?(failure: ExternalSubscriberPublishFailure): void | Promise<void>;
  state: ExternalSubscriberState;
  subscriberTypes?: ReadonlySet<ExternalSubscriber["type"]>;
}) {
  await Promise.all(
    Object.values(args.state.subscribersBySlug)
      .filter(
        (subscriber) => args.subscriberTypes == null || args.subscriberTypes.has(subscriber.type),
      )
      .map((subscriber) =>
        publishExternalSubscriber({
          append: args.append,
          callableContext: args.callableContext,
          event: args.event,
          onError: args.onError,
          subscriber,
        }),
      ),
  );
}

export async function publishExternalSubscriber(args: {
  append: (event: EventInput) => Promise<Event>;
  callableContext: CallableContext;
  event: Event;
  onError?(failure: ExternalSubscriberPublishFailure): void | Promise<void>;
  subscriber: ExternalSubscriber;
}) {
  await publishToExternalSubscriber(args);
}

export function externalSubscriberMayReceiveEvent(args: {
  event: Event;
  subscriber: ExternalSubscriber;
}) {
  if (args.subscriber.eventTypes != null && !args.subscriber.eventTypes.includes(args.event.type)) {
    return false;
  }

  if (
    (args.subscriber.type === "webhook" || args.subscriber.type === "callable") &&
    args.event.type === STREAM_SUBSCRIPTION_CONFIGURED_TYPE &&
    args.subscriber.jsonataFilter == null &&
    (args.subscriber.eventTypes == null ||
      !args.subscriber.eventTypes.includes(STREAM_SUBSCRIPTION_CONFIGURED_TYPE))
  ) {
    return false;
  }

  return true;
}

export function hasExternalSubscribersOfType(
  state: ExternalSubscriberState,
  subscriberType: ExternalSubscriber["type"],
) {
  return Object.values(state.subscribersBySlug).some(
    (subscriber) => subscriber.type === subscriberType,
  );
}

async function publishToExternalSubscriber(args: {
  append: (event: EventInput) => Promise<Event>;
  callableContext: CallableContext;
  event: Event;
  onError?(failure: ExternalSubscriberPublishFailure): void | Promise<void>;
  subscriber: ExternalSubscriber;
}) {
  try {
    const shouldSend = await evaluateFilter({
      event: args.event,
      subscriber: args.subscriber,
    });
    if (!shouldSend) {
      return;
    }

    if (args.subscriber.type === "webhook") {
      const serializedPayload = await getWebhookPayload({
        event: args.event,
        subscriber: args.subscriber,
      });
      if (serializedPayload == null) {
        return;
      }

      await postWebhook({
        payload: JSON.parse(serializedPayload),
        callableContext: args.callableContext,
        subscriber: args.subscriber,
      });
      return;
    }

    if (args.subscriber.type === "callable") {
      await dispatchSubscriberCallable({
        callable: args.subscriber.callable,
        callableContext: args.callableContext,
        event: args.event,
      });
      return;
    }

    // Websocket subscriptions use a stable framed protocol (`{ type, event }`),
    // so we intentionally do not apply JSONata transforms here. Arbitrary
    // reshaping is a webhook-only feature; websocket delivery stays typed and predictable.
    await sendWebsocketMessage({
      append: args.append,
      event: args.event,
      callableContext: args.callableContext,
      subscriber: args.subscriber,
      streamPath: args.event.streamPath,
    });
  } catch (error) {
    await handleExternalSubscriberPublishError({
      error,
      event: args.event,
      onError: args.onError,
      subscriber: args.subscriber,
    });
  }
}

async function handleExternalSubscriberPublishError(args: {
  error: unknown;
  event: Event;
  onError?(failure: ExternalSubscriberPublishFailure): void | Promise<void>;
  subscriber: ExternalSubscriber;
}) {
  await args.onError?.({
    error: args.error,
    event: args.event,
    subscriber: args.subscriber,
  });
  console.error("[stream-do] external subscriber publish failed", {
    streamPath: args.event.streamPath,
    offset: args.event.offset,
    eventType: args.event.type,
    subscriberSlug: args.subscriber.slug,
    subscriberCallable: getSubscriberCallableKey(args.subscriber),
    error: args.error,
  });
}

async function evaluateFilter(args: { event: Event; subscriber: ExternalSubscriber }) {
  if (!externalSubscriberMayReceiveEvent(args)) {
    return false;
  }

  if (args.subscriber.jsonataFilter == null) {
    return true;
  }

  return !!(await getCompiledJsonata(args.subscriber.jsonataFilter).evaluate(args.event));
}

async function getWebhookPayload(args: {
  event: Event;
  subscriber: Extract<ExternalSubscriber, { type: "webhook" }>;
}) {
  const rawPayload =
    args.subscriber.jsonataTransform == null
      ? args.event
      : await getCompiledJsonata(args.subscriber.jsonataTransform).evaluate(args.event);

  const serializedPayload = SerializedOutboundPayload.safeParse(JSON.stringify(rawPayload));
  if (!serializedPayload.success) {
    console.error("[stream-do] external subscriber transform produced invalid JSON", {
      streamPath: args.event.streamPath,
      offset: args.event.offset,
      eventType: args.event.type,
      subscriberSlug: args.subscriber.slug,
      subscriberCallable: getSubscriberCallableKey(args.subscriber),
      issues: serializedPayload.error.issues,
    });
    return null;
  }

  return serializedPayload.data;
}

async function postWebhook(args: {
  callableContext: CallableContext;
  payload: unknown;
  subscriber: Extract<ExternalSubscriber, { type: "webhook" }>;
}) {
  // Subscription JSONata controls the payload shape. Callable dispatch then
  // owns only the invocation target and any target-local input transform.
  await dispatchCallable({
    callable: args.subscriber.callable,
    payload: args.payload,
    ctx: withDefaultFetch(args.callableContext),
  });
}

async function dispatchSubscriberCallable(args: {
  callable: ExternalSubscriber["callable"];
  callableContext: CallableContext;
  event: Event;
}) {
  const payload = { event: args.event };

  await dispatchCallable({
    callable: args.callable,
    payload,
    ctx: args.callableContext,
  });
}

async function sendWebsocketMessage(args: {
  append: (event: EventInput) => Promise<Event>;
  callableContext: CallableContext;
  event: Event;
  subscriber: ExternalWebsocketSubscriber;
  streamPath: string;
}) {
  const subscriberKey = getSubscriberKey(args.streamPath, args.subscriber.slug);

  try {
    const socket = await getSubscriberSocket({
      append: args.append,
      callableContext: args.callableContext,
      streamPath: args.streamPath,
      subscriber: args.subscriber,
    });
    sendSocketFrame(
      socket,
      StreamSocketEventFrame.parse({
        type: "event",
        event: args.event,
      }),
    );
  } catch (error) {
    resetSubscriberSocket(subscriberKey);

    try {
      const socket = await getSubscriberSocket({
        append: args.append,
        callableContext: args.callableContext,
        streamPath: args.streamPath,
        subscriber: args.subscriber,
      });
      sendSocketFrame(
        socket,
        StreamSocketEventFrame.parse({
          type: "event",
          event: args.event,
        }),
      );
    } catch (retryError) {
      console.error("[stream-do] external websocket subscriber publish failed", {
        streamPath: args.streamPath,
        subscriberSlug: args.subscriber.slug,
        subscriberCallable: getSubscriberCallableKey(args.subscriber),
        error,
        retryError,
      });
    }
  }
}

async function getSubscriberSocket(args: {
  append: (event: EventInput) => Promise<Event>;
  callableContext: CallableContext;
  streamPath: string;
  subscriber: ExternalWebsocketSubscriber;
}) {
  const subscriberKey = getSubscriberKey(args.streamPath, args.subscriber.slug);
  const targetKey = getSubscriberCallableKey(args.subscriber);
  let cached = connectionsBySubscriberKey.get(subscriberKey);
  if (cached != null && cached.targetKey !== targetKey) {
    resetSubscriberSocket(subscriberKey);
    cached = undefined;
  }
  const connectionGeneration = getSubscriberConnectionGeneration(subscriberKey);

  if (cached != null && cached.socket.readyState === WebSocket.OPEN) {
    return cached.socket;
  }

  const inFlight = connectPromisesBySubscriberKey.get(subscriberKey);
  if (inFlight != null) {
    return inFlight;
  }

  const connectPromise = connectSubscriberSocket({
    append: args.append,
    callableContext: args.callableContext,
    streamPath: args.streamPath,
    subscriber: args.subscriber,
    subscriberKey,
  });
  connectPromisesBySubscriberKey.set(subscriberKey, connectPromise);

  try {
    const socket = await connectPromise;
    if (getSubscriberConnectionGeneration(subscriberKey) !== connectionGeneration) {
      try {
        socket.close();
      } catch {}

      throw new Error("stale subscriber socket connection completed after reset");
    }

    connectionsBySubscriberKey.set(subscriberKey, {
      targetKey,
      socket,
    });
    return socket;
  } finally {
    if (connectPromisesBySubscriberKey.get(subscriberKey) === connectPromise) {
      connectPromisesBySubscriberKey.delete(subscriberKey);
    }
  }
}

async function connectSubscriberSocket(args: {
  append: (event: EventInput) => Promise<Event>;
  callableContext: CallableContext;
  streamPath: string;
  subscriber: ExternalWebsocketSubscriber;
  subscriberKey: string;
}) {
  // Websocket subscriptions still use the stream socket frame protocol. Callable
  // only replaces how we open the underlying fetch-with-upgrade target, which
  // can now be a URL, service binding, Durable Object, Dynamic Worker, or
  // loopback export.
  const socket = await connectCallableWebSocket({
    callable: getSubscriberFetchCallable(args.subscriber),
    ctx: withDefaultFetch(args.callableContext),
  });
  socket.addEventListener("message", (event) => {
    void handleSubscriberSocketMessage({
      append: args.append,
      event,
      socket,
      streamPath: args.streamPath,
      subscriber: args.subscriber,
    });
  });
  socket.addEventListener("close", () => {
    const cached = connectionsBySubscriberKey.get(args.subscriberKey);
    if (cached?.socket === socket) {
      connectionsBySubscriberKey.delete(args.subscriberKey);
    }
  });
  socket.addEventListener("error", () => {
    const cached = connectionsBySubscriberKey.get(args.subscriberKey);
    if (cached?.socket === socket) {
      connectionsBySubscriberKey.delete(args.subscriberKey);
    }
  });
  return socket;
}

/**
 * Handles inbound text from the subscriber websocket opened through Callable.
 * Contract for *our* messages: `StreamSocketAppendFrame` (append into the stream) or
 * `StreamSocketErrorFrame` (peer-reported error). Non-text frames and invalid JSON are
 * errors we surface back to the peer.
 *
 * Well-formed JSON that is neither append nor error is ignored (no reply). That includes
 * protocol frames from runtimes that share the socket with stream traffic (e.g. Cloudflare
 * Agents SDK `cf_agent_*` JSON). Replying with `StreamSocketErrorFrame` for those would be
 * wrong: they are not malformed stream frames, they are simply outside this contract.
 */
async function handleSubscriberSocketMessage(args: {
  append: (event: EventInput) => Promise<Event>;
  event: unknown;
  socket: WebSocket;
  streamPath: string;
  subscriber: ExternalWebsocketSubscriber;
}) {
  const rawData = getSocketMessageData(args.event);
  if (typeof rawData !== "string") {
    console.error("[stream-do] external websocket subscriber sent non-text frame", {
      streamPath: args.streamPath,
      subscriberSlug: args.subscriber.slug,
      subscriberCallable: getSubscriberCallableKey(args.subscriber),
    });
    sendSocketFrame(
      args.socket,
      StreamSocketErrorFrame.parse({
        type: "error",
        message: "Expected websocket text frame.",
      }),
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch (error) {
    console.error("[stream-do] external websocket subscriber sent invalid JSON", {
      streamPath: args.streamPath,
      subscriberSlug: args.subscriber.slug,
      subscriberCallable: getSubscriberCallableKey(args.subscriber),
      error,
    });
    sendSocketFrame(
      args.socket,
      StreamSocketErrorFrame.parse({
        type: "error",
        message: "Invalid websocket JSON.",
      }),
    );
    return;
  }

  await match(parsed)
    .case(StreamSocketAppendFrame, async ({ event }) => {
      try {
        await args.append(event);
      } catch (error) {
        console.error("[stream-do] external websocket subscriber append failed", {
          streamPath: args.streamPath,
          subscriberSlug: args.subscriber.slug,
          subscriberCallable: getSubscriberCallableKey(args.subscriber),
          error,
        });
        sendSocketFrame(
          args.socket,
          StreamSocketErrorFrame.parse({
            type: "error",
            message: error instanceof Error ? error.message : "Failed to append websocket event.",
          }),
        );
      }
    })
    .case(StreamSocketErrorFrame, async ({ message }) => {
      console.error("[stream-do] external websocket subscriber reported error", {
        streamPath: args.streamPath,
        subscriberSlug: args.subscriber.slug,
        subscriberCallable: getSubscriberCallableKey(args.subscriber),
        message,
      });
    })
    .defaultAsync(async () => {
      // Deliberate no-op: see docstring on `handleSubscriberSocketMessage`.
    });
}

function getSocketMessageData(event: unknown) {
  if (typeof event === "object" && event != null && "data" in event) {
    return (event as { data: unknown }).data;
  }

  return undefined;
}

function sendSocketFrame(
  socket: WebSocket,
  frame: z.infer<typeof StreamSocketEventFrame> | z.infer<typeof StreamSocketErrorFrame>,
) {
  socket.send(JSON.stringify(frame));
}

function resetSubscriberSocket(subscriberKey: string) {
  connectionGenerationBySubscriberKey.set(
    subscriberKey,
    getSubscriberConnectionGeneration(subscriberKey) + 1,
  );

  const cached = connectionsBySubscriberKey.get(subscriberKey);

  if (cached != null) {
    try {
      cached.socket.close(1011, "resetting_subscriber_socket");
    } catch {}
  }

  connectionsBySubscriberKey.delete(subscriberKey);
  connectPromisesBySubscriberKey.delete(subscriberKey);
}

function getSubscriberKey(streamPath: string, slug: string) {
  return JSON.stringify([streamPath, slug]);
}

function getSubscriberFetchCallable(subscriber: ExternalWebsocketSubscriber): FetchCallable {
  if (subscriber.callable.type !== "fetch") {
    throw new Error(`Websocket subscriber "${subscriber.slug}" must use a fetch callable`);
  }

  return subscriber.callable;
}

function getSubscriberCallableKey(subscriber: ExternalSubscriber) {
  return JSON.stringify(subscriber.callable);
}

function withDefaultFetch(ctx: CallableContext): CallableContext {
  return {
    ...ctx,
    fetch: ctx.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

export function resetSubscriberSocketsForStream(streamPath: string) {
  const subscriberKeys = new Set<string>([
    ...connectionsBySubscriberKey.keys(),
    ...connectPromisesBySubscriberKey.keys(),
  ]);

  for (const subscriberKey of subscriberKeys) {
    const parsedKey = JSON.parse(subscriberKey) as [string, string];
    if (parsedKey[0] !== streamPath) {
      continue;
    }

    resetSubscriberSocket(subscriberKey);
  }
}

function getSubscriberConnectionGeneration(subscriberKey: string) {
  return connectionGenerationBySubscriberKey.get(subscriberKey) ?? 0;
}
