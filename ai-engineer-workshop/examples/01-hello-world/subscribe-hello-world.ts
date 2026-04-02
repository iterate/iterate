import { createEventsClient, normalizePathPrefix, runWorkshopMain } from "ai-engineer-workshop";

export default async function subscribeHelloWorld(pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "https://events.iterate.com";
  const streamPath = process.env.STREAM_PATH || `${normalizePathPrefix(pathPrefix)}/hello-world`;
  const client = createEventsClient(baseUrl);
  const controller = new AbortController();
  const stream = await client.stream(
    {
      path: streamPath,
      live: true,
    },
    {
      signal: controller.signal,
    },
  );
  const iterator = stream[Symbol.asyncIterator]();

  const appendResult = await client.append({
    params: { path: streamPath },
    body: {
      type: "hello-world",
      payload: {
        message: `hello world ${new Date().toISOString()}`,
      },
    },
  });

  let streamed = await iterator.next();
  while (!streamed.done && streamed.value.offset !== appendResult.event.offset) {
    streamed = await iterator.next();
  }

  controller.abort();
  await iterator.return?.();

  if (streamed.done) {
    throw new Error("stream closed before an event arrived");
  }

  console.log("append result");
  console.log(JSON.stringify(appendResult, null, 2));
  console.log("stream event");
  console.log(JSON.stringify(streamed.value, null, 2));
}

runWorkshopMain(import.meta.url, subscribeHelloWorld);
