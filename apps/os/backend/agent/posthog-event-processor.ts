import type { GenericMessageEvent } from "@slack/types";
import type { OSPosthog } from "../utils/posthog.ts";
import { SELF_AGENT_DISTINCT_ID } from "../utils/posthog-cloudflare.ts";
import type { AgentCoreSlice, MergedEventForSlices, MergedStateForSlices } from "./agent-core.ts";
import type { SlackAgentSlices } from "./slack-agent.ts";
import type { SlackWebhookPayload } from "./slack.types.ts";

interface SliceEventData {
  event: MergedEventForSlices<SlackAgentSlices>;
  reducedState: Partial<MergedStateForSlices<AgentCoreSlice[], SlackAgentSlices[]>>;
}

export async function processPosthogAgentCoreEvent({
  posthog,
  data,
}: {
  posthog: OSPosthog;
  data: SliceEventData;
}) {
  const event = data.event;
  const coreEventTypeLower = event.type.toLowerCase() as Lowercase<
    MergedEventForSlices<SlackAgentSlices>["type"]
  >;

  const { inputItems, ...rest } = data.reducedState;
  const rawEvent = {
    ...data,
    reducedState: {
      ...rest,
    },
  };

  posthog.track({
    event: `agent:${coreEventTypeLower}`,
    distinctId: await getDistinctIdForSliceEventData({
      posthog,
      data,
    }),
    properties: {
      type: event.type,
      rawEvent,
    },
  });
}

/**
 * For slack events, we need to identify the user or bot based on the event data
 * For all other agent core events, we mark as Agent
 */
async function getDistinctIdForSliceEventData({
  data,
  posthog,
}: {
  data: SliceEventData;
  posthog: OSPosthog;
}) {
  if (data.event.type === "SLACK:WEBHOOK_EVENT_RECEIVED") {
    const payload = data.event.data.payload as SlackWebhookPayload;
    const state = data.reducedState;

    if (
      payload.event &&
      (payload.event.type === "message" || payload.event.type === "reaction_added")
    ) {
      const event = payload.event as GenericMessageEvent;

      // sometimes slack will send us a bot_profile, so we know it's not a user, but it's not a bot we recognise
      if (event.bot_profile) {
        const id = `BOT[${event.bot_profile.id}]`;

        posthog.identify(id, {
          type: "bot",
          name: `Bot: ${event.bot_profile.name}`,
          slackBotProfile: event.bot_profile,
        });

        return id;
      }

      // many times it's a user participant - find participant by Slack user ID
      if (event.user) {
        const participant = state.participants
          ? Object.entries(state.participants).find(
              ([_, p]) => p.externalUserMapping?.slack?.externalUserId === event.user,
            )
          : null;

        if (!participant) {
          throw new Error(`Participant not found for user ${event.user}`);
        }

        const [internalUserId, participantData] = participant;
        posthog.identify(internalUserId, {
          type: "user",
          email: participantData.email ?? null,
        });
        return internalUserId;
      }

      return "SLACK[UNKNOWN]";
    }
  }

  // for all other events, we mark as Agent
  posthog.identify(SELF_AGENT_DISTINCT_ID(posthog.estateMeta.estate), {
    type: "agent",
  });
  return SELF_AGENT_DISTINCT_ID(posthog.estateMeta.estate);
}
