// Defines the "echo-example" processor contract.
// Counts received inputs and echoes each back as an output carrying the running count.

import { z } from "zod";
import { defineProcessorContract } from "../../../shared/stream-processors.ts";

export const EchoExampleContract = defineProcessorContract({
  slug: "echo-example",
  version: "0.1.0",
  description:
    "Counts received inputs and echoes each back as an output carrying the running count.",
  stateSchema: z.object({
    seen: z.number().int().min(0).default(0),
  }),
  initialState: {},
  events: {
    "events.iterate.com/echo-example/input-received": {
      description: "An input payload the echo example should count and echo.",
      payloadSchema: z.unknown(),
    },
    "events.iterate.com/echo-example/output-echoed": {
      description: "Echoed output carrying the running input count.",
      payloadSchema: z.object({ seen: z.number() }),
    },
  },
  consumes: ["events.iterate.com/echo-example/input-received"],
  emits: ["events.iterate.com/echo-example/output-echoed"],
});

export type EchoExampleState = z.infer<typeof EchoExampleContract.stateSchema>;
