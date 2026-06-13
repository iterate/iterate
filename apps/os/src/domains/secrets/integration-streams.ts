import { ORPCError } from "@orpc/server";
import type { EventInput } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { RequestContext } from "~/request-context.ts";
import { getStreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";

export const SLACK_INTEGRATION_PROCESSOR_SLUG = "slack";
export const GOOGLE_INTEGRATION_PROCESSOR_SLUG = "google-integration";

export const SLACK_INTEGRATION_STREAM_PATH = StreamPath.parse("/integrations/slack");
export const GOOGLE_INTEGRATION_STREAM_PATH = StreamPath.parse("/integrations/google");

export const SLACK_CONNECTED_EVENT_TYPE = "events.iterate.com/slack/connected";
export const SLACK_DISCONNECTED_EVENT_TYPE = "events.iterate.com/slack/disconnected";
export const GOOGLE_CONNECTED_EVENT_TYPE = "events.iterate.com/google-integration/connected";
export const GOOGLE_DISCONNECTED_EVENT_TYPE = "events.iterate.com/google-integration/disconnected";

type IntegrationProvider = "google" | "slack";

type AppendIntegrationEventInput = {
  event: EventInput;
  projectId: string;
  provider: IntegrationProvider;
};

export async function appendIntegrationEvent(
  context: RequestContext,
  input: AppendIntegrationEventInput,
) {
  if (!context.workerExports) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Worker exports are not available.",
    });
  }

  return await appendNamespaceIntegrationEvent({
    event: input.event,
    exports: context.workerExports,
    projectId: input.projectId,
    provider: input.provider,
  });
}

/**
 * The context-free core of {@link appendIntegrationEvent}: append a connect/
 * disconnect event to the project's integration stream given the worker's
 * loopback `exports` directly. Used by the itx IntegrationsCapability, which
 * holds `ctx.exports` but no RequestContext.
 */
export async function appendNamespaceIntegrationEvent(input: {
  event: EventInput;
  exports: Parameters<typeof getStreamsBackend>[0]["exports"];
  projectId: string;
  provider: IntegrationProvider;
}) {
  const streamPath =
    input.provider === "slack" ? SLACK_INTEGRATION_STREAM_PATH : GOOGLE_INTEGRATION_STREAM_PATH;
  return await getStreamsBackend({
    exports: input.exports,
    props: {
      appendPolicy: { mode: "stream" },
      projectId: input.projectId,
      streamPath,
    },
  }).append({
    event: input.event,
  });
}
