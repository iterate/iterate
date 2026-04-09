import { createEventsClient, defineProcessor } from "ai-engineer-workshop";
import OpenAI from "openai";
import type {
  ResponseCompletedEvent,
  ResponseInputItem,
} from "openai/resources/responses/responses.mjs";
const client = createEventsClient();

const openai = new OpenAI();

type AgentState = {
  history: ResponseInputItem[];
  systemPrompt: string;
  model: string;
};

const agentProcessor = defineProcessor<AgentState>(() => {
  return {
    slug: "agent",
    initialState,
  };
});

let eventCount = 0;
for await (const event of await client.stream({
  path: "/jonas/hello-world",
  after: "start",
  before: "end",
})) {
  eventCount++;
  if (event.type === "agent-input-added") {
    history.push(event.payload as ResponseInputItem);
  } else if (event.type === "agent-output-added") {
    history.push(...(event.payload as ResponseCompletedEvent).response.output);
  }
}
console.log("Caught up with history", JSON.stringify(history, null, 2));

for await (const event of await client.stream({
  path: "/jonas/hello-world",
  after: eventCount,
})) {
  console.log("Event appended", JSON.stringify(event, null, 2));
  if (event.type === "agent-input-added") {
    console.log("Making LLM request with history", JSON.stringify(history, null, 2));
    history.push(event.payload as ResponseInputItem);
    const response = await openai.responses.create({
      model,
      instructions: systemPrompt,
      input: history,
      stream: true,
    });
    for await (const item of response) {
      if (item.type === "response.completed") {
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
  if (event.type === "agent-output-added") {
    history.push(...(event.payload as ResponseCompletedEvent).response.output);
  }
}
