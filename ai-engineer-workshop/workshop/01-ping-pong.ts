import { createEventsClient, os, runIfMain } from "ai-engineer-workshop";

export const handler = os.handler(async ({ input }) => {
  const streamPath = `${input.pathPrefix}/00-hello-world`;
  const client = createEventsClient();

  for await (const event of await client.stream({ path: streamPath, live: true }, {})) {
    if (event.type === "ping") {
      await client.append({
        path: streamPath,
        event: { type: "pong" },
      });
    }
  }
});

runIfMain(import.meta.url, handler);
