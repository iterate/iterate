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

for await (const event of await client.stream({
  path: "/jonas/hello-world",
})) {
  if (event.type === "agent-input-added") {
    console.log("Making LLM request with history", JSON.stringify(history, null, 2));
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
          path: "/jonas/hello-world",
          event: {
            type: "agent-output-added",
            payload: item,
          },
        });
      }
    }
  }
}
