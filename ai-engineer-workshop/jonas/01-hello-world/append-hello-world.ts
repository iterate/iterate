/**
 * Smallest workshop script example.
 * It appends one event and prints the JSON response from the API.
 *
 * Run with `pnpm workshop run` and select this script.
 * Override `BASE_URL`, `WORKSHOP_PATH_PREFIX`, or `STREAM_PATH` if needed.
 */
import { createEventsClient } from "ai-engineer-workshop";

export default async function appendHelloWorld(pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "https://events.iterate.com";
  const streamPath = process.env.STREAM_PATH || `${normalizePathPrefix(pathPrefix)}/hello-world`;

  const client = createEventsClient(baseUrl);

  const result = await client.append({
    path: streamPath,
    events: [
      {
        path: streamPath,
        type: "hello-world",
        payload: { message: "hello world" },
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));
}

function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}
