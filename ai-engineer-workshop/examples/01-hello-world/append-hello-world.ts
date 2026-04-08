import { createEventsClient, runWorkshopMain } from "ai-engineer-workshop";

export async function run() {
  const client = createEventsClient();
  const streamPath = `${process.env.PATH_PREFIX}/hello-world`;

  const result = await client.append({
    path: streamPath,
    event: { type: "hello-world", payload: { message: "hello world" } },
  });

  console.log(JSON.stringify(result, null, 2));
}

runWorkshopMain(import.meta.url, run);
