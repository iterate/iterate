// Defines the "browser-event-feed" processor contract.

import { z } from "zod";
import { defineProcessorContract } from "../../shared/stream-processors.ts";
import { INITIAL_FEED_STATE, type FeedState } from "./grouping.ts";

export const BrowserEventFeedContract = defineProcessorContract({
  slug: "browser-event-feed",
  version: "0.1.0",
  description:
    "Groups consecutive stream events of the same type into the browser feed_items table.",
  stateSchema: z.custom<FeedState>(),
  initialState: INITIAL_FEED_STATE,
  events: {},
  consumes: ["*"],
  emits: [],
});
