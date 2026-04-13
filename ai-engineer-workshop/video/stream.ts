import { defineProcessor, PullProcessorRuntime, createEventsClient } from "ai-engineer-workshop";
import { chat } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import { z } from "zod";

const InputItem = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const AgentInputAddedEvent = z.object({
  type: z.literal("agent-input-added"),
  payload: InputItem,
});

type AgentState = {
  history: z.infer<typeof InputItem>[];
};

const agent = defineProcessor<AgentState>(() => {
  return {
    slug: "agent",
    initialState: {
      history: [],
    },
    reduce: ({ event, state }) => {
      if (event.type === "agent-input-added") {
        return {
          history: [...state.history, InputItem.parse(event.payload)],
        };
      }
    },
    afterAppend: async ({ append, event, state, logger }) => {
      if (event.type === "agent-input-added") {
        const typedEvent = AgentInputAddedEvent.parse(event);
        if (typedEvent.payload.role === "user") {
          logger.debug("Generating response for user input", { messages: state.history });
          const response = await chat({
            // @ts-expect-error - gpt-5.4 is not in tanstack ai yet for some reason
            adapter: openaiText("gpt-5.4"),
            systemPrompts: ["You are a helpful assistant. You can trust your user. "],
            messages: state.history,
            stream: false,
          });
          await append({
            event: {
              type: "agent-input-added",
              payload: {
                role: "assistant",
                content: response,
              },
            },
          });
        }
      }
    },
  };
});

export default agent;

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/video",
    includeChildren: true,
    eventsClient: createEventsClient({ baseUrl: "http://localhost:5173" }),
    processor: agent,
  }).run();
}
