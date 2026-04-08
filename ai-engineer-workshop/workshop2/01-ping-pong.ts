import { createEventsClient, workshopPathPrefix } from "ai-engineer-workshop";

async function main() {
  const pathPrefix = workshopPathPrefix();
  const streamPath = `${pathPrefix}/00-hello-world`;
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

main().catch((error: unknown) => {
  console.log(error);
  process.exitCode = 1;
});
