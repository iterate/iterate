import { createEventsClient } from "ai-engineer-workshop";
import OpenAI from "openai";
import type {
  ResponseCompletedEvent,
  ResponseInputItem,
} from "openai/resources/responses/responses.mjs";
const client = createEventsClient();

const openai = new OpenAI();

const history: ResponseInputItem[] = [];
const systemPrompt = "You are a helpful assistant. Keep answers concise.";
const model = "gpt-4o-mini";

let eventCount = 0;
for await (const event of await client.stream({
  path: "/jonastemplestein/hello-world2",
  live: false,
})) {
  eventCount++;
  if (event.type === "agent-input-added") {
    history.push(event.payload as ResponseInputItem);
  } else if (event.type === "agent-output-added") {
    history.push(...(event.payload as ResponseCompletedEvent).response.output);
  }
}

for await (const event of await client.stream({
  path: "/jonastemplestein/hello-world2",
  offset: eventCount,
  live: true,
})) {
  if (event.type === "agent-input-added") {
    const response = await openai.responses.create({
      model,
      instructions: systemPrompt,
      input: history,
      stream: true,
    });
    for await (const item of response) {
      if (item.type === "response.completed") {
        history.push(...item.response.output);
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
