// Defines the "browser-event-feed" processor contract.
// A browser-only reducing processor that consumes every stream event and folds
// consecutive events lacking a specific renderer into grouped feed_items rows.
// The reduced state is just the open, extendable group plus the dense row counter;
// the grouping itself lives in the pure planFeedOps helper so reduce and
// afterAppendBatch stay in lockstep.

import { z } from "zod";
import { defineProcessorContract } from "../../shared/stream-processors.ts";
import { INITIAL_FEED_STATE, planFeedOps, type FeedState } from "./grouping.ts";

export const browserEventFeedContract = defineProcessorContract({
  slug: "browser-event-feed",
  version: "0.1.0",
  description:
    "Groups consecutive stream events of the same type into the browser feed_items table.",
  stateSchema: z.custom<FeedState>(),
  initialState: INITIAL_FEED_STATE,
  events: {},
  consumes: ["*"],
  emits: [],
  reduce({ state, event }): FeedState {
    return planFeedOps(state, [event]).endState;
  },
});
