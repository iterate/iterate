import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import OpenAI from "openai";
import { z } from "zod";
import type { ResponseInputItem } from "openai/resources/responses/responses.mjs";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";

export const AgentInputAdded = z.object({
  type: z.literal("agent-input-added"),
  payload: z.object({
    role: z.enum(["user", "developer"]),
    content: z.string(),
  }),
});

export const OpenAiResponseEventAdded = z.object({
  type: z.literal("openai-response-event-added"),
  payload: z.custom<ResponseStreamEvent>(),
});

export type AgentState = {
  history: ResponseInputItem[];
};

export const agentProcessor = defineProcessor<AgentState>(() => {
  const openai = new OpenAI();

  return {
    slug: "agent",
    initialState: {
      history: [],
    },
    reduce: ({ event, state }) => {
      if (event.type === "agent-input-added") {
        const typedEvent = AgentInputAdded.parse(event);
        state.history.push(typedEvent.payload);
      }
      if (event.type === "openai-response-event-added") {
        const typedEvent = OpenAiResponseEventAdded.parse(event);
        if (typedEvent.payload.type === "response.output_item.done") {
          state.history.push(typedEvent.payload.item);
        }
      }
      return state;
    },
    afterAppend: async ({ append, event, state }) => {
      if (event.type === "agent-input-added") {
        const response = await openai.responses.create({
          model: "gpt-5.4",
          instructions: "You are a helpful assistant. Keep answers concise.",
          input: state.history,
          stream: true,
        });
        for await (const openaiEvent of response) {
          // Add this line later
          await append({
            event: {
              type: "openai-response-event-added",
              payload: openaiEvent,
            },
          });
        }
      }
    },
  };
});

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/jonas",
    processor: agentProcessor,
  }).run();
}
