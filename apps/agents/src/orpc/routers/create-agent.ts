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
/**
 * Deliberately constant: Events upserts subscriptions by `slug`, so reusing the
 * same slug for a given stream path means re-creating an agent at that path
 * replaces the old subscription in place instead of stacking up dead ones.
 */
const SUBSCRIPTION_SLUG = "iterate-agent";

export const createAgentRouter = {
  createAgent: os.createAgent.handler(async ({ input }) => {
    const streamPath = StreamPath.parse(input.streamPath);
    const projectSlug = ProjectSlug.parse(input.projectSlug);
    const agentInstance = streamPathToAgentInstance(streamPath);

    const callbackUrl = buildAgentWebSocketCallbackUrl({
      publicOrigin: new URL(input.publicBaseUrl).origin,
      agentClass: AGENT_CLASS,
      agentInstance,
    });

    const eventsClient = createEventsOrpcClient({
      baseUrl: DEFAULT_EVENTS_BASE_URL,
      projectSlug,
    });

    // Ordering matters: subscription first so the WS connects, then llm-config
    // and system prompt land before any subsequent user turn.
    await eventsClient.append({
      path: streamPath,
      event: {
        type: "https://events.iterate.com/events/stream/subscription/configured",
        payload: {
          slug: SUBSCRIPTION_SLUG,
          type: "websocket",
          callbackUrl,
        },
      },
    });

    let modelApplied: string | null = null;
    if (input.model) {
      await eventsClient.append({
        path: streamPath,
        event: {
          type: "llm-config-updated",
          payload: {
            model: input.model,
            runOpts: input.runOpts ?? {},
          },
        },
      });
      modelApplied = input.model;
    }

    const systemPromptTrimmed = input.systemPrompt?.trim() ?? "";
    const systemPromptApplied = systemPromptTrimmed.length > 0;
    if (systemPromptApplied) {
      await eventsClient.append({
        path: streamPath,
        event: {
          type: "agent-input-added",
          payload: {
            role: "system",
            content: systemPromptTrimmed,
          },
        },
      });
    }

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
      subscriptionSlug: SUBSCRIPTION_SLUG,
      agentInstance,
      modelApplied,
      systemPromptApplied,
    };
  }),
};

/**
 * Derive a deterministic Durable Object instance name from a stream path so
 * re-creating an agent at the same path always hits the same DO (and different
 * paths always hit different DOs). Must be URL-path-safe because it's
 * interpolated into `/agents/<class>/<instance>`.
 *
 * - `/`           → `root`
 * - `/jonas`      → `jonas`
 * - `/jonas/abc`  → `jonas-abc`
 * - `/a/b.c!/d`   → `a-b-c-d`
 */
function streamPathToAgentInstance(streamPath: string): string {
  const kebab = streamPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab.length === 0 ? "root" : kebab;
}
