// prove_calllater.mjs — the "get demo → rpc target → callLater(timeoutMs, cb)" shape, live.
// A Demo/Timer capability is provided at itx.demo; a callback passed to callLater fires back
// later in the CALLER's isolate. Proven on BOTH lanes: a plain capnweb client, AND a dynamic
// worker that reaches the scope via `env.ITX.get()` (the WorkerEntrypoint → Itx handoff).
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_calllater${Date.now() % 100000}`;
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

// ── the provider: get demo → Timer with callLater(timeoutMs, cb) ──
class Timer extends RpcTarget {
  callLater(timeoutMs, cb) {
    const run = cb.dup(); // retain past this call (a param stub is disposed when the call returns)
    setTimeout(() => {
      run();
      run[Symbol.dispose]?.();
    }, timeoutMs);
  }
}
class Demo extends RpcTarget {
  get timer() {
    return new Timer();
  }
}

// bridge session provides itx.demo as a LIVE Demo capability.
const bridge = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const bridgeItx = await bridge.authenticate().get();
const provision = await bridgeItx.provideCapability({
  type: "live",
  path: ["demo"],
  capability: new Demo(),
  instructions: "demo/timer/callLater bridge (node script)",
});

// ── lane 1: a plain capnweb client ──
const client = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await client.authenticate().get();
let pinged = false;
await itx.demo.timer.callLater(250, () => {
  pinged = true;
});
await until("capnweb callback fired", async () => pinged || undefined);
check(
  pinged,
  "capnweb client: itx.demo.timer.callLater(cb) — the callback fired back in the client",
);

// ── lane 2: a DYNAMIC WORKER via env.ITX.get() — the callback appends to the stream (observable) ──
const CONSUMER = `
export default async function run(itx) {
  // itx here is env.ITX.get() — the real scope. Plain dotted access; the callback runs back HERE.
  await new Promise((resolve) =>
    itx.demo.timer.callLater(250, async () => {
      await itx.stream.append({ type: 'pinged-from-worker' }); // AWAIT so it lands before we return
      resolve();
    }),
  );
  return { ran: true };
}`;
await itx.invokeCapability({ path: ["kv", "put"], args: ["src/consumer.js", CONSUMER] });
const ran = await itx.runScript("itx.kv.get('src/consumer.js')");
check(
  ran?.ran === true,
  "dynamic worker cap ran to completion (its callback resolved it)",
  JSON.stringify(ran),
);
const got = await until("worker callback appended to the stream", async () => {
  const page = await itx.invokeCapability({ path: ["stream", "read"], args: [0, 500] });
  return page.events.find((e) => e.type === "pinged-from-worker");
});
check(
  !!got,
  "dynamic worker: env.ITX.get().demo.timer.callLater(cb) — the callback ran back inside the worker",
  got?.type,
);

await provision.revoke();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
