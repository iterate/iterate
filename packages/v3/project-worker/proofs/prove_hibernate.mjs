// prove_hibernate.mjs — REAL Cloudflare DO HIBERNATION, survived by a RECONNECTING client. SLOW.
//
// ⚠️ SLOW + OPT-IN — not on the fast reliable board. It waits out a REAL idle hibernation window
// (~120s), so run it deliberately (a nightly/slow lane), not on every change. The DETERMINISTIC,
// ~2s proof of the same durable-rebuild property is __workers-tests__/hibernation-at-scale.test.ts
// (cloudflare:test evictDurableObject). This proof adds what the harness CANNOT: that the property
// holds against the REAL edge, and that a client which loses its socket during the idle RECOVERS by
// reconnecting under the same key.
//
// WHY A RECONNECTING CLIENT MAKES THIS RELIABLE (the old version was flaky and couldn't be fixed):
// the client capnweb WS terminates at a STATELESS `/api` worker, and a plain worker cannot durably
// hold a WebSocket — Cloudflare recycles the isolate opportunistically (capnweb-in-a-DO is the open
// workerd#6087, whose own workaround IS a stateless proxy worker). So during a multi-minute idle the
// provider/consumer sockets MAY drop. The old proof treated that as failure; the correct design
// treats it as EXPECTED and RECOVERS — the connectionKey is durable, so the provider reconnects
// under the same key and its capability is reachable again. That is the production contract.
//
// WHAT IT PROVES: after the DO hibernates (in-memory state wiped, constructor re-runs on wake),
//   (1) the durable log rebuilds — a NEW incarnation writes ⇒ /state incarnation GREW across the
//       idle (the hibernation tell — StreamEventLog bumps incarnation once per incarnation-that-writes);
//   (2) a facet processor still folds (rebuilt from the durable log);
//   (3) the client capability is callable again — reconnecting under the same key if the socket dropped.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_hib${Date.now() % 100000}`;
const API = `wss://${BASE}/api?ctx=${CTX}`;
const IDLE_MS = Number(process.env.IDLE_MS ?? 120_000); // > the ~70s hibernation window for this DO
const DISPOSE = Symbol.dispose ?? Symbol.for("dispose");

// A socket dropping mid-idle surfaces as a capnweb peer-close (uncaught) — it is EXPECTED here, the
// very thing the reconnect recovers from, never a failure.
process.on("uncaughtException", (e) =>
  console.log(`nonfatal (socket dropped mid-idle): ${e.message}`),
);

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (label, fn, timeoutMs = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
const stateOf = async () => await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();

class Tools extends RpcTarget {
  echo(s) {
    return `echo:${s}`;
  }
}

// (re)establish the provider under the durable key 'p' with its capability.
const connectProvider = async () => {
  const s = newWebSocketRpcSession(API);
  await s.get().rpcStubs.provide(new Tools(), { key: "p" });
  return s;
};
// a fresh consumer socket (never reuse one across the idle — it may have been recycled).
const freshConsumer = () => newWebSocketRpcSession(API).get();

// ── setup: provider + consumer + a facet processor + a durable write to fix the baseline ──
let provider = await connectProvider();
let itx = await freshConsumer();
await itx.enableProcessor("tally"); // a built-in facet processor whose fold must survive reconstruction
await itx.invokeCapability(["itx", "stream", ["append", { type: "mark", n: 0 }]]);
await until("provider online before idle", async () =>
  (await itx.invokeCapability("itx.rpcStubs.get('p').echo('a')")) === "echo:a" ? true : undefined,
);
const base = await stateOf();
check(base.stubs >= 1, "before idle: provider pager parked", `stubs=${base.stubs}`);
console.log(`baseline incarnation=${base.incarnation}, idling ${IDLE_MS / 1000}s (ZERO traffic)…`);

// ── the idle: NO traffic of any kind (any client→edge call keeps the DO warm and blocks hibernation).
// Sockets may silently drop; we do not poll. ──
await new Promise((r) => setTimeout(r, IDLE_MS));

// ── wake with a RECONNECTING client ──
// A fresh consumer + a durable write: the write wakes the DO, and if it hibernated this is the first
// write of a NEW incarnation, which bumps the durable incarnation counter.
itx = await freshConsumer();
await itx.invokeCapability(["itx", "stream", ["append", { type: "mark", n: 1 }]]);

// The capability, reconnecting the provider under the SAME key if it dropped during the idle.
let reconnected = false;
const echoed = await until("capability callable after wake (reconnect if needed)", async () => {
  try {
    const r = await itx.invokeCapability("itx.rpcStubs.get('p').echo('c')");
    return r === "echo:c" ? r : undefined;
  } catch {
    // provider socket dropped during the idle → reconnect under the same key and let the next poll retry
    provider = await connectProvider();
    reconnected = true;
    return undefined;
  }
});
check(
  echoed === "echo:c",
  `capability callable after hibernation${reconnected ? " (provider reconnected under same key)" : " (provider socket survived)"}`,
  String(echoed),
);

// (1) the DO hibernated + reconstructed: a new incarnation wrote ⇒ incarnation grew across the idle.
const after = await stateOf();
check(
  after.incarnation > base.incarnation,
  "DO hibernated + reconstructed during the idle (incarnation grew)",
  `${base.incarnation} → ${after.incarnation}`,
);

// (2) the facet fold survived reconstruction (rebuilt from the durable log).
const snap = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
check(
  snap?.offset >= 1 && snap?.state?.counts,
  "facet snapshot still folds after reconstruction (rebuilt from durable identity)",
  JSON.stringify(snap?.state?.counts ?? snap),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
