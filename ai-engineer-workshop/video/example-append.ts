import { createEventsClient } from "ai-engineer-workshop";

const client = createEventsClient();

const result = await client.append({
  // streams are structured into paths, just like files!
  path: "/video/hello-world",
  event: {
    type: "agent-input-added",
    payload: {
      role: "user",
      content: "Tell a joke mate",
    },
  },
});

console.log(JSON.stringify(result, null, 2));

// 1. Agent harnesses are just stream processors for durable streams

// 2. It might be fun or useful to run your harness plugins "across the network"

// What will we be looking at?
// 1) The events.iterate.com UI
// 2) We'll write code in this file here
