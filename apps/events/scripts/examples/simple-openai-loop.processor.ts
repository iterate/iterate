import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { defineProcessor } from "../../src/durable-objects/define-processor.ts";

type State = { history: ResponseInput };
const initialState: State = { history: [] };

const openai = new OpenAI({
  apiKey: "getIterateSecret({secretKey: 'dynamic_worker_openai_api_key'})",
  dangerouslyAllowBrowser: true,
});

export default defineProcessor<State>(() => ({
  slug: "simple-openai-loop",
  initialState,

  reduce({ state, event }) {
    if (event.type !== "llm-input-added" && event.type !== "llm-output-added") {
      return state;
    }

    const role = event.type === "llm-input-added" ? "user" : "assistant";
    const content = readEventContent(event);
    if (typeof content !== "string" || content.trim().length === 0) {
      return state;
    }

    return {
      history: [...state.history, { role, content }],
    };
  },

  async afterAppend({ append, event, state }) {
    if (event.type !== "llm-input-added") {
      return;
    }

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions:
        "You are a helpful assistant in an events stream. Keep answers concise. If the user asks a math question, reply with only the final answer.",
      input: state.history,
    });

    await append({
      event: {
        type: "llm-output-added",
        payload: {
          content: response.output_text,
        },
      },
    });
  },
}));

function readEventContent(event: { payload?: unknown }) {
  const payload = event.payload;
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const content = (payload as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}
