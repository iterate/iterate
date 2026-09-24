// e2e/support/push-load.ts — the push-delivery LOADS, one spelling each, shared by the correctness
// rows (e2e/push-delivery.e2e.test.ts: nothing lost, nothing twice, batched) and the budget rows
// (perf/push-delivery.perf.test.ts: how fast, measured alone). Each returns what it observed; the
// caller decides what to assert.

import { sleep, until } from "./client.ts";

/** What one ephemeral flood observed. Latency is append-side `sentAtMs` → arrival in the callback:
 *  producer and subscriber run in THIS process, so both ends share one clock and the number is the
 *  FULL path (append → commit → deliver). */
export type Flood = {
  total: number;
  seqs: number[];
  callbackInvocations: number;
  contiguityBroken: boolean;
  latencyMs: { p50: number; p95: number; max: number };
  endToEndEventsPerSecond: number;
  line: string;
};

type FloodEvent = { payload: { seq: number; sentAtMs: number; pad: string } };

/** `total` voice-chunk-shaped ephemerals (256 B payloads) appended in batches of 50, PIPELINED
 *  (awaiting each append would serialize the producer on its own RTT and measure the client's
 *  politeness, not the platform), to one live callback subscribed by named type (ephemerals need
 *  naming). Waits up to 30 s for the tail. */
export async function ephemeralFlood(itx: any, total = 2000): Promise<Flood> {
  const received: { seq: number; latencyMs: number }[] = [];
  let callbackInvocations = 0;
  let contiguityBroken = false;
  let lastThrough: number | undefined; // the client-held offset: delivered ranges must CHAIN
  await itx.subscribe({
    name: "flood-ear",
    consumes: ["chunk"],
    target: (events: FloodEvent[], range: { after: number; through: number }) => {
      const arrivedAtMs = Date.now();
      callbackInvocations++;
      // a gap would be heal-by-pull in a real client; here it must not happen
      if (lastThrough !== undefined && range.after !== lastThrough) contiguityBroken = true;
      lastThrough = range.through;
      for (const e of events)
        received.push({ seq: e.payload.seq, latencyMs: arrivedAtMs - e.payload.sentAtMs });
    },
  });

  const pad = "x".repeat(256);
  const floodStartedAtMs = Date.now();
  const appendCalls: Promise<unknown>[] = [];
  for (let seq = 0; seq < total; seq += 50) {
    const batch = Array.from({ length: Math.min(50, total - seq) }, (_, i) => ({
      type: "chunk",
      ephemeral: true,
      payload: { seq: seq + i, sentAtMs: Date.now(), pad },
    }));
    appendCalls.push(itx.append(...batch));
  }
  await Promise.all(appendCalls);
  const appendsDoneAtMs = Date.now();

  // one-directional — nothing to ack, just watch the counter
  const deadline = Date.now() + 30_000;
  while (received.length < total && Date.now() < deadline) await sleep(100);
  const lastArrivalAtMs = Date.now();

  const latencies = received.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number): number =>
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? NaN;
  const latencyMs = { p50: pct(50), p95: pct(95), max: latencies.at(-1) ?? NaN };
  const endToEndEventsPerSecond = Math.round(
    (received.length / (lastArrivalAtMs - floodStartedAtMs)) * 1000,
  );
  const appendEventsPerSecond = Math.round((total / (appendsDoneAtMs - floodStartedAtMs)) * 1000);
  return {
    total,
    seqs: received.map((r) => r.seq),
    callbackInvocations,
    contiguityBroken,
    latencyMs,
    endToEndEventsPerSecond,
    line:
      `flood(ephemeral): ${received.length}/${total} chunks | append ${appendEventsPerSecond} ev/s | ` +
      `end-to-end ${endToEndEventsPerSecond} ev/s | latency p50 ${latencyMs.p50}ms ` +
      `p95 ${latencyMs.p95}ms max ${latencyMs.max}ms | ${callbackInvocations} callback invocations ` +
      `(batching ${(total / callbackInvocations).toFixed(1)}×)`,
  };
}

