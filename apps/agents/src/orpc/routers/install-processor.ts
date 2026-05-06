import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "@iterate-com/shared/streams/types";
import { ProjectId } from "@iterate-com/shared/streams/types";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import {
  AUTO_SUBSCRIBER_INSTANCE,
  AUTO_SUBSCRIBER_PUBLIC_BASE_URL_QUERY_PARAM,
} from "~/durable-objects/child-stream-auto-subscriber.ts";
import {
  buildAgentWebSocketCallbackUrl,
  CHILD_STREAM_AUTO_SUBSCRIBER_CLASS,
  CHILD_STREAM_AUTO_SUBSCRIBER_SUBSCRIPTION_SLUG,
} from "~/lib/iterate-agent-addressing.ts";
import { os } from "~/orpc/orpc.ts";

export const installProcessorRouter = {
  installProcessor: os.installProcessor.handler(async ({ input, context }) => {
    const projectSlug = ProjectId.parse(context.config.eventsProjectSlug);
    const streamPath = context.config.streamPathPrefix;
    const publicOrigin = new URL(input.publicBaseUrl).origin;

    // Encode `publicBaseUrl` into the WebSocket URL so the DO can read it
    // back off `connection.uri` when it fires `subscription/configured`
    // events to child streams. Events stores this as a FetchCallable because
    // websocket delivery is implemented as fetch-with-upgrade.
    const websocketUrlObj = new URL(
      buildAgentWebSocketCallbackUrl({
        publicOrigin,
        agentClass: CHILD_STREAM_AUTO_SUBSCRIBER_CLASS,
        agentInstance: AUTO_SUBSCRIBER_INSTANCE,
      }),
    );
    websocketUrlObj.searchParams.set(AUTO_SUBSCRIBER_PUBLIC_BASE_URL_QUERY_PARAM, publicOrigin);
    const websocketUrl = websocketUrlObj.toString();
    const callable = fetchCallableFromWebSocketUrl(websocketUrl);

    const eventsClient = createEventsOrpcClient({
      baseUrl: context.config.eventsBaseUrl,
      projectSlug,
    });

    await eventsClient.append({
      path: streamPath,
      event: {
        type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
        payload: {
          slug: CHILD_STREAM_AUTO_SUBSCRIBER_SUBSCRIPTION_SLUG,
          type: "websocket",
          callable,
        },
      },
    });

    return {
      streamPath,
      callable,
      subscriptionSlug: CHILD_STREAM_AUTO_SUBSCRIBER_SUBSCRIPTION_SLUG,
      projectSlug,
    };
  }),
};

function fetchCallableFromWebSocketUrl(websocketUrl: string) {
  const url = new URL(websocketUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  return {
    type: "fetch" as const,
    via: {
      type: "url" as const,
      url: url.toString(),
    },
  };
}
