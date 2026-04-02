import { createEventsClient, normalizePathPrefix, runWorkshopMain } from "./sdk.ts";

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
