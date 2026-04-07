import assert from "node:assert/strict";
import {
  createEventsClient,
  PullSubscriptionPatternProcessorRuntime,
  type Event,
  type StreamPath,
  runWorkshopMain,
} from "ai-engineer-workshop";
import processor from "./jonas-ping-pong-processor.ts";

const jonasStreamPattern = "/jonas/**/*";

export async function run() {
  const client = createEventsClient({ baseUrl: process.env.BASE_URL || "http://127.0.0.1:4317" });
  const runId = `proof-${Date.now()}`;
  const matchingPathA = `/jonas/proofs/${runId}/a` as StreamPath;
  const matchingPathB = `/jonas/proofs/${runId}/b` as StreamPath;
  const matchingNestedPath = `/jonas/proofs/${runId}/nested/c` as StreamPath;
  const nonMatchingPathA = `/someone-else/proofs/${runId}/a` as StreamPath;
  const nonMatchingPathB = `/other/proofs/${runId}/b` as StreamPath;

  const runtime = new PullSubscriptionPatternProcessorRuntime({
    eventsClient: client,
    streamPattern: jonasStreamPattern,
    processor,
  });
  const runtimePromise = runtime.run();

  try {
    await client.append({
      path: matchingPathA,
      event: {
        type: "warmup",
        payload: { scope: "matching-a" },
      },
    });
    await client.append({
      path: nonMatchingPathA,
      event: {
        type: "warmup",
        payload: { scope: "non-matching-a" },
      },
    });

    await waitFor(
      () => runtime.getStreamPaths().includes(matchingPathA),
      `Expected ${matchingPathA} to be discovered`,
    );

    assert.equal(runtime.getStreamPaths().includes(nonMatchingPathA), false);

    await client.append({
      path: matchingPathB,
      event: {
        type: "warmup",
        payload: { scope: "matching-b" },
      },
    });
    await client.append({
      path: nonMatchingPathB,
      event: {
        type: "warmup",
        payload: { scope: "non-matching-b" },
      },
    });

    await waitFor(
      () => runtime.getStreamPaths().includes(matchingPathB),
      `Expected ${matchingPathB} to be discovered`,
    );

    assert.equal(runtime.getStreamPaths().includes(nonMatchingPathB), false);

    await client.append({
      path: matchingNestedPath,
      event: {
        type: "warmup",
        payload: { scope: "matching-nested" },
      },
    });

    await waitFor(
      () => runtime.getStreamPaths().includes(matchingNestedPath),
      `Expected ${matchingNestedPath} to be discovered`,
    );

    const matchingPingA = await client.append({
      path: matchingPathA,
      event: {
        type: "ping",
        payload: { scope: "matching-a" },
      },
    });
    const matchingPingB = await client.append({
      path: matchingPathB,
      event: {
        type: "ping",
        payload: { scope: "matching-b" },
      },
    });
    const matchingNestedPing = await client.append({
      path: matchingNestedPath,
      event: {
        type: "ping",
        payload: { scope: "matching-nested" },
      },
    });
    const nonMatchingPingA = await client.append({
      path: nonMatchingPathA,
      event: {
        type: "ping",
        payload: { scope: "non-matching-a" },
      },
    });
    const nonMatchingPingB = await client.append({
      path: nonMatchingPathB,
      event: {
        type: "ping",
        payload: { scope: "non-matching-b" },
      },
    });

    const matchingPongA = await waitForPong({
      client,
      path: matchingPathA,
      replyToOffset: matchingPingA.event.offset,
    });
    const matchingPongB = await waitForPong({
      client,
      path: matchingPathB,
      replyToOffset: matchingPingB.event.offset,
    });
    const matchingNestedPong = await waitForPong({
      client,
      path: matchingNestedPath,
      replyToOffset: matchingNestedPing.event.offset,
    });

    const nonMatchingEventsA = await readHistory({
      client,
      path: nonMatchingPathA,
      afterOffset: nonMatchingPingA.event.offset,
    });
    const nonMatchingEventsB = await readHistory({
      client,
      path: nonMatchingPathB,
      afterOffset: nonMatchingPingB.event.offset,
    });

    assert.equal(
      nonMatchingEventsA.some(
        (event) =>
          event.type === "pong" && getReplyToOffset(event) === nonMatchingPingA.event.offset,
      ),
      false,
    );
    assert.equal(
      nonMatchingEventsB.some(
        (event) =>
          event.type === "pong" && getReplyToOffset(event) === nonMatchingPingB.event.offset,
      ),
      false,
    );

    console.log(`Base URL: ${process.env.BASE_URL || "http://127.0.0.1:4317"}`);
    console.log(`Pattern: ${jonasStreamPattern}`);
    console.log(
      `Discovered matching streams: ${[matchingPathA, matchingPathB, matchingNestedPath].join(
        ", ",
      )}`,
    );
    console.log(`Ignored non-matching streams: ${[nonMatchingPathA, nonMatchingPathB].join(", ")}`);
    console.log("matching pongs");
    console.log(JSON.stringify([matchingPongA, matchingPongB, matchingNestedPong], null, 2));
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

runWorkshopMain(import.meta.url, run);
