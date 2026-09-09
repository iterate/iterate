// push-delivery.e2e.test.ts — PUSH delivery: a live callback (`subscribe({ target: fn })`, a stub lent
// to `itx.rpcStubs` under `subscription:<name>`) OWNS ITS PROGRESS, so the one delivery loop pushes it
// `(events, { after, through })` fire-and-forget — no cursor row, no retry, no ack. (`consumes` is the
// ONE filter rule, consumesEvent — src/stream/processor.test.ts; the pins that read the worker's
// console are push-delivery-no-dropped-warns.e2e, which owns a worker of its own.) Pins:
//   • delivered ranges CHAIN across a consumes-filtered quiet gap: the misses produce no empty sends and
//     the next range starts EXACTLY where the last ended (a client heals a real gap with `readEvents`)
//   • naming an ephemeral type opts it in and the consumes-less default excludes ephemerals — on the
//     wire, to a live callback
//   • `subscribe({ name, target: null })` stops deliveries at the removal offset
//   • a throwing callback never hurts the producer and is never retried; anonymous subscribes get
//     unique names and never shadow each other
//   • under volume: 2000 voice-chunk-shaped ephemerals (256 B payloads, batched appends) delivered
//     exactly once, batched, within latency and throughput budgets — producer and subscriber run in
//     THIS process, so sentAtMs/arrival share one clock and the measured latency is the FULL path;
//     one append fans out to 200 live subscribers in under 2 s and to 50 userspace processor facets in
//     under 5 s while an unrelated call is never head-of-line blocked; a 900-event commit arrives as
//     ONE callback invocation. Perf floors are generous (local workerd ≠ production); the printed line
//     is what you compare

import { expect, test } from "vitest";
import { append, collector, freshCtx, openItx, sleep, until } from "./support/client.ts";

// ── ranges chain; the filter; removal; a throwing callback; anonymous names ──

const row = async (itx: any, name: string): Promise<any> => itx.subscriptions.get(name);

test("delivered ranges CHAIN across a consumes-filtered quiet gap", async () => {
  const itx = openItx(freshCtx("chain"));
  const c = collector();
  await itx.subscribe({ name: "chain", consumes: ["hit"], target: c.fn });
  const [hit1] = await append(itx, { type: "hit" });
  await until("first delivery", () => c.invocations.length >= 1);
  // five durable non-matching events — a quiet gap the subscriber's filter skips entirely
  for (let i = 0; i < 5; i++) await append(itx, { type: "miss", payload: { i } });
  const [hit2] = await append(itx, { type: "hit" });
  await until("second delivery", () => c.invocations.length >= 2);
  await sleep(300);
  expect(c.invocations.length).toBe(2); // the misses must produce NO empty sends
  const [d1, d2] = c.invocations;
  expect(d1.events.map((e) => e.offset)).toEqual([hit1.offset]);
  expect(d2.events.map((e) => e.offset)).toEqual([hit2.offset]);
  // THE contract: the skipped span rides the next delivered range — d2 starts EXACTLY where d1
  // ended (one comparison client-side; a gap here would force a pull that must not be needed).
  expect(d2.range.after).toBe(d1.range.through);
  expect(d2.range.through).toBe(hit2.offset);
});

test("consumes naming an ephemeral type opts in; the consumes-less default excludes ephemerals", async () => {
  const itx = openItx(freshCtx("eph"));
  const optedIn = collector(); // names the ephemeral type — must receive it
  const dflt = collector(); // no consumes — durable events only
  await itx.subscribe({ name: "opted-in", consumes: ["chunk"], target: optedIn.fn });
  await itx.subscribe({ name: "default", target: dflt.fn });
  const [chunk] = await append(itx, { type: "chunk", ephemeral: true, payload: { n: 1 } });
  const [note] = await append(itx, { type: "note" });
  await until("opted-in got the ephemeral", () => optedIn.offsets().includes(chunk.offset));
  await until("default got the durable", () => dflt.offsets().includes(note.offset));
  await sleep(300);
  // the filter is exact (the ONE consumes rule, consumesEvent): the opted-in row saw ONLY its
  // named type; the default row NEVER saw the ephemeral (ephemerals must be named to be delivered)
  expect(optedIn.types()).toEqual(["chunk"]);
  expect(dflt.types()).not.toContain("chunk");
});

