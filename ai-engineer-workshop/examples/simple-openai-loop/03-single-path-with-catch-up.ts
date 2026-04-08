import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { os } from "@orpc/server";
import { createEventsClient } from "ai-engineer-workshop";

export default os.handler(async () => {
  const client = createEventsClient();
  const openai = new OpenAI();
  const streamPath = `${process.env.PATH_PREFIX}/simple-openai-loop-catch-up`;
  const history: ResponseInput = [];
  let lastOffset: number | undefined;

  for await (const event of await client.stream({ path: streamPath }, {})) {
    lastOffset = event.offset;

    if (event.type === "llm-input-added") {
      history.push({ role: "user", content: (event.payload as { content: string }).content });
    }
    if (event.type === "llm-output-added") {
      history.push({ role: "assistant", content: (event.payload as { content: string }).content });
    }
  }

  console.log(`Watching ${streamPath} (caught up ${history.length} messages)`);

  for await (const event of await client.stream(
    { path: streamPath, offset: lastOffset, live: true },
    {},
  )) {
    if (event.offset === lastOffset) continue;
    lastOffset = event.offset;

    if (event.type === "llm-output-added") {
      history.push({ role: "assistant", content: (event.payload as { content: string }).content });
      continue;
    }
    if (event.type !== "llm-input-added") continue;

    const content = (event.payload as { content: string }).content;
    history.push({ role: "user", content });

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions: "You are a helpful assistant. Keep answers concise.",
      input: history,
    });

    await client.append({
      path: streamPath,
      event: { type: "llm-output-added", payload: { content: response.output_text } },
    });
  }
});
