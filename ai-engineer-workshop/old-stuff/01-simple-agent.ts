import { createEventsClient } from "ai-engineer-workshop";

const client = createEventsClient();

await client.append({
  path: "/jonastemplestein/hello-world",
  event: {
    type: "agent-input-added",
    payload: {
      role: "user",
      content: "Hello, world!",
    },
  },
});

for await (const event of await client.stream({
  path: "/jonastemplestein/hello-world",
})) {
  console.log(JSON.stringify(event, null, 2));
}
