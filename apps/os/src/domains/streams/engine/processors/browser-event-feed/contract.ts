// Defines the "browser-event-feed" processor contract.

import { z } from "zod";
import {
  initialAgentUiState,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { defineProcessorContract } from "../../shared/stream-processors.ts";
import { INITIAL_FEED_STATE, type FeedState } from "./grouping.ts";

export type BrowserEventFeedState = {
  feed: FeedState;
  agentUi: AgentUiState;
};

export function initialBrowserEventFeedState(): BrowserEventFeedState {
  return {
    feed: INITIAL_FEED_STATE,
    agentUi: initialAgentUiState(),
  };
}

export const BrowserEventFeedContract = defineProcessorContract({
  slug: "browser-event-feed",
  version: "0.1.0",
  description: "Projects stream events into browser feed item tables and live feed state.",
  stateSchema: z.custom<BrowserEventFeedState>(
    (value) => value != null && typeof value === "object",
  ),
  initialState: initialBrowserEventFeedState(),
  events: {},
  consumes: ["*"],
  emits: [],
});
