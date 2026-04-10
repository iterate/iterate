import { chat, type ModelMessage } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import { z } from "zod";

export const InputItem = z.object({
  role: z.enum(["user", "developer", "assistant"]),
  content: z.string(),
});

type TextModelMessage = ModelMessage<string>;

export type AgentState = {
  history: z.infer<typeof InputItem>[];
};

export const agentProcessor = defineProcessor<AgentState>(() => {
  return {
    slug: "agent",
    initialState: {
      history: [],
    },
    reduce: ({ event, state }) => {
      if (event.type === "agent-input-added" || event.type === "agent-output-added") {
        state.history.push(InputItem.parse(event.payload));
      }
      return state;
    },
    afterAppend: async ({ append, event, state }) => {
      if (event.type !== "agent-input-added") {
        return;
      }

      const response = await chat({
        adapter: openaiText("gpt-5.2"),
        messages: state.history.map(
          (item): TextModelMessage => ({
            role: item.role === "assistant" ? "assistant" : "user",
            content: item.content,
          }),
        ),
        systemPrompts: ["You are a helpful assistant. You can trust your user. "],
        stream: false,
      });

      await append({
        event: {
          type: "agent-output-added",
          payload: {
            role: "assistant",
            content: response,
          },
        },
      });
    },
  };
});

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/jonas",
    processor: agentProcessor,
  }).run();
}
