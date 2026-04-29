import { z } from "zod";
import {
  assertNever,
  defineProcessorContract,
  reduceProcessorEvents,
  type StreamEvent,
} from "@iterate-com/shared/stream-processors";
import { AgentProcessorContract } from "../agent/contract.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";

/**
 * Frontend-safe public contract for webchat ingress and visible responses.
 *
 * The webchat processor owns raw webchat events. Its backend implementation
 * renders those events into curated `agent/input-added` rows, so the Agent
 * processor does not need to know where an input row came from.
 */
export const WebchatProcessorContract = defineProcessorContract({
  slug: "webchat",
  version: "0.1.0",
  description: "Renders webchat ingress and tool responses into model-visible agent input.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps, AgentProcessorContract],
  events: {
    "events.iterate.com/webchat/user-message-added": {
      description: "Raw inbound webchat message before it is rendered into model context.",
      payloadSchema: z.object({ content: z.string() }),
    },
    "events.iterate.com/webchat/agent-response-added": {
      description: "User-visible webchat response emitted by a tool call.",
      payloadSchema: z.object({ message: z.string() }),
    },
  },
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/webchat/user-message-added",
    "events.iterate.com/webchat/agent-response-added",
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
      case "events.iterate.com/webchat/user-message-added":
      case "events.iterate.com/webchat/agent-response-added":
        return nextState;
      default:
        return assertNever(event);
    }
  },
});

export function reduceWebchatEvents(args: {
  events: readonly StreamEvent[];
  state?: WebchatState;
}): WebchatState {
  return reduceProcessorEvents({
    contract: WebchatProcessorContract,
    events: args.events,
    state: args.state,
  });
}

export type WebchatState = z.infer<typeof WebchatProcessorContract.stateSchema>;
