/**
 * Workshop script that shows both sides of the flow:
 * it starts a live subscription, appends an event, then prints the append result
 * and the matching streamed event that comes back over SSE.
 *
 * Run with `pnpm workshop run` and select this script.
 * Override `BASE_URL`, `WORKSHOP_PATH_PREFIX`, or `STREAM_PATH` if needed.
 */
import { createEventsClient } from "ai-engineer-workshop";

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
    path: streamPath,
    events: [
      {
        path: streamPath,
        type: "hello-world",
        payload: {
          message: `hello world ${new Date().toISOString()}`,
        },
      },
    ],
  });

  console.log("append result");
  console.log(JSON.stringify(appendResult, null, 2));

  const appendedEvent = appendResult.events[0];
  if (!appendedEvent) {
    throw new Error("append returned no events");
  }

  let streamed = await iterator.next();
  while (!streamed.done && streamed.value.offset !== appendedEvent.offset) {
    streamed = await iterator.next();
  }

  controller.abort();
  await iterator.return?.();

  if (streamed.done) {
    throw new Error("stream closed before an event arrived");
  }

  console.log("stream event");
  console.log(JSON.stringify(streamed.value, null, 2));
}

function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}
