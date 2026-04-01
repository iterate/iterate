/**
 * TypeScript example that shows both sides of the flow:
 * it starts a live subscription, appends an event, then prints the append result
 * and the matching streamed event that comes back over SSE.
 *
 * Run:
 *   # from ai-engineer-workshop/jonas
 *   pnpm tsx 01-hello-world/subscribe-hello-world.ts
 */
import { createEventsClient } from "../../lib/sdk.ts";

const BASE_URL = process.env.BASE_URL || "https://events.iterate.com";
const STREAM_PATH = process.env.STREAM_PATH || "/jonas/hello-world";

const client = createEventsClient(BASE_URL);
const controller = new AbortController();
const stream = await client.stream(
  {
    path: STREAM_PATH,
    live: true,
  },
  {
    signal: controller.signal,
  },
);
const iterator = stream[Symbol.asyncIterator]();

const appendResult = await client.append({
  path: STREAM_PATH,
  type: "hello-world",
  payload: {
    message: `hello world ${new Date().toISOString()}`,
  },
});

console.log("append result");
console.log(JSON.stringify(appendResult, null, 2));

const appendedEvent = appendResult.event;

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
