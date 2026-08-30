// prove_ephemeralflood.mjs — HIGH-VOLUME EPHEMERAL THROUGHPUT + LATENCY, live: a producer
// floods voice-chunk-shaped ephemeral events (256B payloads, batched appends) while a
// CONNECTED subscriber receives them one-directionally (fire-and-forget event batches over the
// paged-in hibernatable RPC stub — no acks, no server cursor). Producer and subscriber run in
// THIS process, so sentAtMs/arrival share one clock: the measured latency is the FULL path
// (node → CF append+commit → one-directional delivery → node).
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX =
  process.env.CTX ?? `prj_flood${process.env.DURABLE === "1" ? "d" : ""}${Date.now() % 100000}`;
const TOTAL = Number(process.env.TOTAL ?? 2000);
const APPEND_BATCH = 50;
// DURABLE=1 floods durable events instead (SQL rows + inline checkpoints inside the commit
// transaction) — the durable-vs-ephemeral cost split, measured with the same harness.
const EPHEMERAL = process.env.DURABLE !== "1";
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();

// ── the subscriber: a live callback, event mode, named-type opt-in (ephemerals need naming) ──
const received = []; // { seq, latencyMs }
let callbackInvocations = 0;
let contiguityBroken = false;
let lastThrough; // the client-held offset: delivered ranges must CHAIN
await itx.subscribe({
  name: "flood-ear",
  consumes: ["chunk"],
  target: (events, scannedOffsetRange) => {
    const arrivedAtMs = Date.now();
    callbackInvocations++;
    if (lastThrough !== undefined && scannedOffsetRange.scannedAfterOffset !== lastThrough)
      contiguityBroken = true; // a gap would be heal-by-pull in a real client; here it must not happen
    lastThrough = scannedOffsetRange.scannedThroughOffset;
    for (const e of events)
      received.push({ seq: e.payload.seq, latencyMs: arrivedAtMs - e.payload.sentAtMs });
  },
});

// ── the flood: TOTAL ephemeral chunks in batches of APPEND_BATCH, appends PIPELINED ──
// (fire-and-forget-then-settle: awaiting each append serializes the producer on its own RTT
// and measures the client's politeness, not the platform — the wire needs no acks per batch)
const pad = "x".repeat(256);
const floodStartedAtMs = Date.now();
const appendCalls = [];
for (let seq = 0; seq < TOTAL; seq += APPEND_BATCH) {
  const batch = Array.from({ length: Math.min(APPEND_BATCH, TOTAL - seq) }, (_, i) => ({
    type: "chunk",
    ...(EPHEMERAL ? { ephemeral: true } : {}),
    payload: { seq: seq + i, sentAtMs: Date.now(), pad },
  }));
  appendCalls.push(itx.invokeCapability(["itx", "stream", ["append", ...batch]]));
}
await Promise.all(appendCalls);
const appendsDoneAtMs = Date.now();

// wait for the tail to arrive (one-directional — nothing to ack, just watch the counter)
const deadline = Date.now() + 30000;
while (received.length < TOTAL && Date.now() < deadline)
  await new Promise((r) => setTimeout(r, 100));
const lastArrivalAtMs = Date.now();

// ── the numbers ──
const latencies = received.map((r) => r.latencyMs).sort((a, b) => a - b);
const pct = (p) =>
  latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
const wallMs = lastArrivalAtMs - floodStartedAtMs;
const eventsPerSecond = Math.round((received.length / wallMs) * 1000);
const appendEventsPerSecond = Math.round((TOTAL / (appendsDoneAtMs - floodStartedAtMs)) * 1000);
console.log(
  `flood(${EPHEMERAL ? "ephemeral" : "DURABLE"}): ${received.length}/${TOTAL} chunks | append ${appendEventsPerSecond} ev/s | end-to-end ${eventsPerSecond} ev/s | ` +
    `latency p50 ${pct(50)}ms p95 ${pct(95)}ms max ${latencies.at(-1)}ms | ${callbackInvocations} callback invocations (batching ${(TOTAL / callbackInvocations).toFixed(1)}×)`,
);

check(
  received.length === TOTAL,
  `all ${TOTAL} ephemeral chunks delivered (no loss at this volume)`,
  `${received.length}`,
);
const seen = new Set(received.map((r) => r.seq));
check(seen.size === TOTAL, "every seq arrived exactly once (no dup, no loss)", `${seen.size}`);
check(
  !contiguityBroken,
  "delivered ScannedOffsetRanges CHAIN (client contiguity holds, zero pulls)",
  "",
);
check(
  callbackInvocations < TOTAL,
  "BATCH-FIRST: far fewer callback invocations than events",
  `${callbackInvocations} invocations for ${TOTAL} events`,
);
check(
  pct(50) < 500,
  "p50 end-to-end latency under 500ms (append→commit→deliver, full path)",
  `${pct(50)}ms`,
);
check(pct(95) < 1500, "p95 end-to-end latency under 1500ms", `${pct(95)}ms`);
check(
  eventsPerSecond > 1000,
  "sustained end-to-end throughput above 1000 events/s",
  `${eventsPerSecond} ev/s`,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
