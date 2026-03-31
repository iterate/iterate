/**
 * Live-subscribes to a stream. On each `input-item-added` event, runs TanStack AI
 * and appends one `output-item-added` event per streamed chunk (raw AG-UI chunks).
 *
 * Requires OPENAI_API_KEY (e.g. via Doppler).
 *
 * Run:
 *   doppler run --project ai-engineer-workshop --config dev_jonas -- node 02-basic-llm-loop/run-llm-subscriber.ts
 */
import { chat } from "@tanstack/ai";
import { createOpenaiChat, OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
import { createEventsClient } from "../../lib/sdk.ts";
import {
  isInputItemAddedType,
  OUTPUT_ITEM_ADDED_TYPE,
  type InputItemAddedPayload,
  type OutputItemAddedPayload,
} from "./event-types.ts";
import { toJSONObject } from "./json-object.ts";

const BASE_URL = process.env.BASE_URL || "https://events.iterate.com";
const STREAM_PATH = process.env.STREAM_PATH || "/jonas/basic-llm-loop";

type OpenAIModel = (typeof OPENAI_CHAT_MODELS)[number];

function resolveOpenAIModel(): OpenAIModel {
  const raw = process.env.OPENAI_MODEL;
  if (raw && (OPENAI_CHAT_MODELS as readonly string[]).includes(raw)) {
    return raw as OpenAIModel;
  }
  return "gpt-4o-mini";
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error(
    "OPENAI_API_KEY is required (e.g. doppler run --project ai-engineer-workshop ...)",
  );
}

const client = createEventsClient(BASE_URL);
const textAdapter = createOpenaiChat(resolveOpenAIModel(), apiKey);

const processedInputOffsets = new Set<string>();

async function handleInputEvent(sourceOffset: string, payload: unknown) {
  const input = payload as InputItemAddedPayload;
  const content = input?.item?.content;
  if (typeof content !== "string" || content.length === 0) {
    console.error("input-item-added missing item.content", sourceOffset);
    return;
  }

  const stream = chat({
    adapter: textAdapter,
    messages: [{ role: "user", content }],
    maxTokens: 64,
  });

  for await (const chunk of stream) {
    const out: OutputItemAddedPayload = {
      sourceOffset,
      chunk: toJSONObject(chunk),
    };
    await client.append({
      path: STREAM_PATH,
      events: [
        {
          path: STREAM_PATH,
          type: OUTPUT_ITEM_ADDED_TYPE,
          payload: toJSONObject(out),
        },
      ],
    });
  }
  console.error(`[llm-subscriber] done sourceOffset=${sourceOffset}`);
}

const liveStream = await client.stream(
  {
    path: STREAM_PATH,
    live: true,
  },
  {},
);

for await (const event of liveStream) {
  if (!isInputItemAddedType(event.type)) {
    continue;
  }
  if (processedInputOffsets.has(event.offset)) {
    continue;
  }
  processedInputOffsets.add(event.offset);

  console.error(`[llm-subscriber] input offset=${event.offset}`);
  try {
    await handleInputEvent(event.offset, event.payload);
  } catch (error) {
    console.error("[llm-subscriber] run failed", error);
    const errOut: OutputItemAddedPayload = {
      sourceOffset: event.offset,
      chunk: {
        type: "RUN_ERROR",
        error: error instanceof Error ? error.message : String(error),
      },
    };
    await client.append({
      path: STREAM_PATH,
      events: [
        {
          path: STREAM_PATH,
          type: OUTPUT_ITEM_ADDED_TYPE,
          payload: toJSONObject(errOut),
        },
      ],
    });
  }
}
