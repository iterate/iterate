import { createEventsClient, workshopPathPrefix } from "ai-engineer-workshop";

const pathPrefix = workshopPathPrefix();
const streamPath = `${pathPrefix}/00-workshop-harness`;
const client = createEventsClient();

const result = await client.append({
  path: streamPath,
  event: { type: "hello-world" },
});

console.log(JSON.stringify(result, null, 2));
