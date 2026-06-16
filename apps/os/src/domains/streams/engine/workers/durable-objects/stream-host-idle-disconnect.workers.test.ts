/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Belt-and-braces companion to stream-idle-teardown.workers.test.ts. The leak is
// symmetric: a subscriber DO that holds a subscription's retained stream stub
// (`entry.stream`) pins the PRODUCER Stream DO resident just as the producer's
// retained callback pins the subscriber. So the StreamProcessorHost has its OWN
// in-memory idle timer: when no batch has arrived for a while it unsubscribes and
// disposes its stream stubs, freeing both DOs to hibernate. The durable
// checkpoint persists, so the producer re-dials and the host re-handshakes when
// activity resumes.
//
// Either side's idle timer alone is sufficient (each frees the other); this test
// proves the SUBSCRIBER side independently tears the session down.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { durableObjectProcessorSubscriber } from "../../shared/callable-subscriber.ts";
import type { StreamEvent } from "../../shared/event.ts";
import type { StreamProcessorRunner } from "../test-support/stream-processor-runner.ts";
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
  return { streamName: `hostidle:/hostidle/t${counter}`, runnerName: `hostidle-runner-${counter}` };
}

async function appendEvent(
  stream: DurableObjectStub<Stream>,
  event: { type: string; payload: unknown },
) {
  return await runInDurableObject(stream, (instance) => instance.append({ event }));
}
async function getEvents(stream: DurableObjectStub<Stream>): Promise<StreamEvent[]> {
  return await runInDurableObject(stream, (instance) => instance.getEvents({ afterOffset: 0 }));
}
async function outboundConnectionCount(stream: DurableObjectStub<Stream>): Promise<number> {
  return await runInDurableObject(
    stream,
    (instance) =>
      Object.values(instance.runtimeState().runtime.connections).filter(
        (c) => c.direction === "outbound",
      ).length,
  );
}
async function runnerSubscription(runner: DurableObjectStub<StreamProcessorRunner>) {
  return await runInDurableObject(
    runner,
    (instance) => instance.runtimeState({ processorName: "echo-example" }).runtime.subscription,
  );
}
async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  description: string,
  { attempts = 100, delay = 50 } = {},
): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const value = await fn();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, delay));
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

describe("subscriber-side idle disconnect frees the producer too (belt-and-braces)", () => {
  it("the host drops its stream stub on idle, freeing the producer connection, then re-handshakes on the next append", async () => {
    const { streamName, runnerName } = freshNames();
    const stream = await configureEchoSubscription({ streamName, runnerName });
    const runner = RUNNER.getByName(runnerName);

    // Establish the session: producer holds an outbound connection, the host
    // holds a retained stream stub (its subscription).
    const first = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 1 } });
    await waitFor(
      async () =>
        (await getEvents(stream)).some((e) => e.type === OUTPUT_TYPE && e.offset > first.offset),
      "echo of the first input",
    );
    expect(await outboundConnectionCount(stream)).toBeGreaterThan(0);
    expect(await runnerSubscription(runner)).toBeDefined();

    // The SUBSCRIBER's idle timer fires (invoked directly for determinism).
    // Before the fix this method does not exist -> red.
    await runInDurableObject(runner, (instance) => instance.runIdleDisconnectNow());

    // The host released its subscription (no retained stream stub pinning the
    // producer) ...
    expect(await runnerSubscription(runner)).toBeUndefined();
    // ... and the producer's outbound connection is gone too (the host
    // unsubscribed), so neither DO is pinned.
    await waitFor(
      async () => (await outboundConnectionCount(stream)) === 0,
      "the producer's outbound connection to close after the host unsubscribed",
    );

    // Durable checkpoint survived: the next append re-dials the host, which
    // re-handshakes and ingests — the echo continues from where it left off.
    const second = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 2 } });
    const echoed = await waitFor(
      async () =>
        (await getEvents(stream)).find((e) => e.type === OUTPUT_TYPE && e.offset > second.offset),
      "echo after re-handshake",
    );
    expect((echoed.payload as { seen: number }).seen).toBe(2);
  }, 30_000);
});
