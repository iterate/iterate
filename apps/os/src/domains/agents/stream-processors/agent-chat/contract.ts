// Defines the "agent-chat" processor contract on the class-based stream model.
//
// Frontend-safe public contract for chat ingress and visible chat responses.
// Web and terminal chat are channels of the same domain concept. The channel
// stays in payload data; the processor owns rendering chat-domain events into
// curated `agent/input-added` rows for the Agent processor.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { AgentProcessorContract } from "../agent/contract.ts";

export const AgentChatChannel = z.enum(["web", "tui"]);

export const AgentChatProcessorContract = defineProcessorContract({
  slug: "agent-chat",
  version: "0.1.0",
  description: "Renders chat ingress and visible responses into model-visible agent input.",
  stateSchema: z.object({}),
  initialState: {},
  processorDeps: [AgentProcessorContract],
  events: {
    "events.iterate.com/agent-chat/user-message-added": {
      description: "Raw inbound chat message before it is rendered into model context.",
      examples: [
        {
          description: "Web chat message",
          payload: { channel: "web", content: "What can you help me with?" },
        },
      ],
      payloadSchema: z.object({
        channel: AgentChatChannel,
        content: z.string(),
      }),
    },
    "events.iterate.com/agent-chat/assistant-response-added": {
      description: "User-visible chat response emitted by a tool call.",
      examples: [
        {
          description: "Assistant reply via web",
          payload: {
            channel: "web",
            message: "I can help you manage your project, run code, and more.",
          },
        },
      ],
      payloadSchema: z.object({
        channel: AgentChatChannel,
        message: z.string(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/agent-chat/user-message-added",
    "events.iterate.com/agent-chat/assistant-response-added",
  ],
  emits: ["events.iterate.com/agent/input-added"],
});

export type AgentChatChannel = z.infer<typeof AgentChatChannel>;
export type AgentChatState = z.infer<typeof AgentChatProcessorContract.stateSchema>;
