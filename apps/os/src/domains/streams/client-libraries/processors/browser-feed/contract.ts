// Defines the "browser-feed" processor contract.
// This browser-only processor consumes every stream event and projects it
// into the per-stream OPFS SQLite `feed_items` table — the single rendered-
// feed projection behind Pretty, Pretty+raw, and Raw — plus reduced state for
// the live in-flight agent tail.

import { z } from "zod";
import { defineProcessorContract } from "../../../processor-contracts.ts";
import { initialBrowserFeedState, type BrowserFeedState } from "./projector.ts";

export const BrowserFeedContract = defineProcessorContract({
  slug: "browser-feed",
  version: "0.1.0",
  description:
    "Browser-side projector folding every stream event into the single feed_items table (pretty agent rows and grouped raw rows in one total order) plus live in-flight agent state.",
  // itx derives a processor's empty fold from `stateSchema.parse({})`
  // (there is no separate `initialState`), so the schema spreads
  // initialBrowserFeedState() under whatever was persisted — parse({}) IS the
  // initial state, and a persisted snapshot passes through unchanged.
  stateSchema: z.preprocess(
    (value) => ({ ...initialBrowserFeedState(), ...(value as object) }),
    z.custom<BrowserFeedState>((value) => value !== null && typeof value === "object"),
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
export type BrowserFeedContract = typeof BrowserFeedContract;
