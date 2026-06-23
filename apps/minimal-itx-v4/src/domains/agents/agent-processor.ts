import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "../streams/engine/stream-processor.ts";

export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.1.0",
  description: "Tiny agent projection for the ITX reference implementation.",
  stateSchema: z.object({
    created: z.boolean().default(false),
    initialized: z.boolean().default(false),
    messages: z
      .array(z.looseObject({ message: z.string(), channel: z.string().optional() }))
      .default([]),
  }),
  initialState: { created: false, initialized: false, messages: [] },
  events: {
    "events.iterate.com/agent/create-requested": {
      description: "An agent creation was requested.",
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/agent/created": {
      description: "The agent was created.",
      payloadSchema: z.looseObject({}),
    },
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
  consumes: [
    "events.iterate.com/agent/create-requested",
    "events.iterate.com/agent/created",
    "events.iterate.com/stream/created",
    "events.iterate.com/agent/message-sent",
  ],
  emits: ["events.iterate.com/agent/created", "events.iterate.com/agent/message-sent"],
});

export class AgentProcessor extends StreamProcessor<typeof AgentProcessorContract> {
  readonly contract = AgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof AgentProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/agent/created":
        return { ...state, created: true };
      case "events.iterate.com/stream/created":
        return { ...state, initialized: true };
      case "events.iterate.com/agent/message-sent":
        return { ...state, messages: [...state.messages, event.payload] };
      default:
        return state;
    }
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
  }: Parameters<StreamProcessor<typeof AgentProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/agent/create-requested") return;
    blockProcessorWhile(async () => {
      await this.stream.append({
        type: "events.iterate.com/agent/created",
        idempotencyKey: `agent-created:${event.offset}`,
        payload: event.payload,
      });
    });
  }
}
