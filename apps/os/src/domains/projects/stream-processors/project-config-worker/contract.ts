// Defines the "project-config-worker" processor contract.
//
// The project's config worker (the project repo's worker.js) is a stream
// processor: this contract subscribes it to the project root stream ("/") and
// every committed event is forwarded to its exported `processEvent` hook. That
// is the project-code composition surface — config workers react to facts and
// append facts. The motivating example is per-project agent context: the root
// stream carries `stream/child-stream-created` for every new stream in the
// project (including agent streams), so a config worker can watch for new
// `/agents/...` paths and append its own system prompt, capability notes, or
// llm config to them — last-wins reducers and the platform's
// defaults-yield-to-existing-events behavior do the rest. No bespoke hook
// protocol, no merge logic: just events.

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
