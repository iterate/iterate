import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import OpenAI from "openai";
import { z } from "zod";
import type { ResponseInputItem } from "openai/resources/responses/responses.mjs";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import dedent from "dedent";

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
        if (typedEvent.payload.type === "response.output_text.done") {
          state.history.push({ role: "assistant", content: typedEvent.payload.text });
        }
      }
      return state;
    },
    afterAppend: async ({ append, event, state, logger }) => {
      logger.info("afterAppend", { event: event.type });
      if (event.type === "agent-input-added") {
        const response = await openai.responses.create({
          model: "gpt-5.4",
          instructions: dedent`
            You are an AI coding agent. Instead of using function tool calls to interact with
            your computer, you just write bash in triple backtick code blocks.

            The bash code will then be run and you'll get the output back.
          `,
          input: state.history,
          stream: true,
        });
        for await (const openaiEvent of response) {
          if (openaiEvent.type === "response.output_text.delta") continue;
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
