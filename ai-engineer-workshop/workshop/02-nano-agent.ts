import OpenAI from "openai";
import { createEventsClient, os, runIfMain } from "ai-engineer-workshop";

export const handler = os.handler(async ({ input }) => {
  const client = createEventsClient();
  const openai = new OpenAI();
  const streamPath = `${input.pathPrefix}/nano-agent`;

  for await (const event of await client.stream({ path: streamPath, live: true })) {
    if (event.type !== "agent-input-added") continue;

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions: "You are a helpful assistant. Keep answers concise.",
      input: (event.payload as { content: string }).content,
    });

    for (const item of response.output ?? []) {
      const jsonItem = JSON.parse(JSON.stringify(item));

      await client.append({
        path: streamPath,
        event: { type: "openai-output-item-added", payload: { item: jsonItem } },
      });
    }
  }
});

runIfMain(import.meta.url, handler);
