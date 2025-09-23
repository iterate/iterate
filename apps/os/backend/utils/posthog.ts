import type { MergedEventForSlices } from "../agent/agent-core.ts";
import { PosthogCloudflare } from "./posthog-cloudflare.ts";
import type { ReactionAddedEvent, ReactionRemovedEvent } from "@slack/types";
import type { SlackAgentSlices } from "../agent/slack-agent.ts";

type AgentEventType = MergedEventForSlices<SlackAgentSlices>["type"];
type Events = Record<
  `agent:${Lowercase<AgentEventType>}`,
  {
    type: AgentEventType;
    rawEvent: unknown;
  }
> &
  Record<
    `slack:webhook_event_received:${(ReactionAddedEvent | ReactionRemovedEvent)["type"]}`,
    { rawEvent: ReactionAddedEvent | ReactionRemovedEvent }
  > & {
    "github:webhook_received": { rawEvent: unknown };
  };

export class OSPosthog extends PosthogCloudflare<Events> {}
