import { createEventsClient } from "ai-engineer-workshop";
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses.mjs";
const client = createEventsClient();

const openai = new OpenAI();

for await (const event of await client.stream({
  path: "/jonastemplestein/hello-world2",
  live: true,
})) {
  if (event.type === "agent-input-added") {
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      instructions: "You are a helpful assistant. Keep answers concise.",
      input: [event.payload as ResponseInputItem],
      stream: true,
    });
    for await (const item of response) {
      if (item.type === "response.completed") {
        await client.append({
          path: "/jonastemplestein/hello-world2",
          event: {
            type: "agent-output-added",
            payload: item,
          },
        });
      }
    }
  }
}

// if (import.meta.main) {
//   console.log("running as the entry script");
// }
