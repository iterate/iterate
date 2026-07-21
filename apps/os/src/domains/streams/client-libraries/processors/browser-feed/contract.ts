// Defines the "browser-feed" processor contract.
// This browser-only processor consumes every stream event and projects it
// into the per-stream OPFS SQLite `feed_items` table — the single rendered-
// feed projection behind Pretty, Pretty+raw, and Raw — plus reduced state for
// the live in-flight agent tail.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import {
  initialBrowserFeedState,
  isCurrentBrowserFeedState,
  type BrowserFeedState,
} from "./projector.ts";

export const BrowserFeedContract = defineProcessorContract({
  slug: "browser-feed",
  version: "0.4.0",
  description:
    "Browser-side projector reducing every stream event into the single feed_items table (pretty agent rows and grouped raw rows in one total order) plus live in-flight agent state.",
  // itx derives the initial reduce state from stateSchema.parse({}). Only that
  // exact empty input receives the initial state. Persisted snapshots must
  // identify themselves as the current schema; old browser caches are rejected
  // and rebuilt rather than adapted.
  stateSchema: z
    .preprocess(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
          ? initialBrowserFeedState()
          : value,
      z.custom<BrowserFeedState>(isCurrentBrowserFeedState, {
        message: "browser-feed state is not from the current schema",
      }),
    )
    .meta({
      description:
        "Reduced feed state: the agent-lens UI state (live in-flight tail), the currently open extendable raw group row, the next feed_items local_index (the total feed order), and row addresses for activities still awaiting a durable script correction. Snapshots from older schema versions are rejected and rebuilt from offset 0.",
    }),
  events: {},
  consumes: ["*"],
  emits: [],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<BrowserFeedContract>`,
 * `ConsumedEvent<BrowserFeedContract>`.
 */
export type BrowserFeedContract = typeof BrowserFeedContract;
