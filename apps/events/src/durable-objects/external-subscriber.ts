import jsonata, { type Expression } from "jsonata";
import { z } from "zod";
import {
  type Event,
  type ExternalSubscriber,
  type ExternalSubscriberState,
  type ExternalWebsocketSubscriber,
  StreamSubscriptionConfiguredEvent,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor } from "./define-processor.ts";

type SubscriberConnection = {
  callbackUrl: string;
  socket: WebSocket;
};

const outboundPayloadSchema = z.json();
const connectionsBySubscriberKey = new Map<string, SubscriberConnection>();
const connectPromisesBySubscriberKey = new Map<string, Promise<WebSocket>>();
const jsonataCache = new Map<string, Expression>();

export const externalSubscriberProcessor = defineBuiltinProcessor<ExternalSubscriberState>(() => ({
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

  async afterAppend({ event, state }) {
    await Promise.all(
      Object.values(state.subscribersBySlug).map((subscriber) =>
        publishToExternalSubscriber({
          event,
          subscriber,
        }),
      ),
    );
  },
}));

async function publishToExternalSubscriber(args: { event: Event; subscriber: ExternalSubscriber }) {
  try {
    const shouldSend = await evaluateFilter({
      event: args.event,
      subscriber: args.subscriber,
    });
    if (!shouldSend) {
      return;
    }

    const outboundPayload = await getOutboundPayload({
      event: args.event,
      subscriber: args.subscriber,
    });
    if (outboundPayload == null) {
      return;
    }

    if (args.subscriber.type === "webhook") {
      await postWebhook({
        payload: outboundPayload,
        subscriber: args.subscriber,
      });
      return;
    }

    await sendWebsocketMessage({
      payload: outboundPayload,
      subscriber: args.subscriber,
      streamPath: args.event.streamPath,
    });
  } catch (error) {
    console.error("[stream-do] external subscriber publish failed", {
      streamPath: args.event.streamPath,
      offset: args.event.offset,
      eventType: args.event.type,
      subscriberSlug: args.subscriber.slug,
      callbackUrl: args.subscriber.callbackUrl,
      error,
    });
  }
}

async function evaluateFilter(args: { event: Event; subscriber: ExternalSubscriber }) {
  if (args.subscriber.jsonataFilter == null) {
    return true;
  }

  return !!(await getCompiledJsonata(args.subscriber.jsonataFilter).evaluate(args.event));
}

async function getOutboundPayload(args: { event: Event; subscriber: ExternalSubscriber }) {
  const rawPayload =
    args.subscriber.jsonataTransform == null
      ? args.event
      : await getCompiledJsonata(args.subscriber.jsonataTransform).evaluate(args.event);

  const parsedPayload = outboundPayloadSchema.safeParse(rawPayload);
  if (!parsedPayload.success) {
    console.error("[stream-do] external subscriber transform produced invalid JSON", {
      streamPath: args.event.streamPath,
      offset: args.event.offset,
      eventType: args.event.type,
      subscriberSlug: args.subscriber.slug,
      callbackUrl: args.subscriber.callbackUrl,
      issues: parsedPayload.error.issues,
    });
    return null;
  }

  return parsedPayload.data;
}

async function postWebhook(args: {
  payload: z.infer<typeof outboundPayloadSchema>;
  subscriber: Extract<ExternalSubscriber, { type: "webhook" }>;
}) {
  const response = await fetch(args.subscriber.callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(args.payload),
  });

  if (!response.ok) {
    console.error("[stream-do] external webhook subscriber returned non-2xx", {
      subscriberSlug: args.subscriber.slug,
      callbackUrl: args.subscriber.callbackUrl,
      status: response.status,
    });
  }
}

async function sendWebsocketMessage(args: {
  payload: z.infer<typeof outboundPayloadSchema>;
  subscriber: ExternalWebsocketSubscriber;
  streamPath: string;
}) {
  const encodedPayload = JSON.stringify(args.payload);
  const subscriberKey = getSubscriberKey(args.streamPath, args.subscriber.slug);

  try {
    const socket = await getSubscriberSocket({
      streamPath: args.streamPath,
      subscriber: args.subscriber,
    });
    socket.send(encodedPayload);
  } catch (error) {
    resetSubscriberSocket(subscriberKey);

    try {
      const socket = await getSubscriberSocket({
        streamPath: args.streamPath,
        subscriber: args.subscriber,
      });
      socket.send(encodedPayload);
    } catch (retryError) {
      console.error("[stream-do] external websocket subscriber publish failed", {
        streamPath: args.streamPath,
        subscriberSlug: args.subscriber.slug,
        callbackUrl: args.subscriber.callbackUrl,
        error,
        retryError,
      });
    }
  }
}

async function getSubscriberSocket(args: {
  streamPath: string;
  subscriber: ExternalWebsocketSubscriber;
}) {
  const subscriberKey = getSubscriberKey(args.streamPath, args.subscriber.slug);
  const cached = connectionsBySubscriberKey.get(subscriberKey);
  if (cached != null && cached.callbackUrl !== args.subscriber.callbackUrl) {
    resetSubscriberSocket(subscriberKey);
  }

  if (cached != null && cached.socket.readyState === WebSocket.OPEN) {
    return cached.socket;
  }

  const inFlight = connectPromisesBySubscriberKey.get(subscriberKey);
  if (inFlight != null) {
    return inFlight;
  }

  const connectPromise = connectSubscriberSocket({
    streamPath: args.streamPath,
    subscriber: args.subscriber,
    subscriberKey,
  });
  connectPromisesBySubscriberKey.set(subscriberKey, connectPromise);

  try {
    const socket = await connectPromise;
    connectionsBySubscriberKey.set(subscriberKey, {
      callbackUrl: args.subscriber.callbackUrl,
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
  streamPath: string;
  subscriber: ExternalWebsocketSubscriber;
  subscriberKey: string;
}) {
  const response = (await fetch(
    getWebsocketUpgradeFetchUrl(args.subscriber.callbackUrl).toString(),
    {
      headers: {
        Upgrade: "websocket",
      },
    },
  )) as Response & { webSocket?: WebSocket | null };

  const socket = response.webSocket;
  if (socket == null) {
    throw new Error(`Subscriber did not accept websocket upgrade. Status: ${response.status}`);
  }

  socket.accept();
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

function resetSubscriberSocket(subscriberKey: string) {
  const cached = connectionsBySubscriberKey.get(subscriberKey);

  if (cached != null) {
    try {
      cached.socket.close(1011, "resetting_subscriber_socket");
    } catch {}
  }

  connectionsBySubscriberKey.delete(subscriberKey);
  connectPromisesBySubscriberKey.delete(subscriberKey);
}

function getWebsocketUpgradeFetchUrl(callbackUrl: string) {
  const url = new URL(callbackUrl);

  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  return url;
}

function getCompiledJsonata(expression: string) {
  const cached = jsonataCache.get(expression);
  if (cached) {
    return cached;
  }

  if (jsonataCache.size >= 100) {
    const oldestKey = jsonataCache.keys().next().value;
    if (oldestKey) {
      jsonataCache.delete(oldestKey);
    }
  }

  const compiled = jsonata(expression);
  jsonataCache.set(expression, compiled);
  return compiled;
}

function getSubscriberKey(streamPath: string, slug: string) {
  return JSON.stringify([streamPath, slug]);
}
