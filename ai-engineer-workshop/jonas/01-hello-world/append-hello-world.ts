/**
 * Smallest workshop script example.
 * It appends one event and prints the JSON response from the API.
 *
 * Run with `pnpm workshop run` and select this script.
 * Override `BASE_URL`, `WORKSHOP_PATH_PREFIX`, or `STREAM_PATH` if needed.
 */
import { createEventsClient } from "ai-engineer-workshop";
import { normalizePathPrefix, runWorkshopMain } from "ai-engineer-workshop";

export default async function appendHelloWorld(pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "https://events.iterate.com";
  const streamPath = process.env.STREAM_PATH || `${normalizePathPrefix(pathPrefix)}/hello-world`;

  const client = createEventsClient(baseUrl);

  const result = await client.append({
    path: streamPath,
    event: {
      type: "hello-world",
      payload: { message: "hello world" },
    },
  });

  console.log(JSON.stringify(result, null, 2));
}

runWorkshopMain(import.meta.url, appendHelloWorld);
