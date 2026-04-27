import { ProjectSlug, StreamPath } from "@iterate-com/events-contract";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import { buildStreamViewerUrl } from "~/lib/events-urls.ts";
import { os } from "~/orpc/orpc.ts";

/**
 * Thin wrapper around `events.append` that drops a single
 * `agent-input-added` (role: user) event onto a stream under the
 * auto-subscriber's prefix.
 *
 * Everything else — wiring up the iterate-agent DO, applying base-path
 * defaults — happens automatically once the events service notifies the
 * auto-subscriber via `child-stream-created`. We don't need to record the
 * agent anywhere here; the events service is the registry.
 */
export const createAgentRouter = {
  createAgent: os.createAgent.handler(async ({ input, context }) => {
    const projectSlug = ProjectSlug.parse(context.config.eventsProjectSlug);
    const streamPath = StreamPath.parse(input.streamPath);

    const eventsClient = createEventsOrpcClient({
      baseUrl: context.config.eventsBaseUrl,
      projectSlug,
    });

    await eventsClient.append({
      path: streamPath,
      event: {
        type: "agent-input-added",
        payload: {
          role: "user",
          content: input.initialPrompt,
          // Omitting `triggerLlmRequest` means it defaults to `auto`, which
          // resolves to `interrupt-current-request` for the user role.
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
