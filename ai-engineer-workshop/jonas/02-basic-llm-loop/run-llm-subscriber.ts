/**
 * Tiny event-driven chat loop using TanStack AI's documented streaming shape:
 * https://github.com/tanstack/ai/blob/main/docs/guides/streaming.md
 * https://github.com/tanstack/ai/blob/main/docs/reference/functions/streamToText.md
 *
 * Run with `pnpm workshop run` and select this script.
 * Override `BASE_URL`, `WORKSHOP_PATH_PREFIX`, `STREAM_PATH`, or `OPENAI_MODEL` if needed.
 */
import { randomBytes } from "node:crypto";
import { chat, streamToText, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { createEventsClient } from "ai-engineer-workshop";

const INPUT_ITEM_ADDED_TYPE = "https://events.iterate.com/agent/input-item-added" as const;
const OUTPUT_ITEM_ADDED_TYPE = "https://events.iterate.com/agent/output-item-added" as const;

export default async function runLlmSubscriber(pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "https://events.iterate.com";
  const streamPath =
    process.env.STREAM_PATH ||
    `${normalizePathPrefix(pathPrefix)}/02/${randomBytes(4).toString("hex")}`;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiModel = (process.env.OPENAI_MODEL || "gpt-4o-mini") as Parameters<
    typeof createOpenaiChat
  >[0];

  if (!openaiApiKey) throw new Error("OPENAI_API_KEY is required");

  const client = createEventsClient(baseUrl);
  const adapter = createOpenaiChat(openaiModel, openaiApiKey);

  printInstructions({ baseUrl, streamPath });

  const { resumeOffset, messages } = await loadConversation({ client, streamPath });
  console.error(
    `[llm-subscriber] loaded messages=${messages.length} resumeOffset=${resumeOffset ?? "<start>"}`,
  );

  const stream = await client.stream(
    {
      path: streamPath,
      offset: resumeOffset,
      live: true,
    },
    {},
  );

  for await (const event of stream) {
    if (event.type !== INPUT_ITEM_ADDED_TYPE) continue;

    const payload = parseInputItemAddedPayload(event.payload);
    if (!payload) {
      console.error(`[llm-subscriber] skipping malformed input offset=${event.offset}`);
      continue;
    }

    const item = payload.item;
    if (item.role !== "user") continue;

    const chunks: StreamChunk[] = [];
    messages.push(item);

    console.error(`[llm-subscriber] input offset=${event.offset}`);

    for await (const chunk of chat({ adapter, messages })) {
      chunks.push(chunk);

      await client.append({
        path: streamPath,
        events: [
          {
            path: streamPath,
            type: OUTPUT_ITEM_ADDED_TYPE,
            payload: JSON.parse(JSON.stringify({ chunk })),
          },
        ],
      });
    }

    const assistant = streamChunksComplete(chunks) ? await streamChunksToText(chunks) : "";
    if (assistant) {
      const assistantItem: ModelMessage<string> = { role: "assistant", content: assistant };
      await client.append({
        path: streamPath,
        events: [
          {
            path: streamPath,
            type: INPUT_ITEM_ADDED_TYPE,
            payload: JSON.parse(JSON.stringify({ item: assistantItem })),
          },
        ],
      });
      messages.push(assistantItem);
    }

    console.error(`[llm-subscriber] done input offset=${event.offset}`);
  }
}

function printInstructions({ baseUrl, streamPath }: { baseUrl: string; streamPath: string }) {
  console.error(`[llm-subscriber] watching ${streamPath}`);
  console.error("");
  console.error("Open this in your browser and watch events appear live:");
  console.error(new URL(`/streams${streamPath}`, baseUrl).toString());
  console.error("");
  console.error("Recommended: append a user event with curl:");
  console.error("");
  console.error(
    [
      `curl -X POST "${new URL(`/api/streams${streamPath}`, baseUrl).toString()}" \\`,
      '  -H "content-type: application/json" \\',
      `  --data '${JSON.stringify(
        {
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
      )}'`,
    ].join("\n"),
  );
  console.error("");
  console.error("Browser alternative: paste this into the stream page input and submit it:");
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
  const messageEvents: Array<{
    eventOffset: string;
    offsetBeforeInput?: string;
    item: ModelMessage<string>;
  }> = [];
  const pendingUserMessageEvents: Array<(typeof messageEvents)[number]> = [];
  let lastOffset: string | undefined;
  let previousOffset: string | undefined;

  for await (const event of await client.stream({ path: streamPath }, {})) {
    lastOffset = event.offset;

    if (event.type === INPUT_ITEM_ADDED_TYPE) {
      const payload = parseInputItemAddedPayload(event.payload);
      if (payload) {
        const messageEvent = {
          eventOffset: event.offset,
          offsetBeforeInput: previousOffset,
          item: payload.item,
        };
        messageEvents.push(messageEvent);

        if (payload.item.role === "user") {
          pendingUserMessageEvents.push(messageEvent);
        } else if (payload.item.role === "assistant") {
          pendingUserMessageEvents.shift();
        }
      }
    }

    previousOffset = event.offset;
  }

  const firstIncompleteUserMessage = pendingUserMessageEvents[0];
  const completedMessageEvents =
    firstIncompleteUserMessage == null
      ? messageEvents
      : messageEvents.slice(0, messageEvents.indexOf(firstIncompleteUserMessage));

  return {
    resumeOffset: firstIncompleteUserMessage
      ? firstIncompleteUserMessage.offsetBeforeInput
      : lastOffset,
    messages: completedMessageEvents.map((messageEvent) => messageEvent.item),
  };
}

async function streamChunksToText(chunks: readonly StreamChunk[]) {
  return streamToText(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  );
}

function streamChunksComplete(chunks: readonly StreamChunk[]) {
  return chunks.some((chunk) => chunk.type === "done");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isAgentMessageRole(value: unknown): value is "user" | "assistant" {
  return value === "user" || value === "assistant";
}

function parseInputItemAddedPayload(payload: unknown): { item: ModelMessage<string> } | null {
  if (!isRecord(payload) || !isRecord(payload.item)) {
    return null;
  }

  const { role, content } = payload.item;
  if (!isAgentMessageRole(role) || typeof content !== "string" || content.length === 0) {
    return null;
  }

  return {
    item: {
      role,
      content,
    },
  };
}

function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}
