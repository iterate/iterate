import {
  ProjectSlug,
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  StreamPath,
} from "@iterate-com/events-contract";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import { buildStreamViewerUrl } from "~/lib/events-urls.ts";
import {
  AGENT_CHAT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
  AGENT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
  buildAgentChatStreamProcessorRunnerWebSocketCallbackUrl,
  buildAgentStreamProcessorRunnerWebSocketCallbackUrl,
  buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl,
  CODEMODE_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
  streamPathToAgentInstance,
} from "~/lib/iterate-agent-addressing.ts";
import { os } from "~/orpc/orpc.ts";

/**
 * Thin wrapper around `events.append` that drops a single
 * `events.iterate.com/agent/input-added` event onto a stream under the
 * auto-subscriber's prefix.
 *
 * `createAgent` explicitly subscribes the Webchat, Agent, and Codemode
 * StreamProcessorRunner durable objects before appending the first prompt. The
 * auto-subscriber still discovers the stream and applies base-path defaults,
 * but the first user message must not depend on that asynchronous parent-stream
 * notification winning the race.
 */
export const createAgentRouter = {
  createAgent: os.createAgent.handler(async ({ input, context }) => {
    const projectSlug = ProjectSlug.parse(context.config.eventsProjectSlug);
    const streamPath = StreamPath.parse(input.streamPath);
    const publicOrigin = getPublicOrigin(context.rawRequest);
    const runnerInstance = streamPathToAgentInstance(streamPath);
    const cloudflareAiCallbackUrl = new URL(publicOrigin);
    if (cloudflareAiCallbackUrl.hostname === "localhost") {
      cloudflareAiCallbackUrl.hostname = "127.0.0.1";
    }
    cloudflareAiCallbackUrl.protocol =
      cloudflareAiCallbackUrl.protocol === "http:" ||
      cloudflareAiCallbackUrl.hostname === "localhost" ||
      cloudflareAiCallbackUrl.hostname === "127.0.0.1" ||
      cloudflareAiCallbackUrl.hostname === "::1" ||
      cloudflareAiCallbackUrl.hostname === "[::1]"
        ? "ws:"
        : "wss:";
    cloudflareAiCallbackUrl.pathname = `/api/cloudflare-ai-stream-processor-runner/${encodeURIComponent(
      runnerInstance,
    )}/websocket`;
    cloudflareAiCallbackUrl.search = "";
    cloudflareAiCallbackUrl.searchParams.set("streamPath", streamPath);
    cloudflareAiCallbackUrl.hash = "";

    const eventsClient = createEventsOrpcClient({
      baseUrl: context.config.eventsBaseUrl,
      projectSlug,
    });

    for (const subscription of [
      {
        slug: AGENT_CHAT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
        callable: fetchCallableFromWebSocketUrl(
          buildAgentChatStreamProcessorRunnerWebSocketCallbackUrl({
            publicOrigin,
            runnerInstance,
            streamPath,
          }),
        ),
      },
      {
        slug: AGENT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
        callable: fetchCallableFromWebSocketUrl(
          buildAgentStreamProcessorRunnerWebSocketCallbackUrl({
            publicOrigin,
            runnerInstance,
            streamPath,
          }),
        ),
      },
      {
        slug: "cloudflare-ai-stream-processor-runner",
        callable: fetchCallableFromWebSocketUrl(cloudflareAiCallbackUrl.toString()),
      },
      {
        slug: CODEMODE_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
        callable: fetchCallableFromWebSocketUrl(
          buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl({
            publicOrigin,
            runnerInstance,
            streamPath,
          }),
        ),
      },
    ]) {
      await eventsClient.append({
        path: streamPath,
        event: {
          type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
          payload: {
            slug: subscription.slug,
            type: "websocket",
            callable: subscription.callable,
          },
          idempotencyKey: `create-agent:${streamPath}:subscription:${subscription.slug}`,
        },
      });
    }

    await eventsClient.append({
      path: streamPath,
      event: {
        type: "events.iterate.com/agent/input-added",
        payload: {
          content: input.initialPrompt,
          // Omitting `triggerLlmRequest` means it defaults to `auto`, which
          // resolves to `interrupt-current-request`.
        },
      },
    });

    return {
      streamPath,
      streamViewerUrl: buildStreamViewerUrl({
        eventsBaseUrl: context.config.eventsBaseUrl,
        projectSlug,
        streamPath,
      }),
    };
  }),
};

function getPublicOrigin(request: Request | undefined) {
  if (request == null) {
    throw new Error(
      "createAgent requires the raw request to derive stream processor callback URLs.",
    );
  }

  return new URL(request.url).origin;
}

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
