// Defines the "browser-raw-events" processor contract.
// This browser-only processor consumes every stream event and stores the raw
// append log into the per-stream OPFS SQLite `events` table that stream views read.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";

export const BrowserRawEventsContract = defineProcessorContract({
  slug: "browser-raw-events",
  version: "0.1.0",
  description: "Stores raw stream events in the browser SQLite events table.",
  stateSchema: z.object({}).meta({
    description:
      "Stateless: the per-stream SQLite events table is the projection; the only durable bookkeeping is the runner's resume cursor.",
  }),
  events: {},
  consumes: ["*"],
  emits: [],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<BrowserRawEventsContract>`,
 * `ConsumedEvent<BrowserRawEventsContract>`.
 */
export type BrowserRawEventsContract = typeof BrowserRawEventsContract;
