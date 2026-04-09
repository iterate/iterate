import { defineProcessor, PullSubscriptionPatternProcessorRuntime } from "ai-engineer-workshop";
import OpenAI from "openai";
import type {
  ResponseCompletedEvent,
  ResponseInputItem,
} from "openai/resources/responses/responses.mjs";

const openai = new OpenAI();

type State = {
  history: ResponseInputItem[];
  systemPrompt: string;
  model: string;
};

const processor = defineProcessor<State>(() => ({
  slug: "agent",
  initialState: {
    history: [],
    systemPrompt: "You are a helpful assistant. Keep answers concise.",
    model: "gpt-4o-mini",
  },
  reduce: ({ event, state }) => {
    switch (event.type) {
      case "agent-input-added":
        return {
          ...state,
          history: [...state.history, event.payload as ResponseInputItem],
        };
      case "agent-output-added":
        return {
          ...state,
          history: [
            ...state.history,
            ...((event.payload as ResponseCompletedEvent).response.output as ResponseInputItem[]),
          ],
        };
    }
  },
  afterAppend: async ({ append, event, state }) => {
    if (event.type !== "agent-input-added") {
      return;
    }

    const response = await openai.responses.create({
      model: state.model,
      instructions: state.systemPrompt,
      input: state.history,
      stream: true,
    });

    for await (const item of response) {
      if (item.type !== "response.completed") {
        continue;
      }

      await append({
        event: {
          type: "agent-output-added",
          payload: item,
        },
      });
    }
  },
}));

await new PullSubscriptionPatternProcessorRuntime({
  pathPrefix: "/jonas",
  processor,
}).run();
