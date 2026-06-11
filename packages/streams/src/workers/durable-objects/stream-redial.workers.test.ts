/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Regression tests for streams review finding M1: a subscriber DO that
// dies (eviction, deploy, abort) leaves the Stream DO holding a dead outbound
// connection. Before the fix, batch delivery rejections were swallowed, the
// dead connection stayed in the stream's connection map, and reconcile skipped
// its key — so the subscriber was never re-dialed and delivery stalled
// silently for the rest of the stream incarnation. This is exactly the prod
// 2026-06-10 Slack-agent shape: a deploy evicted the agent host DO and the
// agent never received another event.
//
// The test drives the real path: Stream DO -> Callable dial ->
// StreamProcessorRunner (echo processor) -> subscribeOutbound -> batch pump,
// then aborts the runner to simulate a deploy and asserts the next append
// still reaches a (fresh) runner instance.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { durableObjectProcessorSubscriber } from "../../shared/callable-subscriber.ts";
import type { StreamEvent } from "../../shared/event.ts";
import type { StreamProcessorRunner } from "./stream-processor-runner.ts";
import type { Stream } from "./stream.ts";

const STREAM = (env as unknown as { STREAM: DurableObjectNamespace<Stream> }).STREAM;
const RUNNER = (
  env as unknown as { STREAM_PROCESSOR_RUNNER: DurableObjectNamespace<StreamProcessorRunner> }
).STREAM_PROCESSOR_RUNNER;

const INPUT_TYPE = "events.iterate.com/echo-example/input-received";
const OUTPUT_TYPE = "events.iterate.com/echo-example/output-echoed";

let counter = 0;
function freshNames() {
  counter += 1;
  return {
    streamName: `redial:/redial/t${counter}`,
    runnerName: `redial-runner-${counter}`,
  };
}

async function appendEvent(
  stream: DurableObjectStub<Stream>,
  event: { type: string; payload: unknown; idempotencyKey?: string },
) {
  return await runInDurableObject(stream, (instance) => instance.append({ event }));
}

async function waitForEvent(
  stream: DurableObjectStub<Stream>,
  predicate: (event: StreamEvent) => boolean,
  description: string,
): Promise<StreamEvent> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const events = await runInDurableObject(stream, (instance) =>
      instance.getEvents({ afterOffset: 0 }),
    );
    const match = events.find(predicate);
    if (match !== undefined) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function configureEchoSubscription(args: { streamName: string; runnerName: string }) {
  const stream = STREAM.getByName(args.streamName);
  await appendEvent(stream, {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: `echo:${args.runnerName}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "STREAM_PROCESSOR_RUNNER",
        durableObjectName: args.runnerName,
        processorName: "echo-example",
      }),
    },
  });
  return stream;
}

describe("outbound re-dial after subscriber death (M1)", () => {
  it("delivers an event appended after the subscriber DO is aborted", async () => {
    const { streamName, runnerName } = freshNames();
    const stream = await configureEchoSubscription({ streamName, runnerName });

    // Sanity: the live path works before the simulated deploy.
    const first = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 1 } });
    await waitForEvent(
      stream,
      (event) => event.type === OUTPUT_TYPE && event.offset > first.offset,
      "echo of the first input",
    );

    // Simulate a deploy: abort the runner DO. The stream's retained delivery
    // stub now points at a dead incarnation.
    await runInDurableObject(RUNNER.getByName(runnerName), (instance) =>
      // `ctx` is protected on DurableObject; tests reach in to simulate the eviction.
      (instance as unknown as { ctx: DurableObjectState }).ctx.abort("simulated deploy eviction"),
    ).catch(() => {
      // The abort kills the instance mid-call; the rejection is the point.
    });

    // The append after the abort must still reach a (fresh) runner: delivery
    // into the dead stub rejects, the stream drops the connection and
    // re-dials, and the runner re-handshakes from its durable checkpoint.
    const second = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 2 } });
    const echoed = await waitForEvent(
      stream,
      (event) => event.type === OUTPUT_TYPE && event.offset > second.offset,
      "echo of the input appended after the subscriber died",
    );
    expect((echoed.payload as { seen: number }).seen).toBe(2);
  }, 30_000);

  it("advances the subscriber's durable checkpoint past events appended after the abort", async () => {
    const { streamName, runnerName } = freshNames();
    const stream = await configureEchoSubscription({ streamName, runnerName });

    const first = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 1 } });
    await waitForEvent(
      stream,
      (event) => event.type === OUTPUT_TYPE && event.offset > first.offset,
      "echo of the first input",
    );

    await runInDurableObject(RUNNER.getByName(runnerName), (instance) =>
      (instance as unknown as { ctx: DurableObjectState }).ctx.abort("simulated deploy eviction"),
    ).catch(() => {});

    const second = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 2 } });

    // The Stream DO's connection cursor advances even into a dead stub (that
    // is the bug), so the only honest signal is the subscriber side: the
    // runner's durable processor checkpoint (DO KV, survives the abort) only
    // moves past the second input if the stream actually re-dialed and a
    // fresh runner incarnation ingested the batch.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = await runInDurableObject(RUNNER.getByName(runnerName), (instance) =>
        instance.runtimeState({ processorName: "echo-example" }),
      );
      if ((snapshot.snapshot?.offset ?? 0) >= second.offset) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("subscriber checkpoint never advanced past the post-abort append");
  }, 30_000);
});
