// prove_byo_stream.mjs — THE BRING-YOUR-OWN-STREAM WALKING SKELETON.
//
// The requirement: a NOISY stream (a Home Assistant box emitting sensor events many/second) should
// not pin a Cloudflare DO and cost ~$5/mo. The documented answer (ADR 0021): a stream is an
// INTERFACE, and its backing can live OFF-PLATFORM — you provide a capability that implements it.
// This is the exact shape of prove_slack.mjs, with a stream object instead of a Slack SDK.
//
// This script plays BOTH roles in one process (in production they're two machines):
//   • the BRIDGE (the "Home Assistant"): connects to /api and provides a MyStream RpcTarget whose
//     events live in a plain in-memory array HERE — never in a CF DO.
//   • a CONSUMER: a second, ordinary client that calls itx.homeassistant.append/read from anywhere.
//
// Part 1 proves append/read route to the off-platform object (events live in THIS process).
// Part 2 probes the harder case — a live SUBSCRIBE (consumer hands a callback; the box pushes on
// each append). That's the "wake protocol for resumable feeds" territory; if it breaks, the break
// point IS the missing foundation.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_byo${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (label, fn, timeoutMs = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

// ── THE OFF-PLATFORM STREAM (lives on the box; events in a plain array, NOT a CF DO) ──
const pushed = []; // what the box pushed to a live subscriber (recorded for the assertion)
class MyStream extends RpcTarget {
  log = []; // the event log — in THIS process's memory
  #subscribers = [];
  append(...events) {
    const base = this.log.length;
    this.log.push(...events);
    for (const cb of this.#subscribers) for (const e of events) void cb(e); // push to live feeds
    return base; // the first assigned offset
  }
  read(after = 0) {
    return this.log.slice(after);
  }
  subscribe(cb) {
    this.#subscribers.push(cb);
    return { ok: true, from: this.log.length };
  }
}
const myStream = new MyStream();

// ── the bridge (the box) provides the stream; a second client consumes it ──
const boxSession = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const boxItx = await boxSession.authenticate().get();
await boxItx.provideCapability({
  type: "live",
  path: ["homeassistant"],
  capability: myStream,
  instructions: "a bring-your-own stream hosted on the box (test)",
});

const clientSession = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await clientSession.authenticate().get();

// ── Part 1: append + read route to the off-platform object ──
// wait for the mount to be routable (provide → commit → reduce), then append via the DOTTED surface.
await until("homeassistant mount routable", async () => {
  const n = await itx.homeassistant.read(0);
  return Array.isArray(n);
});

const off0 = await itx.homeassistant.append({ type: "motion", room: "kitchen" });
check(
  off0 === 0,
  "itx.homeassistant.append(...) routed to the box (offset 0)",
  JSON.stringify(off0),
);
check(
  myStream.log.length === 1 && myStream.log[0].room === "kitchen",
  "the event landed in the BOX's in-memory array — never a CF DO",
  JSON.stringify(myStream.log[0]),
);

await itx.homeassistant.append({ type: "temp", room: "kitchen", c: 21 });
await itx.homeassistant.append({ type: "motion", room: "hall" });
const readBack = await itx.homeassistant.read(0);
check(
  Array.isArray(readBack) && readBack.length === 3 && readBack[2].room === "hall",
  "a second client reads the box's log back over itx (3 events)",
  JSON.stringify(readBack?.map?.((e) => e.type)),
);
const tail = await itx.homeassistant.read(2);
check(
  Array.isArray(tail) && tail.length === 1 && tail[0].room === "hall",
  "read(after) offset paging works against the off-platform log",
  JSON.stringify(tail),
);

// ── Part 2 (the hard one): a LIVE feed — consumer hands a callback, the box pushes on append ──
// This is the bidirectional case (a stub passed as an ARG, flowing consumer → /api → DO → relay →
// box). If capnweb can't carry the callback across those hops, THIS is the named gap.
const seen = [];
try {
  const sub = await itx.homeassistant.subscribe((e) => {
    seen.push(e);
    pushed.push(e);
  });
  check(
    sub?.ok === true,
    "itx.homeassistant.subscribe(cb) accepted a live callback",
    JSON.stringify(sub),
  );
  await itx.homeassistant.append({ type: "doorbell", room: "porch" });
  const got = await until(
    "the box pushed the live event back to the consumer's callback",
    () => (seen.some((e) => e.type === "doorbell") ? seen : false),
    8000,
  ).catch(() => null);
  check(
    got && got.some((e) => e.type === "doorbell"),
    "LIVE FEED: the box pushed an event to the consumer callback (wake-protocol territory)",
    got ? JSON.stringify(got.map((e) => e.type)) : "no push arrived",
  );
} catch (e) {
  check(false, "LIVE FEED subscribe/push — the named gap", String(e).slice(0, 140));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
