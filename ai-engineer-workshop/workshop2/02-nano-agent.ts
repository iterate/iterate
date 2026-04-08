import OpenAI from "openai";
import { createEventsClient, workshopPathPrefix } from "ai-engineer-workshop";

try {
  const pathPrefix = workshopPathPrefix();
  const client = createEventsClient();
  const openai = new OpenAI();
  const streamPath = `${pathPrefix}/nano-agent`;

  for await (const event of await client.stream({ path: streamPath, live: true })) {
    if (event.type !== "agent-input-added") continue;

    console.log("Sending LLM request", { event });

    const response = await openai.responses.create({
      model: "gpt-5.4",
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
} catch (error: unknown) {
  console.log(error);
  process.exitCode = 1;
}
