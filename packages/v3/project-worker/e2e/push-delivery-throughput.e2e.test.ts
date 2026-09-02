// push-delivery-throughput.e2e.test.ts — PUSH delivery under volume: a producer floods
// voice-chunk-shaped ephemeral events (256B payloads, batched appends) while a live subscriber
// receives them one-directionally (fire-and-forget event batches over the paged-in hibernatable RPC
// stub — no acks, no server cursor); one append fans out to 200 live subscribers and to 50 userspace
// processor facets while an unrelated call is never head-of-line blocked; a 900-event commit arrives
// as ONE callback invocation. Producer and subscribers run in THIS process, so sentAtMs/arrival share
// one clock: the measured latency is the FULL path (test → worker append+commit → delivery → test).
// Perf floors are generous (local workerd ≠ production); the printed line is what you compare.

import { expect, test } from "vitest";
import { append, collector, freshCtx, openItx, sleep, until } from "./support/client.ts";

type FloodEvent = { payload: { seq: number; sentAtMs: number; pad: string } };

const TOTAL = 2000;
const APPEND_BATCH = 50;

test("ephemeral flood: all chunks delivered exactly once, batched, under latency/throughput budgets", async () => {
  const itx = openItx(freshCtx("flood"));

  // ── the subscriber: a live callback, named-type opt-in (ephemerals need naming) ──
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

  // ── the flood: TOTAL ephemeral chunks in batches of APPEND_BATCH, appends PIPELINED ──
  // (fire-and-forget-then-settle: awaiting each append would serialize the producer on its own RTT
  //  and measure the client's politeness, not the platform — the wire needs no acks per batch)
  const pad = "x".repeat(256);
  const floodStartedAtMs = Date.now();
  const appendCalls: Promise<unknown>[] = [];
  for (let seq = 0; seq < TOTAL; seq += APPEND_BATCH) {
    const batch = Array.from({ length: Math.min(APPEND_BATCH, TOTAL - seq) }, (_, i) => ({
      type: "chunk",
      ephemeral: true,
      payload: { seq: seq + i, sentAtMs: Date.now(), pad },
    }));
    appendCalls.push(append(itx, ...batch));
  }
  await Promise.all(appendCalls);
  const appendsDoneAtMs = Date.now();

  // wait for the tail to arrive (one-directional — nothing to ack, just watch the counter)
  const deadline = Date.now() + 30000;
  while (received.length < TOTAL && Date.now() < deadline) await sleep(100);
  const lastArrivalAtMs = Date.now();

  // ── the numbers ──
  const latencies = received.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number): number =>
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  const wallMs = lastArrivalAtMs - floodStartedAtMs;
  const eventsPerSecond = Math.round((received.length / wallMs) * 1000);
  const appendEventsPerSecond = Math.round((TOTAL / (appendsDoneAtMs - floodStartedAtMs)) * 1000);
  console.log(
    `flood(ephemeral): ${received.length}/${TOTAL} chunks | append ${appendEventsPerSecond} ev/s | ` +
      `end-to-end ${eventsPerSecond} ev/s | latency p50 ${pct(50)}ms p95 ${pct(95)}ms ` +
      `max ${latencies.at(-1)}ms | ${callbackInvocations} callback invocations ` +
      `(batching ${(TOTAL / callbackInvocations).toFixed(1)}×)`,
  );

  expect(received.length).toBe(TOTAL); // no loss at this volume
  expect(new Set(received.map((r) => r.seq)).size).toBe(TOTAL); // every seq exactly once
  expect(contiguityBroken).toBe(false); // delivered ranges CHAIN (client contiguity holds, zero pulls)
  expect(callbackInvocations).toBeLessThan(TOTAL); // BATCH-FIRST: far fewer callbacks than events
  expect(pct(50)).toBeLessThan(500); // p50 end-to-end latency (append→commit→deliver, full path)
  expect(pct(95)).toBeLessThan(1500);
  expect(eventsPerSecond).toBeGreaterThan(1000); // sustained end-to-end throughput
}, 60_000);

