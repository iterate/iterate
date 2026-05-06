import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "../stream-processor.ts";
import { AgentProcessorContract } from "../agent/contract.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

export const AgentChatChannel = z.enum(["web", "tui"]);

/**
 * Frontend-safe public contract for chat ingress and visible chat responses.
 *
 * Web and terminal chat are channels of the same domain concept. The channel
 * stays in payload data; the processor owns rendering chat-domain events into
 * curated `agent/input-added` rows for the Agent processor.
 */
export const AgentChatProcessorContract = defineProcessorContract({
  slug: "agent-chat",
  version: "0.1.0",
  description: "Renders chat ingress and visible responses into model-visible agent input.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps, AgentProcessorContract],
  events: {
    "events.iterate.com/agent-chat/user-message-added": {
      description: "Raw inbound chat message before it is rendered into model context.",
      payloadSchema: z.object({
        channel: AgentChatChannel,
        content: z.string(),
      }),
    },
    "events.iterate.com/agent-chat/agent-response-added": {
      description: "User-visible chat response emitted by a tool call.",
      payloadSchema: z.object({
        channel: AgentChatChannel,
        message: z.string(),
      }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/agent-chat/user-message-added",
    "events.iterate.com/agent-chat/agent-response-added",
  ],
  emits: [...standardProcessorBehavior.emits, "events.iterate.com/agent/input-added"],
  reduce({ contract, state, event }) {
    const nextState = standardProcessorBehavior.reduce({
      state,
      event,
      contract,
    });

    switch (event.type) {
      case CoreProcessorRegisteredEventType:
      case "events.iterate.com/agent-chat/user-message-added":
      case "events.iterate.com/agent-chat/agent-response-added":
        return nextState;
      default:
        return assertNever(event);
    }
  },
});

export function reduceAgentChatEvents(args: {
  events: readonly StreamEvent[];
  state?: AgentChatState;
}): AgentChatState {
  return reduceProcessorEvents({
    contract: AgentChatProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export type AgentChatChannel = z.infer<typeof AgentChatChannel>;
export type AgentChatState = z.infer<typeof AgentChatProcessorContract.stateSchema>;
