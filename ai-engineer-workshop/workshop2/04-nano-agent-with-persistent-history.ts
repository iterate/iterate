import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { createEventsClient, type EventInput, workshopPathPrefix } from "ai-engineer-workshop";

type OpenAiOutputItemAddedPayload = {
  item: {
    content: Array<{ type: string; text?: string }>;
  };
};

function updateHistoryFromEvent(history: ResponseInput, event: EventInput) {
  if (event.type === "agent-input-added") {
    history.push({ role: "user", content: (event.payload as { content: string }).content });
  }

  if (event.type === "openai-output-item-added") {
    const item = (event.payload as OpenAiOutputItemAddedPayload).item;
    const content = item.content
      .filter((contentItem) => contentItem.type === "output_text")
      .map((contentItem) => contentItem.text ?? "")
      .join("");

    if (content.length > 0) {
      history.push({ role: "assistant", content });
    }
  }
}

async function main() {
  const pathPrefix = workshopPathPrefix();
  const client = createEventsClient();
  const openai = new OpenAI();
  const streamPath = `${pathPrefix}/nano-agent`;
  const history: ResponseInput = [];
  let lastSeenOffset: number | undefined;

  for await (const event of await client.stream({ path: streamPath }, {})) {
    lastSeenOffset = event.offset;
    updateHistoryFromEvent(history, event);
  }

  console.log(`Watching ${streamPath} with ${history.length} history items`);

  for await (const event of await client.stream(
    { path: streamPath, offset: lastSeenOffset, live: true },
    {},
  )) {
    if (event.offset === lastSeenOffset) continue;
    lastSeenOffset = event.offset;

    updateHistoryFromEvent(history, event);

    if (event.type !== "agent-input-added") continue;

    const response = await openai.responses.create({
      model: "gpt-5.4",
      instructions: "You are a helpful assistant. Keep answers concise.",
      input: history,
    });

    for (const item of response.output ?? []) {
      const jsonItem = JSON.parse(JSON.stringify(item));

      await client.append({
        path: streamPath,
        event: { type: "openai-output-item-added", payload: { item: jsonItem } },
      });
    }
  }
}

main().catch((error: unknown) => {
  console.log(error);
  process.exitCode = 1;
});
