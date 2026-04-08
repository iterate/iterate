import { z } from "zod";
import {
  type Event,
  type ExternalSubscriber,
  type ExternalSubscriberState,
  type ExternalWebsocketSubscriber,
  StreamSubscriptionConfiguredEvent,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor } from "@iterate-com/events-contract/sdk";
import { getCompiledJsonata } from "./compiled-jsonata.ts";
import { openOutboundWebSocket } from "./outbound-websocket.ts";

type SubscriberConnection = {
  callbackUrl: string;
  socket: WebSocket;
};

const SerializedOutboundPayload = z.string();
const connectionsBySubscriberKey = new Map<string, SubscriberConnection>();
const connectPromisesBySubscriberKey = new Map<string, Promise<WebSocket>>();
const connectionGenerationBySubscriberKey = new Map<string, number>();

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

    const serializedPayload = await getOutboundPayload({
      event: args.event,
      subscriber: args.subscriber,
    });
    if (serializedPayload == null) {
      return;
    }

    if (args.subscriber.type === "webhook") {
      await postWebhook({
        serializedPayload,
        subscriber: args.subscriber,
      });
      return;
    }

    await sendWebsocketMessage({
      serializedPayload,
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
  if (
    args.subscriber.type === "webhook" &&
    args.event.type === "https://events.iterate.com/events/stream/subscription/configured" &&
    args.subscriber.jsonataFilter == null
  ) {
    return false;
  }

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

  const serializedPayload = SerializedOutboundPayload.safeParse(JSON.stringify(rawPayload));
  if (!serializedPayload.success) {
    console.error("[stream-do] external subscriber transform produced invalid JSON", {
      streamPath: args.event.streamPath,
      offset: args.event.offset,
      eventType: args.event.type,
      subscriberSlug: args.subscriber.slug,
      callbackUrl: args.subscriber.callbackUrl,
      issues: serializedPayload.error.issues,
    });
    return null;
  }

  return serializedPayload.data;
}

async function postWebhook(args: {
  serializedPayload: z.infer<typeof SerializedOutboundPayload>;
  subscriber: Extract<ExternalSubscriber, { type: "webhook" }>;
}) {
  const response = await fetch(args.subscriber.callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: args.serializedPayload,
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
  serializedPayload: z.infer<typeof SerializedOutboundPayload>;
  subscriber: ExternalWebsocketSubscriber;
  streamPath: string;
}) {
  const subscriberKey = getSubscriberKey(args.streamPath, args.subscriber.slug);

  try {
    const socket = await getSubscriberSocket({
      streamPath: args.streamPath,
      subscriber: args.subscriber,
    });
    socket.send(args.serializedPayload);
  } catch (error) {
    resetSubscriberSocket(subscriberKey);

    try {
      const socket = await getSubscriberSocket({
        streamPath: args.streamPath,
        subscriber: args.subscriber,
      });
      socket.send(args.serializedPayload);
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
  let cached = connectionsBySubscriberKey.get(subscriberKey);
  if (cached != null && cached.callbackUrl !== args.subscriber.callbackUrl) {
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
  const socket = await openOutboundWebSocket(args.subscriber.callbackUrl);
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
