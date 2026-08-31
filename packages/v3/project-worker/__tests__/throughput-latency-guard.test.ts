// __tests__/throughput-latency-guard.test.ts — THE FAST NO-REGRESSION GUARD for the simplification
// pass. It is the in-harness twin of proofs/prove_ephemeralflood.mjs (which runs against the live
// deployment and needs a deploy each time): a producer floods voice-chunk-shaped EPHEMERAL events
// in batched, pipelined appends while a CONNECTED subscriber receives them one-directionally
// (fire-and-forget batches over the paged-in hibernatable RPC stub — no acks, no server cursor).
// Producer and subscriber run in THIS process against the real worker booted by the harness, so
// the measured latency is the FULL path (client → capnweb /api → append+commit → delivery → client).
//
// WHY IT EXISTS: every refactor in SIMPLIFICATION-LOG.md must not regress throughput, latency, or
// the ONE-directional batched delivery shape. This test runs in seconds (no deploy) and PRINTS the
// numbers, so a regression shows up as a changed number long before the live proof would catch it.
// The asserted floors are deliberately GENEROUS (local workerd ≠ production) — the guard is the
// printed line you compare across runs, plus the hard invariants (no loss, batching, bounded p95).
//
// Run: pnpm exec vitest run --project harness __tests__/throughput-latency-guard.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

const TOTAL = 1000; // events flooded; kept modest so the harness lane stays fast
const APPEND_BATCH = 50; // events per pipelined append call (mirrors the live proof)
const PAYLOAD = "x".repeat(256); // voice-chunk-shaped payload

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

test("throughput+latency guard: 1000 ephemeral chunks flood through one-directional batched delivery", async () => {
  const itx = await harness.itx(`prj_perf_${Date.now().toString(36)}`);

  // ── the subscriber: a live callback, event mode, named-type opt-in (ephemerals need naming) ──
  const received: Array<{ seq: number; latencyMs: number }> = [];
  let callbackInvocations = 0;
  let contiguityBroken = false;
  let lastThrough: number | undefined;
  await itx.subscribe({
    name: "flood-ear",
    consumes: ["chunk"],
    target: (
      events: Array<{ payload: { seq: number; sentAtMs: number } }>,
      scannedOffsetRange: { scannedAfterOffset: number; scannedThroughOffset: number },
    ) => {
      const arrivedAtMs = Date.now();
      callbackInvocations++;
      // Delivered ranges must CHAIN — a gap would be heal-by-pull in a real client; not here.
      if (lastThrough !== undefined && scannedOffsetRange.scannedAfterOffset !== lastThrough)
        contiguityBroken = true;
      lastThrough = scannedOffsetRange.scannedThroughOffset;
      for (const e of events)
        received.push({ seq: e.payload.seq, latencyMs: arrivedAtMs - e.payload.sentAtMs });
    },
  });

  // ── the flood: TOTAL ephemeral chunks in batches, appends PIPELINED (fire-and-forget-then-settle) ──
  const floodStartedAtMs = Date.now();
  const appendCalls: Array<Promise<unknown>> = [];
  for (let seq = 0; seq < TOTAL; seq += APPEND_BATCH) {
    const batch = Array.from({ length: Math.min(APPEND_BATCH, TOTAL - seq) }, (_, i) => ({
      type: "chunk",
      ephemeral: true as const,
      payload: { seq: seq + i, sentAtMs: Date.now(), pad: PAYLOAD },
    }));
    appendCalls.push(itx.invokeCapability(["itx", "stream", ["append", ...batch]]));
  }
  await Promise.all(appendCalls);
  const appendsDoneAtMs = Date.now();

  // wait for the tail (one-directional — nothing to ack, just watch the counter)
  const deadline = Date.now() + 20_000;
  while (received.length < TOTAL && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  const lastArrivalAtMs = Date.now();

  // ── the numbers (printed for run-to-run comparison) ──
  const latencies = received.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? -1;
  const wallMs = Math.max(1, lastArrivalAtMs - floodStartedAtMs);
  const endToEndEventsPerSecond = Math.round((received.length / wallMs) * 1000);
  const appendEventsPerSecond = Math.round(
    (TOTAL / Math.max(1, appendsDoneAtMs - floodStartedAtMs)) * 1000,
  );
  const batchingFactor = (TOTAL / Math.max(1, callbackInvocations)).toFixed(1);
  console.log(
    `[perf-guard] ${received.length}/${TOTAL} | append ${appendEventsPerSecond} ev/s | ` +
      `end-to-end ${endToEndEventsPerSecond} ev/s | latency p50 ${pct(50)}ms p95 ${pct(95)}ms ` +
      `max ${latencies.at(-1)}ms | ${callbackInvocations} callback invocations (batching ${batchingFactor}×)`,
  );

  // ── hard invariants (must never regress) ──
  expect(received.length, "no loss: every chunk delivered").toBe(TOTAL);
  expect(new Set(received.map((r) => r.seq)).size, "no dup: every seq exactly once").toBe(TOTAL);
  expect(contiguityBroken, "delivered ScannedRanges chain (zero pulls)").toBe(false);
  expect(callbackInvocations, "batch-first: far fewer callbacks than events").toBeLessThan(TOTAL);

  // ── generous floors (compare the printed line for real regressions) ──
  expect(pct(95), "p95 end-to-end latency bounded").toBeLessThan(3000);
  expect(endToEndEventsPerSecond, "sustained throughput above floor").toBeGreaterThan(500);
});
