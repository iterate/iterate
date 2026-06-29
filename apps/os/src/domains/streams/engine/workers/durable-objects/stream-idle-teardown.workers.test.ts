/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Regression test for the Durable Objects billable-duration leak (#1500 fallout):
// a Stream DO that holds an idle OUTBOUND delivery connection keeps a
// cross-isolate RPC session open, pinning BOTH itself and the subscriber DO
// resident — billing duration for hours at ~0 CPU. The fix gives the Stream DO
// an in-memory idle timer that severs outbound connections once a stream goes
// quiet, so both DOs can hibernate; the durable subscription config is kept, so
// the next append re-dials and the subscriber re-handshakes from its checkpoint.
//
// Drives the real leak path: Stream DO -> Callable dial -> StreamProcessorRunner
// (echo processor) -> subscribeOutbound -> retained callback stub.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { durableObjectProcessorSubscriber } from "../../shared/callable-subscriber.ts";
import type { StreamEvent } from "../../shared/event.ts";
import type { Stream } from "./stream.ts";

const STREAM = (env as unknown as { STREAM: DurableObjectNamespace<Stream> }).STREAM;

const INPUT_TYPE = "events.iterate.com/echo-example/input-received";
const OUTPUT_TYPE = "events.iterate.com/echo-example/output-echoed";
const DISCONNECTED_TYPE = "events.iterate.com/stream/subscriber-disconnected";

let counter = 0;
function freshNames() {
  counter += 1;
  const streamName = `idle:/idle/t${counter}`;
  return { streamName, runnerName: `${streamName}:runner-${counter}` };
}

async function appendEvent(
  stream: DurableObjectStub<Stream>,
  event: { type: string; payload: unknown; idempotencyKey?: string },
) {
  return await runInDurableObject(stream, (instance) => instance.append({ event }));
}

async function getEvents(stream: DurableObjectStub<Stream>): Promise<StreamEvent[]> {
  return await runInDurableObject(stream, (instance) => instance.getEvents({ afterOffset: 0 }));
}

async function outboundConnectionKeys(stream: DurableObjectStub<Stream>): Promise<string[]> {
  return await runInDurableObject(stream, (instance) =>
    Object.entries(instance.runtimeState().runtime.connections)
      .filter(([, connection]) => connection.direction === "outbound")
      .map(([key]) => key),
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

describe("idle outbound teardown lets a quiet Stream DO hibernate", () => {
  it("severs the idle outbound connection, records reason 'idle', then re-dials on the next append", async () => {
    const { streamName, runnerName } = freshNames();
    const stream = await configureEchoSubscription({ streamName, runnerName });

    // The dial establishes a live outbound connection — the leak's pin.
    const first = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 1 } });
    await waitFor(
      async () =>
        (await getEvents(stream)).some((e) => e.type === OUTPUT_TYPE && e.offset > first.offset),
      "echo of the first input",
    );
    await waitFor(
      async () => (await outboundConnectionKeys(stream)).length > 0,
      "a live outbound delivery connection",
    );

    // The stream goes quiet: the idle timer fires (invoked directly for
    // determinism — the same action the in-memory timer takes).
    await runInDurableObject(stream, (instance) => instance.runIdleTeardownNow());

    // The outbound connection is gone, so nothing pins the DO any more ...
    expect(await outboundConnectionKeys(stream)).toEqual([]);
    // ... and the deliberate teardown is recorded with reason "idle".
    const afterTeardown = await getEvents(stream);
    expect(
      afterTeardown.some(
        (e) => e.type === DISCONNECTED_TYPE && (e.payload as { reason?: string }).reason === "idle",
      ),
    ).toBe(true);

    // The durable subscription config survived: the next append re-dials the
    // subscriber (it re-handshakes from its checkpoint) and the echo lands.
    const second = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 2 } });
    const echoed = await waitFor(
      async () =>
        (await getEvents(stream)).find((e) => e.type === OUTPUT_TYPE && e.offset > second.offset),
      "echo after re-dial",
    );
    expect((echoed.payload as { seen: number }).seen).toBe(2);
  }, 30_000);
});