test("subscribe({ name, target: null }) stops deliveries at the removal offset", async () => {
  const itx = openItx(freshCtx("bye"));
  const c = collector();
  await itx.subscribe({ name: "bye", consumes: ["mark"], target: c.fn });
  const [m1] = await append(itx, { type: "mark" });
  const [m2] = await append(itx, { type: "mark" });
  await until("both pre-removal marks", () => c.offsets().length >= 2);
  await itx.subscribe({ name: "bye", target: null });
  await append(itx, { type: "mark" });
  await append(itx, { type: "mark" });
  await sleep(600);
  // nothing at or beyond the removal offset may arrive — the row died inside the removal commit
  expect([...c.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
  expect(await row(itx, "bye")).toBeNull();
});

test("a throwing subscriber callback never hurts the producer and is never retried", async () => {
  const itx = openItx(freshCtx("thrower"));
  let throws = 0;
  const witness = collector();
  await itx.subscribe({
    name: "thrower",
    consumes: ["mark"],
    target: () => {
      throws++;
      throw new Error("subscriber exploded");
    },
  });
  await itx.subscribe({ name: "witness", consumes: ["mark"], target: witness.fn });
  const [m1] = await append(itx, { type: "mark" }); // resolves — the producer is unaffected
  const [m2] = await append(itx, { type: "mark" });
  await until("witness got both", () => witness.offsets().length >= 2);
  await until("thrower was offered both", () => throws >= 2);
  await sleep(700); // a retry storm would keep incrementing
  expect(throws).toBe(2); // exactly one offer per batch — fire-and-forget means no ladder here
  expect([...witness.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
  expect((await row(itx, "thrower")).cursor).toBeUndefined(); // no cursor, so nothing to halt
});

test("concurrent anonymous subscribes get unique names and never shadow each other", async () => {
  // Each unnamed subscribe mints a unique `sub-<uuid>` name, so both deliver.
  const itx = openItx(freshCtx("anon"));
  const a = collector();
  const b = collector();
  const s1 = await itx.subscribe({ consumes: ["ping"], target: a.fn });
  const s2 = await itx.subscribe({ consumes: ["ping"], target: b.fn });
  expect(await s1.name).not.toBe(await s2.name); // `name` is a getter on the handle — one hop each
  const [ping] = await append(itx, { type: "ping" });
  await until(
    "both anonymous subscribers received the event",
    () => a.offsets().includes(ping.offset) && b.offsets().includes(ping.offset),
  );
});

// ── under volume ──

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
  // An UNRELATED call during the fan-out: 200 pushes never head-of-line-block the stream.
  const whoT0 = Date.now();
  await itx.whoami();
  const whoMs = Date.now() - whoT0;
  await until("all 200 received round 2", () => received >= 400, 10_000);
  const wallMs = Date.now() - t0;
  console.log(
    `fan-out: cold(first-page) ${coldWallMs}ms, warm ${wallMs}ms for 200 subscribers, whoami mid-fan-out ${whoMs}ms`,
  );
  expect(wallMs).toBeLessThan(2_000);
  expect(whoMs).toBeLessThan(1_500);
  await sleep(300);
  expect(counts.every((c) => c === 2)).toBe(true); // exactly once per round, no dup fan-out
}, 120_000);

// A userspace processor: the pure `FanProbeProcessor extends StreamProcessor` plus its one-line host
// `FanProbeDurableObject extends StreamProcessorDurableObject` (both from the SDK, `./processor.js`),
// hosted as a facet through `itx.facets.get(name, { source, className: 'FanProbeDurableObject' })`
// — what `enableProcessor(name, { source, className })` subscribes.
const FAN_PROCESSOR_SOURCE = {
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

test("50 userspace processors: one append fans out to all 50 in <5s while the stream stays responsive", async () => {
  const itx = openItx(freshCtx("fan50"));

  const enableT0 = performance.now();
  for (let i = 0; i < 50; i++) {
    await itx.enableProcessor(`fan${i}`, {
      source: FAN_PROCESSOR_SOURCE,
      className: "FanProbeDurableObject",
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
  await itx.invoke(["itx", ["whoami"]]);
  const whoMs = performance.now() - whoT0;

  // The barrier: every one of the 50 processors reaches the marker offset.
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      itx.invoke(
        `itx.facets.get('fan${i}').waitUntilProcessed({offset: ${marker.offset}, timeoutMs: 30000})`,
      ),
    ),
  );
  const fanoutMs = performance.now() - t0;
  console.log(
    `[fan-out] all 50 processors reached offset ${marker.offset} in ${fanoutMs.toFixed(0)}ms; whoami during fan-out ${whoMs.toFixed(1)}ms`,
  );

  // Sanity: a mid-pack processor really reduced the log (each enable event + the marker).
  const snap = await itx.invoke(`itx.facets.get('fan7').snapshot()`);
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
