import { createEventsClient, runWorkshopMain } from "ai-engineer-workshop";

export async function run() {
  const streamPath = `${process.env.PATH_PREFIX}/00-workshop-harness`;
  const client = createEventsClient();

  const result = await client.append({
    path: streamPath,
    event: { type: "hello world" },
  });

  console.log(JSON.stringify(result, null, 2));
}

runWorkshopMain(import.meta.url, run);
