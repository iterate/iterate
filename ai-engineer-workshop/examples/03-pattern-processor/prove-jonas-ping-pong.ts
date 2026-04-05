import assert from "node:assert/strict";
import {
  createEventsClient,
  type Event,
  type StreamPath,
  runWorkshopMain,
} from "ai-engineer-workshop";
import { createJonasPingPongRuntime, jonasStreamPattern } from "./jonas-ping-pong-processor.ts";

export default async function proveJonasPingPong(_pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "http://127.0.0.1:4317";
  const client = createEventsClient(baseUrl);
  const runId = `proof-${Date.now()}`;
  const matchingPath = `/jonas/proofs/${runId}` as StreamPath;
  const nonMatchingPath = `/someone-else/proofs/${runId}` as StreamPath;

  const runtime = createJonasPingPongRuntime(baseUrl);
  const runtimePromise = runtime.run();

  try {
    await client.append({
      path: matchingPath,
      event: {
        type: "warmup",
        payload: { scope: "matching" },
      },
    });
    await client.append({
      path: nonMatchingPath,
      event: {
        type: "warmup",
        payload: { scope: "non-matching" },
      },
    });

    await waitFor(
      () => runtime.getStreamPaths().includes(matchingPath),
      `Expected ${matchingPath} to be discovered`,
    );

    assert.equal(runtime.getStreamPaths().includes(nonMatchingPath), false);

    const matchingPing = await client.append({
      path: matchingPath,
      event: {
        type: "ping",
        payload: { scope: "matching" },
      },
    });
    const nonMatchingPing = await client.append({
      path: nonMatchingPath,
      event: {
        type: "ping",
        payload: { scope: "non-matching" },
      },
    });

    const matchingPong = await waitForPong({
      client,
      path: matchingPath,
      replyToOffset: matchingPing.event.offset,
    });

    const nonMatchingEvents = await readHistory({
      client,
      path: nonMatchingPath,
      afterOffset: nonMatchingPing.event.offset,
    });

    assert.equal(
      nonMatchingEvents.some(
        (event) =>
          event.type === "pong" && getReplyToOffset(event) === nonMatchingPing.event.offset,
      ),
      false,
    );

    console.log(`Base URL: ${baseUrl}`);
    console.log(`Pattern: ${jonasStreamPattern}`);
    console.log(`Matching stream: ${matchingPath}`);
    console.log(`Non-matching stream: ${nonMatchingPath}`);
    console.log("matching pong");
    console.log(JSON.stringify(matchingPong, null, 2));
    console.log("proof passed");
  } finally {
    runtime.stop();
    await runtimePromise;
  }
}

async function waitForPong(args: {
  client: ReturnType<typeof createEventsClient>;
  path: StreamPath;
  replyToOffset: number;
}) {
  let pong: Event | undefined;

  await waitFor(async () => {
    const events = await readHistory({
      client: args.client,
      path: args.path,
      afterOffset: args.replyToOffset,
    });

    pong = events.find(
      (event) => event.type === "pong" && getReplyToOffset(event) === args.replyToOffset,
    );

    return pong != null;
  }, `Expected pong on ${args.path} for ping offset ${args.replyToOffset}`);

  return pong!;
}

async function readHistory(args: {
  client: ReturnType<typeof createEventsClient>;
  path: StreamPath;
  afterOffset: number;
}) {
  const stream = await args.client.stream(
    {
      path: args.path,
      offset: args.afterOffset,
    },
    {},
  );

  const events: Event[] = [];
  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

function getReplyToOffset(event: Event) {
  if (typeof event.payload !== "object" || event.payload == null || Array.isArray(event.payload)) {
    return undefined;
  }

  const value = (event.payload as Record<string, unknown>).replyToOffset;
  return typeof value === "number" ? value : undefined;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 10_000,
) {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(message);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

runWorkshopMain(import.meta.url, proveJonasPingPong);
