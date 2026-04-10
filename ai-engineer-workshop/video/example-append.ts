import { createEventsClient } from "ai-engineer-workshop";

const client = createEventsClient();

const result = await client.append({
  path: "/jonas/hello-world",
  event: {
    type: "agent-input-added",
    payload: {
      role: "user",
      content: "Hello, world!",
    },
  },
});

console.log(JSON.stringify(result, null, 2));
