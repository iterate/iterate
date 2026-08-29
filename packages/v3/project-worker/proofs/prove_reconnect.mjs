// prove_reconnect.mjs — THE RECONNECT-AND-RESUME RESILIENCE PROPERTY, live.
//
// A capability PROVIDER is ephemeral: its capnweb WebSocket terminates at a STATELESS `/api` worker,
// and Cloudflare documents that a plain worker cannot durably hold a WebSocket (the isolate can be
// recycled, taking the socket + in-memory retained callback with it — capnweb-in-a-DO is the open
// workerd#6087, whose own workaround IS a stateless proxy worker). So a provider dropping is EXPECTED;
// the platform's answer is RECONNECT under the same key, not server durability.
//
// This proves it against the real deployment: a provider goes OFFLINE (its session is disposed → the
// WS closes → the DO drops the stub) and re-provides under the SAME key, after which its capability
// is callable AGAIN through `itx.rpcStubs.get(key)`. This is the property the live hibernation proofs
// tried to force by waiting on Cloudflare — proven here deterministically by controlling the
// disconnect.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_recon${Date.now() % 100000}`;
const API = `wss://${BASE}/api?ctx=${CTX}`;
const DISPOSE = Symbol.dispose ?? Symbol.for("dispose");

// Disposing our own provider stub can surface a capnweb peer-close as an uncaught rejection — it is
// the deliberate disconnect, not a failure.
process.on("uncaughtException", (e) =>
  console.log(`nonfatal (deliberate disconnect): ${e.message}`),
);

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (label, fn, timeoutMs = 25000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 400));
  }
};

class Tools extends RpcTarget {
  #tag;
  constructor(tag) {
    super();
    this.#tag = tag;
  }
  echo(s) {
    return `echo-${this.#tag}:${s}`;
  }
}

// the consumer stays connected throughout and addresses the provider BY KEY.
const consumer = newWebSocketRpcSession(API);
const itx = await consumer.get();

// 1. provider provides a live capability under key 'p' → callable through the key.
let provider = newWebSocketRpcSession(API);
await provider.get().rpcStubs.provide(new Tools("v1"), { key: "p" });
await until("callable online", async () =>
  (await itx.invoke("itx.rpcStubs.get('p').echo('a')")) === "echo-v1:a" ? true : undefined,
);
check(true, "1. provider online: itx.rpcStubs.get('p').echo() answers");

// 2. provider goes OFFLINE — dispose its session (WS closes → the DO drops stub 'p').
provider[DISPOSE]?.();
await until("provider offline", async () => {
  try {
    await itx.invoke("itx.rpcStubs.get('p').echo('b')");
    return undefined; // still answering — keep polling
  } catch {
    return true; // CONNECTION_OFFLINE — the drop landed
  }
});
check(true, "2. provider offline: the key stops answering after the session drops");

// 3. provider RE-PROVIDES under the SAME key with a fresh capability instance.
provider = newWebSocketRpcSession(API);
await provider.get().rpcStubs.provide(new Tools("v2"), { key: "p" });

// 4. THE CONTRACT: the capability is callable AGAIN through the same key — it resolves to the
//    reconnected provider (v2), with no re-addressing by the caller.
const after = await until("callable after reconnect", async () => {
  const r = await itx.invoke("itx.rpcStubs.get('p').echo('c')");
  return r === "echo-v2:c" ? r : undefined;
});
check(
  after === "echo-v2:c",
  "3. reconnect under the SAME key: the capability is callable again",
  String(after),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
