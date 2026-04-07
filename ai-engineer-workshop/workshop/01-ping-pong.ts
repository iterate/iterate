import { createEventsClient, runWorkshopMain } from "ai-engineer-workshop";

export async function run() {
  const streamPath = `${process.env.PATH_PREFIX}/00-hello-world`;
  const client = createEventsClient();

  for await (const event of await client.stream({ path: streamPath, live: true }, {})) {
    if (event.type === "ping") {
      await client.append({
        path: streamPath,
        event: { type: "pong" },
      });
    }
  }
}

runWorkshopMain(import.meta.url, run);
