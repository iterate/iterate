import { ProjectSlug, STREAM_SUBSCRIPTION_CONFIGURED_TYPE } from "@iterate-com/events-contract";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import {
  AUTO_SUBSCRIBER_INSTANCE,
  AUTO_SUBSCRIBER_PUBLIC_BASE_URL_QUERY_PARAM,
} from "~/durable-objects/child-stream-auto-subscriber.ts";
import { buildWebSocketSubscriptionCallable } from "~/lib/events-urls.ts";
import {
  buildAgentWebSocketCallbackUrl,
  CHILD_STREAM_AUTO_SUBSCRIBER_CLASS,
  CHILD_STREAM_AUTO_SUBSCRIBER_SUBSCRIPTION_SLUG,
} from "~/lib/iterate-agent-addressing.ts";
import { os } from "~/orpc/orpc.ts";

export const installProcessorRouter = {
  installProcessor: os.installProcessor.handler(async ({ input, context }) => {
    const projectSlug = ProjectSlug.parse(context.config.eventsProjectSlug);
    const streamPath = context.config.streamPathPrefix;
    const publicOrigin = new URL(input.publicBaseUrl).origin;

    // Encode `publicBaseUrl` into the target URL so the DO can read it back off
    // `connection.uri` when it fires `subscription-configured`
    // events to child streams. See child-stream-auto-subscriber.ts.
    const callbackUrlObj = new URL(
      buildAgentWebSocketCallbackUrl({
        publicOrigin,
        agentClass: CHILD_STREAM_AUTO_SUBSCRIBER_CLASS,
        agentInstance: AUTO_SUBSCRIBER_INSTANCE,
      }),
    );
    callbackUrlObj.searchParams.set(AUTO_SUBSCRIBER_PUBLIC_BASE_URL_QUERY_PARAM, publicOrigin);
    const callbackUrl = callbackUrlObj.toString();

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
          callable: buildWebSocketSubscriptionCallable(callbackUrl),
        },
      },
    });

    return {
      streamPath,
      callbackUrl,
      subscriptionSlug: CHILD_STREAM_AUTO_SUBSCRIBER_SUBSCRIPTION_SLUG,
      projectSlug,
    };
  }),
};
