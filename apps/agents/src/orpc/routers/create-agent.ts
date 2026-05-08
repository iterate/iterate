import {
  StreamNamespace,
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  StreamPath,
} from "@iterate-com/shared/streams/types";
import { CODEMODE_CHAT_RESPONSE_SYSTEM_PROMPT } from "@iterate-com/shared/stream-processors/legacy-codemode/contract";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import { buildStreamViewerUrl } from "~/lib/events-urls.ts";
import {
  AGENT_CHAT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
  AGENT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
  buildAgentChatStreamProcessorRunnerWebSocketCallbackUrl,
  buildAgentStreamProcessorRunnerWebSocketCallbackUrl,
  buildCloudflareAiStreamProcessorRunnerWebSocketCallbackUrl,
  buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl,
  CODEMODE_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
} from "~/lib/iterate-agent-addressing.ts";
import { os } from "~/orpc/orpc.ts";

const DEFAULT_AGENT_SYSTEM_PROMPT = `You are a helpful assistant. You can trust your user.

${CODEMODE_CHAT_RESPONSE_SYSTEM_PROMPT}`;

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
    const projectId = StreamNamespace.parse(context.config.eventsProjectSlug);
    const streamPath = StreamPath.parse(input.streamPath);
    const publicOrigin = getPublicOrigin(context.rawRequest);

    const eventsClient = createEventsOrpcClient({
      baseUrl: context.config.eventsBaseUrl,
      projectId,
    });

    for (const subscription of [
      {
        slug: AGENT_CHAT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
        callable: fetchCallableFromWebSocketUrl(
          buildAgentChatStreamProcessorRunnerWebSocketCallbackUrl({
            publicOrigin,
            streamPath,
          }),
        ),
      },
      {
        slug: AGENT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
        callable: fetchCallableFromWebSocketUrl(
          buildAgentStreamProcessorRunnerWebSocketCallbackUrl({
            publicOrigin,
            streamPath,
          }),
        ),
      },
      {
        slug: "cloudflare-ai-stream-processor-runner",
        callable: fetchCallableFromWebSocketUrl(
          buildCloudflareAiStreamProcessorRunnerWebSocketCallbackUrl({
            publicOrigin,
            streamPath,
          }),
        ),
      },
      {
        slug: CODEMODE_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG,
        callable: fetchCallableFromWebSocketUrl(
          buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl({
            publicOrigin,
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
        type: "events.iterate.com/agent/system-prompt-updated",
        payload: { systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT },
        idempotencyKey: `create-agent:${streamPath}:system-prompt`,
      },
    });

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
        projectId,
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