/** `count` live callbacks `fan-<i>` consuming only `ping` (so the setup subscribes never fan out N²
 *  deliveries), subscribed 25 at a time, then a warm ping that pages every lent stub in — cold
 *  materialization is not the fan-out cost. Then round by round (2, 3, …): `ping(round)` is ONE
 *  append, `delivered(round)` resolves once all `count` callbacks have it.
 *
 *  `onSubscribed` hears each batch's subscribe round trip before the warm ping. A live push is
 *  best-effort: a lent stub the Durable Object paged for and did not get within its 10 s loses that
 *  push (context/rpc-stubs.ts logs `rpc-stub-page-timed-out`), and these callbacks never read back
 *  what they missed. On 2026-09-24 (main a8e6c6525) Cloudflare moved traffic out of IAD, every
 *  round trip between the edge and the Durable Object stalled ~3 s, each batch took 3.0–3.2 s where
 *  it takes ~0.1 s, and 33 of 200 callbacks never had the warm ping. */
export async function pushSubscribers(
  itx: any,
  count: number,
  onSubscribed?: (batchMs: number[]) => void,
) {
  const counts = new Array<number>(count).fill(0);
  let received = 0;
  const subscribeBatchMs: number[] = [];
  for (let base = 0; base < count; base += 25) {
    const started = performance.now();
    await Promise.all(
      Array.from({ length: Math.min(25, count - base) }, (_, j) => {
        const i = base + j;
        return itx.subscribe({
          name: `fan-${i}`,
          consumes: ["ping"],
          target: () => {
            counts[i]++;
            received++;
          },
        });
      }),
    );
    subscribeBatchMs.push(Math.round(performance.now() - started));
  }
  onSubscribed?.(subscribeBatchMs);
  const ping = (round: number) => itx.append({ type: "ping", payload: { round } });
  const tWarm = Date.now();
  await ping(1);
  // paging 200 lent stubs in took over 30 s once in a hundred soak runs (2026-09-22, run 55)
  await until("warm round complete", () => received >= count, 60_000).catch((error: Error) => {
    throw new Error(
      `${error.message}: ${received} of ${count} callbacks had the warm ping; the subscribes took ${subscribeBatchMs.join(", ")} ms a batch of 25`,
    );
  });
  return {
    coldWallMs: Date.now() - tWarm,
    counts,
    ping,
    delivered: (round: number) =>
      until(`all ${count} received round ${round}`, () => received >= count * round, 10_000),
  };
}

/** `count` fan-out probe processors named `fan0`…`fan<count-1>` (FAN_PROBE below), enabled one
 *  after another. `mark()` is ONE append and returns its offset; `reached(offset)` resolves once
 *  every probe has reduced it. */
export async function fanProbes(itx: any, count: number) {
  const names = Array.from({ length: count }, (_, i) => `fan${i}`);
  for (const name of names)
    await itx.processors.enable(name, { source: FAN_PROBE, className: "FanProbeDurableObject" });
  return {
    mark: async (): Promise<number> => {
      const [marker] = await itx.append({ type: "fanout-marker" });
      return marker.offset;
    },
    reached: (offset: number) =>
      Promise.all(
        names.map((name) =>
          itx.invoke(
            `itx.facets.get('${name}').waitUntilProcessed({offset: ${offset}, timeoutMs: 30000})`,
          ),
        ),
      ),
  };
}

/** The fan-out probe: the pure `FanProbeProcessor extends StreamProcessor` plus its one-line host
 *  `FanProbeDurableObject extends StreamProcessorDurableObject` (both from the SDK, `./processor.js`),
 *  counting every durable event. */
const FAN_PROBE = {
  "cap.js": /* js */ `
import { StreamProcessor, StreamProcessorDurableObject } from "./processor.js";
class FanProbeProcessor extends StreamProcessor {
  contract = {
    slug: "fan-probe",
    version: "1",
    description: "counts every durable event — the fan-out probe",
    consumes: ["*"],
    emits: [],
    initialState: () => ({ n: 0 }),
  };
  reduce({ state }) {
    return { n: state.n + 1 };
  }
}
export class FanProbeDurableObject extends StreamProcessorDurableObject {
  processor = new FanProbeProcessor();
}
`,
};
