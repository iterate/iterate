// Defines the "echo-example" processor contract.
// Counts received inputs and echoes each back as an output carrying the running count.

import { z } from "zod";
import { defineProcessorContract } from "../../../shared/stream-processors.ts";
import { standardProcessorBehavior } from "../../standard-processor-behavior.ts";

export const echoExampleProcessorContract = defineProcessorContract({
  slug: "echo-example",
  version: "0.1.0",
  description:
    "Counts received inputs and echoes each back as an output carrying the running count.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    seen: z.number().int().min(0).default(0),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
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
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/echo-example/input-received",
  ],
  emits: [...standardProcessorBehavior.emits, "events.iterate.com/echo-example/output-echoed"],
  reduce({ state, event, contract }) {
    const nextState = standardProcessorBehavior.reduce({ state, event, contract });
    return event.type === "events.iterate.com/echo-example/input-received"
      ? { ...nextState, seen: nextState.seen + 1 }
      : nextState;
  },
});

export type EchoExampleState = z.infer<typeof echoExampleProcessorContract.stateSchema>;
