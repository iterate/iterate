// Defines the "project-config-worker" processor contract.
//
// The project's config worker (the project repo's worker.js) is a stream
// processor: this contract subscribes it to the project root stream ("/") and
// every committed event is forwarded to its exported `processEvent` hook. That
// is the project-code composition surface — config workers react to facts and
// append facts. No bespoke hook protocol, no merge logic: just events.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";

export const ProjectConfigWorkerProcessorContract = defineProcessorContract({
  slug: "project-config-worker",
  version: "0.1.0",
  description:
    "Forwards every project root-stream event to the project config worker's processEvent hook.",
  // The processor itself is stateless: the config worker owns whatever durable
  // facts it wants by appending them to streams.
  stateSchema: z.object({}),
  initialState: {},
  events: {},
  consumes: ["*"],
  emits: [],
});

export type ProjectConfigWorkerProcessorContract = typeof ProjectConfigWorkerProcessorContract;
