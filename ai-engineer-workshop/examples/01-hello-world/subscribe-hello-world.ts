import { createEventsClient, runWorkshopMain } from "ai-engineer-workshop";

export async function run() {
  const client = createEventsClient();
  const streamPath = `${process.env.PATH_PREFIX}/hello-world`;

  const controller = new AbortController();
  const stream = await client.stream(
    { path: streamPath, live: true },
    { signal: controller.signal },
  );
  const iterator = stream[Symbol.asyncIterator]();

  const appendResult = await client.append({
    path: streamPath,
    event: { type: "hello-world", payload: { message: `hello world ${new Date().toISOString()}` } },
  });

  let streamed = await iterator.next();
  while (!streamed.done && streamed.value.offset !== appendResult.event.offset) {
    streamed = await iterator.next();
  }

  controller.abort();
  await iterator.return?.();

  if (streamed.done) throw new Error("stream closed before an event arrived");

  console.log("append result");
  console.log(JSON.stringify(appendResult, null, 2));
  console.log("stream event");
  console.log(JSON.stringify(streamed.value, null, 2));
}

runWorkshopMain(import.meta.url, run);
