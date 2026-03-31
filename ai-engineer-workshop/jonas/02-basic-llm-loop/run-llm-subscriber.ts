/**
 * Tiny event-driven chat loop using TanStack AI's documented streaming shape:
 * https://github.com/tanstack/ai/blob/main/docs/guides/streaming.md
 * https://github.com/tanstack/ai/blob/main/docs/reference/functions/streamToText.md
 *
 * Run with cwd `ai-engineer-workshop/jonas` (not the monorepo root — that is fine; repo `doppler.yaml`
 * still maps this folder to the `ai-engineer-workshop` Doppler project):
 *
 *   doppler run --project ai-engineer-workshop --config dev_jonas -- pnpm tsx 02-basic-llm-loop/run-llm-subscriber.ts
 */
import { randomBytes } from "node:crypto";
import { chat, streamToText, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { createEventsClient } from "../../lib/sdk.ts";

const BASE_URL = process.env.BASE_URL || "https://events.iterate.com";
const STREAM_PATH = process.env.STREAM_PATH || `/jonas/02/${randomBytes(4).toString("hex")}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini") as Parameters<
  typeof createOpenaiChat
>[0];

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const INPUT_ITEM_ADDED_TYPE = "https://events.iterate.com/agent/input-item-added" as const;
const OUTPUT_ITEM_ADDED_TYPE = "https://events.iterate.com/agent/output-item-added" as const;

const client = createEventsClient(BASE_URL);
const adapter = createOpenaiChat(OPENAI_MODEL, OPENAI_API_KEY);

printInstructions({ baseUrl: BASE_URL, streamPath: STREAM_PATH });

const { lastOffset, messages } = await loadConversation({ client, streamPath: STREAM_PATH });
const stream = await client.stream(
  {
    path: STREAM_PATH,
    offset: lastOffset,
    live: true,
  },
  {},
);

for await (const event of stream) {
  if (event.type !== INPUT_ITEM_ADDED_TYPE) continue;

  const item = (event.payload as unknown as { item: ModelMessage<string> }).item;
  const chunks: StreamChunk[] = [];
  messages.push(item);

  console.error(`[llm-subscriber] input offset=${event.offset}`);

  for await (const chunk of chat({ adapter, messages })) {
    chunks.push(chunk);

    await client.append({
      path: STREAM_PATH,
      events: [
        {
          path: STREAM_PATH,
          type: OUTPUT_ITEM_ADDED_TYPE,
          payload: JSON.parse(JSON.stringify({ sourceOffset: event.offset, chunk })),
        },
      ],
    });
  }

  const assistant = await streamChunksToText(chunks);
  if (assistant) messages.push({ role: "assistant", content: assistant });

  console.error(`[llm-subscriber] done sourceOffset=${event.offset}`);
}

function printInstructions({ baseUrl, streamPath }: { baseUrl: string; streamPath: string }) {
  console.error(`[llm-subscriber] watching ${streamPath}`);
  console.error("");
  console.error("Open this in your browser and watch events appear live:");
  console.error(new URL(`/streams${streamPath}`, baseUrl).toString());
  console.error("");
  console.error(
    "Keep posting more user messages into that same stream to continue the conversation.",
  );
  console.error("");
  console.error("Paste this JSON into the stream page input and submit it:");
  console.error(
    JSON.stringify(
      {
        path: streamPath,
        type: INPUT_ITEM_ADDED_TYPE,
        payload: {
          item: {
            role: "user",
            content: "Say hello in one short sentence.",
          },
        },
      },
      null,
      2,
    ),
  );
  console.error("");
}

async function loadConversation({
  client,
  streamPath,
}: {
  client: ReturnType<typeof createEventsClient>;
  streamPath: string;
}) {
  const inputs: Array<{ offset: string; item: ModelMessage<string> }> = [];
  const chunksByOffset = new Map<string, StreamChunk[]>();
  let lastOffset: string | undefined;

  for await (const event of await client.stream({ path: streamPath }, {})) {
    lastOffset = event.offset;

    if (event.type === INPUT_ITEM_ADDED_TYPE) {
      inputs.push({
        offset: event.offset,
        item: (event.payload as unknown as { item: ModelMessage<string> }).item,
      });
    }

    if (event.type === OUTPUT_ITEM_ADDED_TYPE) {
      const { sourceOffset, chunk } = event.payload as unknown as {
        sourceOffset: string;
        chunk: StreamChunk;
      };
      const chunks = chunksByOffset.get(sourceOffset) || [];
      chunks.push(chunk);
      chunksByOffset.set(sourceOffset, chunks);
    }
  }

  const messages: ModelMessage<string>[] = [];

  for (const input of inputs) {
    messages.push(input.item);
    const assistant = await streamChunksToText(chunksByOffset.get(input.offset) || []);
    if (assistant) messages.push({ role: "assistant", content: assistant });
  }

  return { lastOffset, messages };
}

async function streamChunksToText(chunks: readonly StreamChunk[]) {
  return streamToText(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  );
}
