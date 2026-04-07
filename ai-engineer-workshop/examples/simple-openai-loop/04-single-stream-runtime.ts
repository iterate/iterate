import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import {
  createEventsClient,
  defineProcessor,
  PullSubscriptionProcessorRuntime,
  runWorkshopMain,
} from "ai-engineer-workshop";

const openai = new OpenAI();

type State = { history: ResponseInput };
const initialState: State = { history: [] };

const processor = defineProcessor(() => ({
  slug: "simple-openai-loop-runtime",
  initialState,

  reduce: ({ event, state }) => {
    if (event.type === "llm-input-added" || event.type === "llm-output-added") {
      const role = event.type === "llm-input-added" ? "user" : "assistant";
      const content = (event.payload as { content: string }).content;
      const history: ResponseInput = [...state.history, { role, content }];
      return { history };
    }
    return state;
  },

  afterAppend: async ({ append, event, state }) => {
    if (event.type !== "llm-input-added") return;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions: "You are a helpful assistant. Keep answers concise.",
      input: state.history,
    });

    await append({
      event: { type: "llm-output-added", payload: { content: response.output_text } },
    });
  },
}));

export async function run() {
  const streamPath = `${process.env.PATH_PREFIX}/simple-openai-loop-runtime`;

  console.log(`Watching ${streamPath}`);

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createEventsClient(),
    processor,
    streamPath,
  }).run();
}

runWorkshopMain(import.meta.url, run);
