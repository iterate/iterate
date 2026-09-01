// ephemeralflood.e2e.test.ts — HIGH-VOLUME EPHEMERAL THROUGHPUT + LATENCY: a producer floods
// voice-chunk-shaped ephemeral events (256B payloads, batched appends) while a CONNECTED subscriber
// receives them one-directionally (fire-and-forget event batches over the paged-in hibernatable RPC
// stub — no acks, no server cursor). Producer and subscriber run in THIS process, so sentAtMs/arrival
// share one clock: the measured latency is the FULL path (test → worker append+commit → one-directional
// delivery → test). (The proof's DURABLE=1 variant that floods durable events is not ported here.)
// (was proofs/prove_ephemeralflood.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, sleep } from "./support/client.ts";

type FloodEvent = { payload: { seq: number; sentAtMs: number; pad: string } };

const TOTAL = 2000;
const APPEND_BATCH = 50;

test("ephemeral flood: all chunks delivered exactly once, batched, under latency/throughput budgets", async () => {
  const itx = openItx(freshCtx("flood"));

  // ── the subscriber: a live callback, event mode, named-type opt-in (ephemerals need naming) ──
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
    appendCalls.push(itx.invokeCapability(["itx", ["append", ...batch]]));
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

  // all TOTAL ephemeral chunks delivered (no loss at this volume)
  expect(received.length).toBe(TOTAL);
  // every seq arrived exactly once (no dup, no loss)
  const seen = new Set(received.map((r) => r.seq));
  expect(seen.size).toBe(TOTAL);
  // delivered ScannedRanges CHAIN (client contiguity holds, zero pulls)
  expect(contiguityBroken).toBe(false);
  // BATCH-FIRST: far fewer callback invocations than events
  expect(callbackInvocations).toBeLessThan(TOTAL);
  // p50 end-to-end latency under 500ms (append→commit→deliver, full path)
  expect(pct(50)).toBeLessThan(500);
  // p95 end-to-end latency under 1500ms
  expect(pct(95)).toBeLessThan(1500);
  // sustained end-to-end throughput above 1000 events/s
  expect(eventsPerSecond).toBeGreaterThan(1000);
}, 60_000);
