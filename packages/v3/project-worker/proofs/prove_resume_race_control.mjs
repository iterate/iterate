// CONTROL for prove_resume_race.mjs: the SAME gated-target failure, but WITHOUT a resume racing
// it. A plain forwarder delivery failure must schedule the retry ladder (~1s backoff) and
// re-deliver within a couple seconds. If this recovers fast but prove_resume_race stalls, the
// resume's rev-bump (suppressing #onDeliveryFailure's retry scheduling) is the proven culprit.
import { newWebSocketRpcSession } from "capnweb";

const BASE = process.env.BASE ?? "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_ctl${Date.now() % 100000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
const keep = [];

let invocations = 0;
const fn = async (events) => {
  invocations++;
  if (invocations === 1) throw new Error("target down (first delivery), no resume in play");
  return { ok: true, offs: events.map((e) => e.offset) };
};

const key = crypto.randomUUID();
keep.push(await itx.rpcStubs.provide(fn, { key }));
await itx.provide({ path: "itx.ctlHook", target: `itx.rpcStubs.get('${key}')` });
await itx.subscribe({ name: "ctl", target: "itx.ctlHook", consumes: ["mark"], start: "beginning" });

await itx.invokeCapability(`itx.stream.append({"type":"mark"})`);
const t0 = Date.now();
while (Date.now() - t0 < 15000 && invocations < 2) await sleep(200);
const ms = Date.now() - t0;
console.log(`control (failure, NO resume): invocations=${invocations} after ${ms}ms`);
console.log(
  invocations >= 2
    ? `PASS  plain failure retried within ${ms}ms (retry ladder works)`
    : `FAIL  plain failure did not retry within 15s`,
);
process.exit(invocations >= 2 ? 0 : 1);
