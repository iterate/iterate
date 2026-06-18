import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";

export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.1.0",
  description: "Tiny agent projection for the ITX reference implementation.",
  stateSchema: z.object({
    initialized: z.boolean().default(false),
    messages: z
      .array(z.looseObject({ message: z.string(), channel: z.string().optional() }))
      .default([]),
  }),
  initialState: { initialized: false, messages: [] },
  events: {
    "events.iterate.com/stream/created": {
      description: "The agent stream exists.",
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/agent/message-sent": {
      description: "A message was sent through the agent.",
      payloadSchema: z.looseObject({
        channel: z.string().optional(),
        message: z.string(),
      }),
    },
  },
  consumes: ["events.iterate.com/stream/created", "events.iterate.com/agent/message-sent"],
  emits: ["events.iterate.com/agent/message-sent"],
});

export class AgentProcessor extends StreamProcessor<typeof AgentProcessorContract> {
  readonly contract = AgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof AgentProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/stream/created":
        return { ...state, initialized: true };
      case "events.iterate.com/agent/message-sent":
        return { ...state, messages: [...state.messages, event.payload] };
      default:
        return state;
    }
  }
}
