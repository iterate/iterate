// The rendered-feed processor contract shared by the browser mirror and the
// experimental Stream Durable Object host.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import {
  initialStreamFeedState,
  isCurrentStreamFeedState,
  type StreamFeedState,
} from "./projector.ts";

export const StreamFeedContract = defineProcessorContract({
  // Preserve the browser processor identity while both hosts share this fold.
  // Changing either value would discard every existing OPFS projection even
  // though the schema and reduction semantics are unchanged.
  slug: "browser-feed",
  version: "0.2.0",
  description:
    "Rendered-feed projector folding durable events into one feed_items table (pretty agent rows and grouped raw rows in total order) plus the live agent state.",
  // itx derives the empty fold from stateSchema.parse({}). Only that exact
  // empty input receives the initial state. Persisted snapshots must identify
  // themselves as the current schema; old browser caches are rejected and
  // rebuilt rather than adapted.
  stateSchema: z.preprocess(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
        ? initialStreamFeedState()
        : value,
    z.custom<StreamFeedState>(isCurrentStreamFeedState, {
      message: "stream-feed state is not from the current schema",
    }),
  ),
  events: {},
  consumes: ["*"],
  emits: [],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<BrowserFeedContract>`,
 * `ConsumedEvent<BrowserFeedContract>`.
 */
export type StreamFeedContract = typeof StreamFeedContract;
