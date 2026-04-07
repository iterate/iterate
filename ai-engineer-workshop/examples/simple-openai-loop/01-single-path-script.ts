import OpenAI from "openai";
import { createEventsClient, runWorkshopMain } from "ai-engineer-workshop";

export async function run() {
  const client = createEventsClient();
  const openai = new OpenAI();
  const streamPath = `${process.env.PATH_PREFIX}/simple-openai-loop`;

  console.log(`Watching ${streamPath}`);

  for await (const event of await client.stream({ path: streamPath, live: true }, {})) {
    if (event.type !== "llm-input-added") continue;

    const content = (event.payload as { content: string }).content;
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions: "You are a helpful assistant. Keep answers concise.",
      input: content,
    });

    await client.append({
      path: streamPath,
      event: { type: "llm-output-added", payload: { content: response.output_text } },
    });
  }
}

runWorkshopMain(import.meta.url, run);
