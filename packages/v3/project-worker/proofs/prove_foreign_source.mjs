// prove_foreign_source.mjs — A CF PROCESSOR REDUCING AN OFF-PLATFORM BOX'S STREAM, LIVE.
//
// The requirement, whole: a noisy stream lives on a box (Home Assistant / Raspberry Pi); a stream
// PROCESSOR running in a Cloudflare Durable Object reduces it, keeping only the small derived state
// — the raw firehose never touches a CF DO. This proves it end to end against the live deployment.
//
//   • the BOX (this script): connects to /api and provides `itx.sensors` — a real Stream
//     (append + read → { events, scannedThroughOffset }, offsets assigned locally). Events live HERE.
//   • the EDGE: a CF context enables a `tally` processor pointed at the box via
//     `sourceStream: "itx.sensors"`. The processor restores that ref and reads the box's stream
//     (contexts/capability read — the existing cross-DO read); the DO's commit pump skips it (its
//     events are elsewhere). Its snapshot catches up from the box and counts events by type.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_fsrc${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (label, fn, timeoutMs = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

// ── the BOX: a real Stream (append/read → {events, scannedThroughOffset}); events live HERE ──
class SensorStream extends RpcTarget {
  #log = []; // { type, payload, offset }
  append(...events) {
    const base = this.#log.length;
    for (const e of events) this.#log.push({ ...e, offset: this.#log.length + 1 });
    return this.#log.slice(base);
  }
  read(after = 0, limit = 500) {
    const events = this.#log.filter((e) => e.offset > after).slice(0, limit);
    return { events, scannedThroughOffset: this.#log.length };
  }
  size() {
    return this.#log.length;
  }
}
const sensors = new SensorStream();

// ── the box provides itself as `itx.sensors`; a second client is the edge operator ──
const boxSession = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const boxItx = await boxSession.authenticate().get();
await boxItx.provideCapability({
  type: "live",
  path: ["sensors"],
  capability: sensors,
  instructions: "an off-platform sensor stream (test box)",
});

const itx = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`).authenticate().get();

// 1. events land on the BOX (not a CF DO). Append motion, motion, temp.
await until("itx.sensors mount routable", async () =>
  Array.isArray((await itx.invoke("itx.sensors.read(0, 500)"))?.events) ? true : undefined,
);
await itx.invoke(["itx", "sensors", ["append", { type: "motion", payload: { room: "kitchen" } }]]);
await itx.invoke(["itx", "sensors", ["append", { type: "motion", payload: { room: "hall" } }]]);
await itx.invoke(["itx", "sensors", ["append", { type: "temp", payload: { c: 21 } }]]);
check(
  sensors.size() === 3,
  "the 3 sensor events live in the BOX (never a CF DO)",
  `${sensors.size()}`,
);

// 2. enable a `tally` processor on the edge context, pointed at the BOX's stream.
await itx.enableProcessor("tally", undefined, { sourceStream: "itx.sensors" });

// 3. the processor catches up from the box and counts by type — proving a CF DO reduces the
//    off-platform stream.
const counts = await until("tally reduced the box's stream", async () => {
  const snap = await itx.facetSnapshot("tally");
  const c = snap?.state?.counts ?? {};
  return c.motion === 2 && c.temp === 1 ? c : undefined;
});
check(
  counts.motion === 2 && counts.temp === 1,
  "a CF processor reduced the BOX's stream (tally by type)",
  JSON.stringify(counts),
);

// 4. the edge context's OWN log never saw the firehose — it holds only the derived tally.
const ownPage = await itx.invokeCapability({ path: ["stream", "read"], args: [] });
check(
  !ownPage.events.some((e) => e.type === "motion" || e.type === "temp"),
  "the sensor firehose never touched the edge context's own log",
  JSON.stringify(ownPage.events.map((e) => e.type)),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
