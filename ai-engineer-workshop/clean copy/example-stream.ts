import { createEventsClient } from "ai-engineer-workshop";

const client = createEventsClient();

for await (const event of await client.stream({
  path: "/jonas/hello-world",
})) {
  console.log(JSON.stringify(event, null, 2));
}
