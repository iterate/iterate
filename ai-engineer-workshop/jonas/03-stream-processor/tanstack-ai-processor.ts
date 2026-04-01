/**
 * Tiny event-driven chat loop expressed as a stream processor.
 *
 * Uses TanStack AI's `chat()` to stream chunks and accumulates the assistant
 * response directly — no StreamProcessor needed for this text-only case.
 *
 * Run with cwd `ai-engineer-workshop/jonas`:
 *
 *   doppler run --project ai-engineer-workshop --config dev_jonas -- pnpm tsx 03-stream-processor/tanstack-ai-processor.ts
 */
import { randomBytes } from "node:crypto";
import { chat, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { openaiText, OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
import { z } from "zod";
import { createEventsClient } from "../../lib/sdk.ts";
import { PullSubscriptionProcessorRuntime } from "../../lib/pull-subscription-processor-runtime.ts";
import { defineProcessor } from "../../lib/stream-process.ts";

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

const BASE_URL = process.env.BASE_URL || "https://events.iterate.com";
const STREAM_PATH = process.env.STREAM_PATH || `/jonas/03/${randomBytes(4).toString("hex")}`;
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
      await append({ type: "tanstack-ai-chunk-added", payload: chunk });

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

console.log(`\
Watching ${STREAM_PATH}

Open this in your browser and watch events appear live:
${new URL(`/streams${STREAM_PATH}`, BASE_URL)}

Paste this JSON into the stream page input and submit it:
{
  "type": "tanstack-ai-message-added",
  "payload": { "role": "user", "content": "Say hello in one short sentence." },
}
`);

await new PullSubscriptionProcessorRuntime({
  eventsClient: createEventsClient(BASE_URL),
  processor: agentProcessor,
  streamPath: STREAM_PATH,
}).run();
