/**
 * Smallest TypeScript example in this exercise.
 * It appends one event and prints the JSON response from the API.
 * Override `BASE_URL` and `STREAM_PATH` to point at another deployment or a local server.
 *
 * Run:
 *   # from ai-engineer-workshop/jonas
 *   pnpm tsx 01-hello-world/append-hello-world.ts
 */
import { createEventsClient } from "../../lib/sdk.ts";

const BASE_URL = process.env.BASE_URL || "https://events.iterate.com";
const STREAM_PATH = process.env.STREAM_PATH || "/jonas/hello-world";

const client = createEventsClient(BASE_URL);

const result = await client.append({
  path: STREAM_PATH,
  type: "hello-world",
  payload: { message: "hello world" },
});

console.log(JSON.stringify(result, null, 2));
