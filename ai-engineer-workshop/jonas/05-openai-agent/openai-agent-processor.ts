/**
 * Minimal agent loop using the native OpenAI Responses API in streaming mode.
 *
 * Every SSE event from OpenAI is forwarded into the iterate event stream as-is,
 * so you can watch the full lifecycle in the browser: response.created, text
 * deltas, output_item.done, response.completed.
 *
 * Run with cwd `ai-engineer-workshop/jonas`:
 *
 *   doppler run --project ai-engineer-workshop --config dev_jonas -- pnpm tsx 05-openai-agent/openai-agent-processor.ts
 */
import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import type { ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses";
import { createEventsClient } from "../../lib/sdk.ts";
import { PullSubscriptionProcessorRuntime } from "../../lib/pull-subscription-processor-runtime.ts";
import { defineProcessor } from "../../lib/stream-process.ts";

const MODEL = "gpt-4o-mini";

type AgentState = {
  history: ResponseInput;
  requestInProgress: boolean;
};

const openai = new OpenAI();

const BASE_URL = process.env.BASE_URL || "https://events.iterate.com";
const STREAM_PATH = process.env.STREAM_PATH || `/jonas/05/${randomBytes(4).toString("hex")}`;

const agentProcessor = defineProcessor<AgentState>({
  initialState: {
    history: [],
    requestInProgress: false,
  },

  reduce: (state, event) => {
    if (event.type === "user-message") {
      const history: ResponseInput = [
        ...state.history,
        { role: "user" as const, content: event.payload.content as string },
      ];
      return { history, requestInProgress: true };
    }

    if (event.type === "openai-stream-event") {
      const streamEvent = event.payload as unknown as ResponseStreamEvent;

      if (streamEvent.type === "response.output_item.done") {
        const history: ResponseInput = [...state.history, streamEvent.item];
        return { history, requestInProgress: true };
      }

      if (streamEvent.type === "response.completed") {
        return { ...state, requestInProgress: false };
      }
    }
  },

  onEvent: async ({ append, event, state, prevState }) => {
    if (event.type !== "user-message" || prevState.requestInProgress) {
      return;
    }

    console.log(`Input offset=${event.offset}`);

    const stream = await openai.responses.create({
      model: MODEL,
      input: state.history,
      stream: true,
    });

    for await (const streamEvent of stream) {
      await append({
        type: "openai-stream-event",
        payload: streamEvent as unknown as Record<string, unknown>,
      });
    }

    console.log(`Done offset=${event.offset}`);
  },
});

console.log(`\
Watching ${STREAM_PATH}

Open this in your browser and watch events appear live:
${new URL(`/streams${STREAM_PATH}`, BASE_URL)}

Paste this JSON into the stream page input and submit it:
{
  "type": "user-message",
  "payload": { "content": "Say hello in one short sentence." }
}
`);

await new PullSubscriptionProcessorRuntime({
  eventsClient: createEventsClient(BASE_URL),
  processor: agentProcessor,
  streamPath: STREAM_PATH,
}).run();
