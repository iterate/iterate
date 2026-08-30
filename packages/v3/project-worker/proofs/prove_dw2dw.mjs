// prove_dw2dw.mjs — DYNAMIC WORKER → DYNAMIC WORKER mid-chain pipelining, live.
//
// Worker A is a STATEFUL dynamic-worker DO whose getter chain returns nested RpcTargets:
//   get demo → Demo, get timer → Timer, timer.callLater(ms, cb).
// Worker B is a SECOND dynamic worker (a stateless code cap) that reaches A THROUGH ITS OWN
// `env.ITX.get()` and writes the natural dotted chain:
//   itx.load(src).getDurableObjectClass('Counter').get().demo.timer.callLater(ms, cb)
// The mid-path load→class→instance returns HANDLES that B then walks `.demo.timer.callLater`
// on — the case that only pipelines because each handle is a genuine, branded RpcTarget
// (core/invoke-handle.ts) and not a bare Proxy (NonPipelinable over Workers RPC, workerd#6873).
// The callback B passes rides the membrane the other way and fires back INSIDE B.
//
// Proven on BOTH consumer lanes: a plain capnweb client, AND worker B via env.ITX.get().
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_dw2dw${Date.now() % 100000}`;
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
    await new Promise((r) => setTimeout(r, 400));
  }
};

// ── worker A: a stateful DO with a getter chain that bottoms out at callLater(ms, cb) ──
const WORKER_A = `
import { DurableObject, RpcTarget } from "cloudflare:workers";
class Timer extends RpcTarget {
  async callLater(ms, cb) {
    const run = cb.dup();                       // retain past this call (a param stub is disposed on return)
    await new Promise((r) => setTimeout(r, ms));
    await run();                                // fire back in the CALLER; awaited so this facet stays alive
    run[Symbol.dispose]?.();
  }
}
class Demo extends RpcTarget {
  get timer() { return new Timer(); }
}
export class Counter extends DurableObject {
  get demo() { return new Demo(); }
}
export default Counter;`;

// ── worker B: reaches A via env.ITX.get() and writes the natural mid-chain dotted call ──
const WORKER_B = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class ConsumerB extends WorkerEntrypoint {
  async run(aRef) {
    // env.ITX.get() is the real scope. load(src).getDurableObjectClass(c).get() is a mid-chain
    // HANDLE; the getter chain .demo.timer and terminal .callLater(ms, cb) pipeline onto it natively
    // — three consecutive stub-returning calls over Workers RPC, the deepest pipelining case.
    const itx = await this.env.ITX.get();
    let pinged = false;
    await itx.load(aRef.source).getDurableObjectClass(aRef.className).get()
      .demo.timer.callLater(200, () => { pinged = true; });
    if (pinged) await itx.stream.append({ type: 'pinged-from-A-via-B' }); // observable at the client
    return { ran: true, pinged };
  }
}`;

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();

await itx.invokeCapability({ path: ["kv", "put"], args: ["src/counterA.js", WORKER_A] });
await itx.invokeCapability({ path: ["kv", "put"], args: ["src/consumerB.js", WORKER_B] });

// aRef names worker A's stateful class: a source EXPRESSION + the exported className. load(source)
// .getDurableObjectClass(className).get() loads the class and materializes it as a facet.
const aRef = { source: "itx.kv.get('src/counterA.js')", className: "Counter" };

// ── lane 1: a plain capnweb client walks the mid-chain and the callback fires back HERE ──
let clientPinged = false;
await itx
  .load(aRef.source)
  .getDurableObjectClass(aRef.className)
  .get()
  .demo.timer.callLater(200, () => {
    clientPinged = true;
  });
await until("capnweb client callback fired", async () => clientPinged || undefined);
check(
  clientPinged,
  "capnweb client: load(aRef).getDurableObjectClass.get().demo.timer.callLater(cb) — callback fired back in the client",
);

// ── lane 2: worker B reaches worker A via env.ITX.get() — the dynamic-worker → dynamic-worker case ──
const ran = await itx.load("itx.kv.get('src/consumerB.js')").getEntrypoint().run(aRef);
check(
  ran?.ran === true && ran?.pinged === true,
  "dynamic worker B: env.ITX.get().load(...).getDurableObjectClass(...).get().demo.timer.callLater(cb) ran and the callback fired inside B",
  JSON.stringify(ran),
);
const got = await until("worker B's callback appended to the stream", async () => {
  const page = await itx.invokeCapability({ path: ["stream", "read"], args: [0, 500] });
  return page.events.find((e) => e.type === "pinged-from-A-via-B");
});
check(
  !!got,
  "dynamic worker B: the callback effect (stream append) is observable at the client",
  got?.type,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
