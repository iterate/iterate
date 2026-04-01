/**
 * Tiny event-driven chat loop expressed as a stream processor.
 *
 * Uses TanStack AI's `chat()` to stream chunks and accumulates the assistant
 * response directly — no StreamProcessor needed for this text-only case.
 *
 * Run with `pnpm workshop run` and select this script.
 * Override `BASE_URL`, `WORKSHOP_PATH_PREFIX`, `STREAM_PATH`, or `OPENAI_MODEL` if needed.
 */
import { randomBytes } from "node:crypto";
import { chat, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { openaiText, OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
import { z } from "zod";
import {
  createEventsClient,
  defineProcessor,
  type JSONObject,
  PullSubscriptionProcessorRuntime,
} from "ai-engineer-workshop";

type TextModelMessage = ModelMessage<string | null>;

type AgentState = {
  conversationHistory: TextModelMessage[];
  llmRequestInProgress: boolean;
};

const AgentEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tanstack-ai-message-added"),
    payload: z.custom<TextModelMessage>(),
  }),
  z.object({
    type: z.literal("tanstack-ai-chunk-added"),
    payload: z.custom<StreamChunk>(),
  }),
]);

const OPENAI_MODEL = z.enum(OPENAI_CHAT_MODELS).parse(process.env.OPENAI_MODEL ?? "gpt-4o-mini");

const tanstackAi = openaiText(OPENAI_MODEL);

const agentProcessor = defineProcessor<AgentState>({
  initialState: {
    conversationHistory: [],
    llmRequestInProgress: false,
  },
  reduce: (state, event) => {
    const { success, data: tanstackAiEvent } = AgentEvent.safeParse(event);

    if (!success) {
      console.log(`Ignoring event of type ${event.type}`);
      return state;
    }

    switch (tanstackAiEvent.type) {
      case "tanstack-ai-message-added":
        return {
          conversationHistory: [...state.conversationHistory, tanstackAiEvent.payload],
          llmRequestInProgress: tanstackAiEvent.payload.role === "user",
        };
    }
  },

  onEvent: async ({ append, event, state, prevState }) => {
    const { success, data: tanstackAiEvent } = AgentEvent.safeParse(event);

    if (!success || tanstackAiEvent.type !== "tanstack-ai-message-added") {
      return;
    }

    if (tanstackAiEvent.payload.role !== "user" || prevState.llmRequestInProgress) {
      return;
    }

    console.log(
      `Input offset=${event.offset} previousInProgress=${prevState.llmRequestInProgress}`,
    );

    const chunkStream = chat({
      adapter: tanstackAi,
      messages: state.conversationHistory,
    });

    // Each "content" chunk carries the full accumulated text so far (not just
    // the delta), so the last content chunk contains the complete response.
    let assistantContent = "";

    for await (const chunk of chunkStream) {
      await append({ type: "tanstack-ai-chunk-added", payload: toJsonObject(chunk) });

      if (chunk.type === "content") {
        assistantContent = chunk.content;
      }
    }

    if (assistantContent) {
      await append({
        type: "tanstack-ai-message-added",
        payload: { role: "assistant", content: assistantContent },
      });
    }

    console.log(`Done offset=${event.offset}`);
  },
});

export default async function tanstackAiProcessor(pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "https://events.iterate.com";
  const streamPath =
    process.env.STREAM_PATH ||
    `${normalizePathPrefix(pathPrefix)}/03/${randomBytes(4).toString("hex")}`;

  console.log(`\
Watching ${streamPath}

Open this in your browser and watch events appear live:
${new URL(`/streams${streamPath}`, baseUrl)}

Paste this JSON into the stream page input and submit it:
{
  "type": "tanstack-ai-message-added",
  "payload": { "role": "user", "content": "Say hello in one short sentence." }
}
`);

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createEventsClient(baseUrl),
    processor: agentProcessor,
    streamPath,
  }).run();
}

function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}

function toJsonObject(value: unknown): JSONObject {
  const json = JSON.parse(JSON.stringify(value));
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Expected a JSON object payload");
  }
  return json as JSONObject;
}
