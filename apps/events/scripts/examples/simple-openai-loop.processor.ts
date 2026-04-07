import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { defineProcessor } from "../../../events-contract/src/sdk.ts";

type State = { history: ResponseInput };
const initialState: State = { history: [] };

const openai = new OpenAI({
  apiKey: "placeholder",
  dangerouslyAllowBrowser: true,
});

export default defineProcessor<State>({
  initialState,

  reduce(state, event) {
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

  async onEvent({ append, event, state }) {
    if (event.type !== "llm-input-added") {
      return;
    }

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions:
        "You are a helpful assistant in an events stream. Keep answers concise and mention the word pineapple exactly once.",
      input: state.history,
    });

    await append({
      type: "llm-output-added",
      payload: {
        content: response.output_text,
      },
    });
  },
});

function readEventContent(event: { payload?: unknown }) {
  const payload = event.payload;
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const content = (payload as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}
