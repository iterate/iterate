import { ProjectSlug, StreamPath } from "@iterate-com/events-contract";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import {
  buildAgentWebSocketCallbackUrl,
  buildStreamAppendUrl,
  buildStreamViewerUrl,
} from "~/lib/events-urls.ts";
import { os } from "~/orpc/orpc.ts";

const DEFAULT_EVENTS_BASE_URL = "https://events.iterate.com";
const AGENT_CLASS = "iterate-agent";

export const subscribeRouter = {
  subscribeStream: os.subscribeStream.handler(async ({ input }) => {
    const streamPath = StreamPath.parse(input.streamPath);
    const projectSlug = ProjectSlug.parse(input.projectSlug);
    const slug = randomDevSlug();
    const agentInstance = input.agentInstance ?? `dev-${slug}`;
    const subscriptionSlug = input.subscriptionSlug ?? `dev-${slug}`;

    const callbackUrl = buildAgentWebSocketCallbackUrl({
      publicOrigin: new URL(input.publicBaseUrl).origin,
      agentClass: AGENT_CLASS,
      agentInstance,
    });

    const eventsClient = createEventsOrpcClient({
      baseUrl: DEFAULT_EVENTS_BASE_URL,
      projectSlug,
    });
    await eventsClient.append({
      path: streamPath,
      event: {
        type: "https://events.iterate.com/events/stream/subscription/configured",
        payload: {
          slug: subscriptionSlug,
          type: "websocket",
          callbackUrl,
        },
      },
    });

    return {
      streamPath,
      callbackUrl,
      streamViewerUrl: buildStreamViewerUrl({
        eventsBaseUrl: DEFAULT_EVENTS_BASE_URL,
        projectSlug,
        streamPath,
      }),
      appendUrl: buildStreamAppendUrl({
        eventsBaseUrl: DEFAULT_EVENTS_BASE_URL,
        projectSlug,
        streamPath,
      }),
      subscriptionSlug,
      agentInstance,
    };
  }),
};

function randomDevSlug() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
