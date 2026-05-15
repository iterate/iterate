import { ORPCError } from "@orpc/server";
import type { EventInput } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { AppContext } from "~/context.ts";
import { getStreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";

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
  context: AppContext,
  input: AppendIntegrationEventInput,
) {
  if (!context.workerExports) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Worker exports are not available.",
    });
  }

  const streamPath =
    input.provider === "slack" ? SLACK_INTEGRATION_STREAM_PATH : GOOGLE_INTEGRATION_STREAM_PATH;
  return await getStreamsCapability({
    exports: context.workerExports,
    props: {
      appendPolicy: { mode: "stream" },
      projectId: input.projectId,
      streamPath,
    },
  }).append({
    event: input.event,
  });
}
