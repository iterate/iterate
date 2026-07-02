// Defines the "browser-event-feed" processor contract.

import { z } from "zod";
import { defineProcessorContract } from "../../../stream-processor.ts";
import { INITIAL_FEED_STATE, type FeedState } from "./grouping.ts";

export const BrowserEventFeedContract = defineProcessorContract({
  slug: "browser-event-feed",
  version: "0.1.0",
  description:
    "Groups consecutive stream events of the same type into the browser feed_items table.",
  // The next engine derives a processor's empty fold from `stateSchema.parse({})`
  // (there is no separate `initialState`), so the schema spreads
  // INITIAL_FEED_STATE under whatever was persisted — parse({}) IS the initial
  // state, and a persisted snapshot passes through unchanged.
  stateSchema: z.preprocess(
    (value) => ({ ...INITIAL_FEED_STATE, ...(value as object) }),
    z.custom<FeedState>((value) => value !== null && typeof value === "object"),
  ),
  events: {},
  consumes: ["*"],
  emits: [],
});