test("200 push subscribers — one append fans out to all 200 in under 2s, exactly once each", async () => {
  const itx = openItx(freshCtx("fan200"));
  const counts = new Array(200).fill(0);
  let received = 0;
  // consumes:["ping"] keeps the 200 setup subscribes from fanning out N² deliveries
  for (let base = 0; base < 200; base += 25) {
    await Promise.all(
      Array.from({ length: Math.min(25, 200 - base) }, (_, j) => {
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
  }
  // warm ping: pages all 200 stubs in (cold materialization is not the fan-out cost)
  const tWarm = Date.now();
  await append(itx, { type: "ping", payload: { round: 1 } });
  await until("warm round complete", () => received >= 200, 30_000);
  const coldWallMs = Date.now() - tWarm;
  // the measured round: steady-state fan-out of ONE append across 200 subscribers
  const t0 = Date.now();
  await append(itx, { type: "ping", payload: { round: 2 } });
  await until("all 200 received round 2", () => received >= 400, 10_000);
  const wallMs = Date.now() - t0;
  console.log(`fan-out: cold(first-page) ${coldWallMs}ms, warm ${wallMs}ms for 200 subscribers`);
  expect(wallMs).toBeLessThan(2_000);
  await sleep(300);
  expect(counts.every((c) => c === 2)).toBe(true); // exactly once per round, no dup fan-out
}, 120_000);

// A userspace processor: a `StreamProcessorDurableObject` (the SDK base, `./processor.js`) hosted
// as a facet through `itx.load(src).getDurableObjectClass('FanProbe').get(name)` — what
// `enableProcessor(name, { source, className })` subscribes.
const FAN_PROCESSOR_SOURCE = /* js */ `
import { StreamProcessorDurableObject } from "./processor.js";
export class FanProbe extends StreamProcessorDurableObject {
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
`;

test("50 userspace processors: one append fans out to all 50 in <5s while the stream stays responsive", async () => {
  const itx = openItx(freshCtx("fan50"));
  await itx.kv.put("procsrc", FAN_PROCESSOR_SOURCE);

  const enableT0 = performance.now();
  for (let i = 0; i < 50; i++) {
    await itx.enableProcessor(`fan${i}`, {
      source: "itx.kv.get('procsrc')",
      className: "FanProbe",
    });
  }
  console.log(
    `[fan-out] enabled 50 userspace processors in ${(performance.now() - enableT0).toFixed(0)}ms`,
  );

  // ONE append → the delivery loop pushes all 50 facets.
  const t0 = performance.now();
  const [marker] = await append(itx, { type: "fanout-marker" });

  // Responsiveness DURING the fan-out: an unrelated call must not be head-of-line blocked.
  const whoT0 = performance.now();
  await itx.invokeCapability(["itx", ["whoami"]]);
  const whoMs = performance.now() - whoT0;

  // The barrier: every one of the 50 processors reaches the marker offset.
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      itx.invokeCapability(
        `itx.facets.get('fan${i}').waitUntilProcessed({offset: ${marker.offset}, timeoutMs: 30000})`,
      ),
    ),
  );
  const fanoutMs = performance.now() - t0;
  console.log(
    `[fan-out] all 50 processors reached offset ${marker.offset} in ${fanoutMs.toFixed(0)}ms; whoami during fan-out ${whoMs.toFixed(1)}ms`,
  );

  // Sanity: a mid-pack processor really reduced the log (each enable event + the marker).
  const snap = await itx.invokeCapability(`itx.facets.get('fan7').snapshot()`);
  expect(snap.offset).toBeGreaterThanOrEqual(marker.offset);
  expect((snap.state as { n: number }).n).toBeGreaterThan(0);

  expect(fanoutMs, `fan-out wall time ${fanoutMs.toFixed(0)}ms`).toBeLessThan(5000);
  expect(whoMs, `whoami during fan-out ${whoMs.toFixed(1)}ms`).toBeLessThan(1500);
}, 240_000);

test("an append of 900 events in one batch arrives as ONE callback invocation (batch preserved)", async () => {
  const itx = openItx(freshCtx("bigbatch"));
  const c = collector();
  await itx.subscribe({ name: "bulk", consumes: ["bulk"], target: c.fn });
  const batch = Array.from({ length: 900 }, (_, i) => ({ type: "bulk", payload: { i } }));
  const committed = await append(itx, ...batch);
  expect(committed).toHaveLength(900);
  await until("all 900 delivered", () => c.offsets().length >= 900, 30_000);
  expect(c.invocations).toHaveLength(1); // ONE commit = ONE delivery — the batch is never split
  expect(c.invocations[0].events).toHaveLength(900);
  expect(c.invocations[0].range.through).toBe(committed[899].offset);
});
