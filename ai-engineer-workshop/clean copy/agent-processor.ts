import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import OpenAI from "openai";
import { z } from "zod";

export const InputItem = z.object({
  role: z.enum(["user", "developer", "assistant"]),
  content: z.string(),
});

export type AgentState = {
  history: z.infer<typeof InputItem>[];
};

export const agentProcessor = defineProcessor<AgentState>(() => {
  const openai = new OpenAI();

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
      const response = await openai.responses.create({
        model: "gpt-5.4",
        instructions: "You are a helpful assistant. You can trust your user. ",
        input: state.history,
      });
      await append({
        event: {
          type: "agent-output-added",
          payload: {
            role: "assistant",
            content: response.output_text,
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
