/**
 * Minimal agent loop using the native OpenAI Responses API in streaming mode.
 *
 * Every SSE event from OpenAI is forwarded into the iterate event stream as-is,
 * so you can watch the full lifecycle in the browser: response.created, text
 * deltas, output_item.done, response.completed.
 *
 * Run with `pnpm workshop run` and select this script.
 * Override `BASE_URL`, `WORKSHOP_PATH_PREFIX`, or `STREAM_PATH` if needed.
 */
import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import type { ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses";
import { z } from "zod";
import {
  createEventsClient,
  defineProcessor,
  normalizePathPrefix,
  type JSONObject,
  PullSubscriptionProcessorRuntime,
  runWorkshopMain,
} from "ai-engineer-workshop";

type AgentState = {
  history: ResponseInput;
  requestInProgress: boolean;
};

const UserMessagePayload = z.object({
  content: z.string().min(1),
});

export default async function openAiAgentProcessor(pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "https://events.iterate.com";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const streamPath =
    process.env.STREAM_PATH ||
    `${normalizePathPrefix(pathPrefix)}/05/${randomBytes(4).toString("hex")}`;

  console.log(`\
Watching ${streamPath}

Open this in your browser and watch events appear live:
${new URL(`/streams${streamPath}`, baseUrl)}

Paste this JSON into the stream page input and submit it:
{
  "type": "user-message",
  "payload": { "content": "Say hello in one short sentence." }
}
`);

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createEventsClient(baseUrl),
    processor: createAgentProcessor({
      model,
      openai: new OpenAI(),
    }),
    streamPath,
  }).run();
}

function toJsonObject(value: unknown): JSONObject {
  const json = JSON.parse(JSON.stringify(value));
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Expected a JSON object payload");
  }
  return json as JSONObject;
}

function createAgentProcessor({ model, openai }: { model: string; openai: OpenAI }) {
  return defineProcessor<AgentState>({
    initialState: {
      history: [],
      requestInProgress: false,
    },

    reduce: (state, event) => {
      if (event.type === "user-message") {
        const payload = UserMessagePayload.safeParse(event.payload);
        if (!payload.success) {
          return state;
        }

        const history: ResponseInput = [
          ...state.history,
          { role: "user" as const, content: payload.data.content },
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
        model,
        input: state.history,
        stream: true,
      });

      for await (const streamEvent of stream) {
        await append({ type: "openai-stream-event", payload: toJsonObject(streamEvent) });
      }

      console.log(`Done offset=${event.offset}`);
    },
  });
}

runWorkshopMain(import.meta.url, openAiAgentProcessor);
