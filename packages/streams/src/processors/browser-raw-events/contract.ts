// Defines the "browser-raw-events" processor contract.
// This browser-only processor consumes every stream event and mirrors the raw
// append log into the per-stream OPFS SQLite `events` table that stream views read.

import { z } from "zod";
import { defineProcessorContract } from "../../shared/stream-processors.ts";

export const browserRawEventsContract = defineProcessorContract({
  slug: "browser-raw-events",
  version: "0.1.0",
  description: "Mirrors raw stream events into the browser SQLite events table.",
  stateSchema: z.object({}),
  initialState: {},
  events: {},
  consumes: ["*"],
  emits: [],
});
