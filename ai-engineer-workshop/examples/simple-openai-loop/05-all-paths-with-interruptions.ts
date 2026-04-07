import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import {
  createEventsClient,
  defineProcessor,
  PullSubscriptionPatternProcessorRuntime,
  runWorkshopMain,
} from "ai-engineer-workshop";

const openai = new OpenAI();
const activeRequests = new Map<string, { controller: AbortController; requestId: string }>();

type State = { history: ResponseInput; requestId: string | null };
const initialState: State = { history: [], requestId: null };

const processor = defineProcessor(() => ({
  slug: "simple-openai-loop",
  initialState,

  reduce: ({ event, state }) => {
    if (event.type === "llm-input-added" || event.type === "llm-output-added") {
      const role = event.type === "llm-input-added" ? "user" : "assistant";
      const content = (event.payload as { content: string }).content;
      const history: ResponseInput = [...state.history, { role, content }];
      return { ...state, history };
    }
    if (event.type === "llm-request-started") {
      return { ...state, requestId: (event.payload as { requestId: string }).requestId };
    }
    if (event.type === "llm-request-completed" || event.type === "llm-request-canceled") {
      return { ...state, requestId: null };
    }
    return state;
  },

  afterAppend: async ({ append, event, state }) => {
    if (event.type !== "llm-input-added") return;

    const active = activeRequests.get(event.streamPath);
    if (active) {
      active.controller.abort();
      activeRequests.delete(event.streamPath);
      await append({
        event: { type: "llm-request-canceled", payload: { requestId: active.requestId } },
      });
    }

    const requestId = randomUUID();
    const controller = new AbortController();
    activeRequests.set(event.streamPath, { controller, requestId });

    await append({
      event: { type: "llm-request-started", payload: { requestId } },
    });

    try {
      const response = await openai.responses.create(
        {
          model: "gpt-4o-mini",
          instructions: "You are a helpful assistant. Keep answers concise.",
          input: state.history,
        },
        { signal: controller.signal },
      );

      await append({
        event: { type: "llm-output-added", payload: { content: response.output_text } },
      });
      await append({
        event: { type: "llm-request-completed", payload: { requestId } },
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    } finally {
      if (activeRequests.get(event.streamPath)?.requestId === requestId) {
        activeRequests.delete(event.streamPath);
      }
    }
  },
}));

export async function run() {
  const streamPattern = `${process.env.PATH_PREFIX}/**`;

  console.log(`Watching ${streamPattern}`);

  await new PullSubscriptionPatternProcessorRuntime({
    eventsClient: createEventsClient(),
    processor,
    streamPattern,
  }).run();
}

runWorkshopMain(import.meta.url, run);
