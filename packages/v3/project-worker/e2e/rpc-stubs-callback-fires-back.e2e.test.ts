// rpc-stubs-callback-fires-back.e2e.test.ts — the "get demo → rpc target → callLater(timeoutMs, cb)"
// shape, live.
// A Demo/Timer RpcTarget is provided under itx.demo (rewrite rule at the same spelling); a callback
// passed to callLater fires back later in the CALLER's isolate. Proven on BOTH lanes: a plain capnweb
// client, AND a dynamic worker that reaches the scope via `env.ITX.get()` (the WorkerEntrypoint →
// IterateContext handoff).

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";

// ── the provider: get demo → Timer with callLater(timeoutMs, cb) ──
class Timer extends RpcTarget {
  callLater(timeoutMs: number, cb: (() => void) & { dup(): () => void }) {
    const run = cb.dup(); // retain past this call (a param stub is disposed when the call returns)
    setTimeout(() => {
      run();
      (run as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    }, timeoutMs);
  }
}
class Demo extends RpcTarget {
  get timer() {
    return new Timer();
  }
}

test("callLater(cb) fires back in the caller — capnweb client AND dynamic worker lanes", async () => {
  const ctx = freshCtx("calllater");

  // bridge session provides a LIVE Demo under itx.demo, rule itx.demo ⇒ itx.rpcStubs.get('itx.demo').
  const bridgeItx = openItx(ctx);
  const demo = await bridgeItx.provide("itx.demo", new Demo());

  // ── lane 1: a plain capnweb client ──
  const itx = openItx(ctx);
  let pinged = false;
  await itx.demo.timer.callLater(250, () => {
    pinged = true;
  });
  await until("capnweb callback fired", () => pinged);
  // capnweb client: itx.demo.timer.callLater(cb) — the callback fired back in the client
  expect(pinged).toBe(true);

  // ── lane 2: a DYNAMIC WORKER via env.ITX.get() — the callback appends to the stream (observable) ──
  const CONSUMER = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Consumer extends WorkerEntrypoint {
  async run() {
    // env.ITX.get() is the real scope. Plain dotted access; the callback runs back HERE.
    const itx = await this.env.ITX.get();
    await new Promise((resolve) =>
      itx.demo.timer.callLater(250, async () => {
        await itx.append({ type: 'pinged-from-worker' }); // AWAIT so it lands before we return
        resolve();
      }),
    );
    return { ran: true };
  }
}`;
  await itx.invoke(["itx", "kv", ["put", "src/consumer.js", CONSUMER]]);
  const ran = await itx.load("itx.kv.get('src/consumer.js')").getEntrypoint().run();
  // dynamic worker cap ran to completion (its callback resolved it)
  expect(ran?.ran).toBe(true);
  const got = await until("worker callback appended to the stream", async () => {
    const page = await itx.invoke(["itx", ["read", 0, 500]]);
    return page.events.find((e: { type: string }) => e.type === "pinged-from-worker");
  });
  // dynamic worker: env.ITX.get().demo.timer.callLater(cb) — the callback ran back inside the worker
  expect(got).toBeTruthy();

  demo[Symbol.dispose](); // recall the stub and un-set its rule
});
