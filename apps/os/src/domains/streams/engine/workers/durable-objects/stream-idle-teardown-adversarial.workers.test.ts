/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Adversarial pressure tests for the idle-teardown fix: try to make the
// sever / re-dial machinery lose, duplicate, or wedge delivery. The echo
// processor counts inputs it has ingested (`seen`), advancing its DURABLE
// checkpoint per input — so a monotonic 1,2,3,… across forced cold re-dials is
// proof of exactly-once delivery, and any gap or repeat would surface as a wrong
// count.
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
  return { streamName: `adv:/adv/t${counter}`, runnerName: `adv-runner-${counter}` };
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
async function severProducer(stream: DurableObjectStub<Stream>) {
  await runInDurableObject(stream, (instance) => instance.runIdleTeardownNow());
}
async function severSubscriber(runner: DurableObjectStub<StreamProcessorRunner>) {
  await runInDurableObject(runner, (instance) => instance.runIdleDisconnectNow());
}
async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  description: string,
): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = await fn();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function expectEchoSeen(
  stream: DurableObjectStub<Stream>,
  afterOffset: number,
  label: string,
) {
  const echoed = await waitFor(
    async () =>
      (await getEvents(stream)).find((e) => e.type === OUTPUT_TYPE && e.offset > afterOffset),
    label,
  );
  return (echoed.payload as { seen: number }).seen;
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

describe("idle teardown — adversarial pressure", () => {
  it("severs the PRODUCER before every append (forced cold re-dial each time) with no lost or duplicated echoes", async () => {
    const { streamName, runnerName } = freshNames();
    const stream = await configureEchoSubscription({ streamName, runnerName });

    const seen: number[] = [];
    for (let n = 1; n <= 5; n += 1) {
      await severProducer(stream); // tear the session down right before the append
      const input = await appendEvent(stream, { type: INPUT_TYPE, payload: { n } });
      seen.push(await expectEchoSeen(stream, input.offset, `echo ${n} after cold re-dial`));
    }
    // Exactly-once across 5 forced re-dials: the durable checkpoint makes the
    // processor's input count advance 1..5 with no gap (loss) or repeat (dup).
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  }, 60_000);

  it("survives BOTH timers firing between appends (producer sever + subscriber disconnect)", async () => {
    const { streamName, runnerName } = freshNames();
    const stream = await configureEchoSubscription({ streamName, runnerName });
    const runner = RUNNER.getByName(runnerName);

    const first = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 1 } });
    expect(await expectEchoSeen(stream, first.offset, "echo 1")).toBe(1);

    // Both sides independently tear the same session down, in the worst order.
    await severSubscriber(runner);
    await severProducer(stream);

    const second = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 2 } });
    expect(await expectEchoSeen(stream, second.offset, "echo 2 after both-sided teardown")).toBe(2);
  }, 60_000);

  it("severing a quiet stream with no live connection is a harmless no-op", async () => {
    const { streamName, runnerName } = freshNames();
    const stream = await configureEchoSubscription({ streamName, runnerName });
    // Sever twice in a row with no append in between — the second sever has
    // nothing to close and must not throw, re-dial, or wedge later delivery.
    await severProducer(stream);
    await severProducer(stream);
    const input = await appendEvent(stream, { type: INPUT_TYPE, payload: { n: 1 } });
    expect(await expectEchoSeen(stream, input.offset, "echo after double-sever")).toBe(1);
  }, 60_000);
});
