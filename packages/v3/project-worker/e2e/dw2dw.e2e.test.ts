// dw2dw.e2e.test.ts — DYNAMIC WORKER → DYNAMIC WORKER mid-chain pipelining, live.
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
// (was proofs/prove_dw2dw.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";

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

test("dynamic worker → dynamic worker mid-chain pipelining, both consumer lanes", async () => {
  const itx = openItx(freshCtx("dw2dw"));

  await itx.invokeCapability(["itx", "kv", ["put", "src/counterA.js", WORKER_A]]);
  await itx.invokeCapability(["itx", "kv", ["put", "src/consumerB.js", WORKER_B]]);

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
  await until("capnweb client callback fired", () => clientPinged, 30_000);
  // capnweb client: load(aRef).getDurableObjectClass.get().demo.timer.callLater(cb) — callback fired back in the client
  expect(clientPinged).toBe(true);

  // ── lane 2: worker B reaches worker A via env.ITX.get() — the dynamic-worker → dynamic-worker case ──
  const ran = await itx.load("itx.kv.get('src/consumerB.js')").getEntrypoint().run(aRef);
  // dynamic worker B: env.ITX.get().load(...).getDurableObjectClass(...).get().demo.timer.callLater(cb) ran and the callback fired inside B
  expect(ran?.ran).toBe(true);
  expect(ran?.pinged).toBe(true);

  const got = await until(
    "worker B's callback appended to the stream",
    async () => {
      const page = await itx.invokeCapability(["itx", "stream", ["read", 0, 500]]);
      return page.events.find((e: { type: string }) => e.type === "pinged-from-A-via-B");
    },
    30_000,
  );
  // dynamic worker B: the callback effect (stream append) is observable at the client
  expect(got).toBeTruthy();
});
