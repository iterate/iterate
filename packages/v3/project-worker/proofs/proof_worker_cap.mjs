// proof_worker_cap.mjs — DYNAMIC WORKER CODE AS A CAPABILITY (owner's ask, 2026-08-19):
// providing a capability that targets itx.workers.get({source,...}) — stateless run + stateful
// class — and calling RPC methods on it, INCLUDING pipelined deep dotted access where a method
// or getter returns a NESTED RpcTarget (the sub-capability case), not just a plain object.
import { newWebSocketRpcSession } from "capnweb";
const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_wcap${Date.now() % 100000}`;
let failures = 0;
const check = (c, label, detail = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!c) failures++;
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();

// A stateful DO class whose method RETURNS a NESTED RpcTarget (a sub-capability), plus a getter
// returning an object of fns, plus a plain leaf method — the full pipelining surface.
const src = `import { DurableObject, RpcTarget } from "cloudflare:workers";
class Row extends RpcTarget {
  constructor(n) { super(); this.n = n; }
  double() { return this.n * 2; }
  get deep() { return { triple: () => this.n * 3 }; }
}
export class Sheet extends DurableObject {
  async set(n) { await this.ctx.storage.put("n", n); return n; }
  async value() { return (await this.ctx.storage.get("n")) ?? 0; }
  // returns a NESTED RpcTarget — the pipelined-stub case
  async row() { return new Row((await this.ctx.storage.get("n")) ?? 0); }
  get rows() { const self = this; return { at: async (k) => new Row(k) }; }
}`;
await itx.invokeCapability({ path: ["kv", "put"], args: ["src/sheet.js", src] });

// 1. PROVIDE a capability that targets dynamic worker code (stateful class)
await itx.provide({
  path: "itx.sheet",
  target:
    "itx.workers.get({ type: 'stateful', source: \"itx.kv.get('src/sheet.js')\", className: 'Sheet' })",
});
const set = await itx.invokeCapability({ path: ["sheet", "set"], args: [21] });
check(set === 21, "1. provide→stateful worker capability: set(21)", String(set));
const val = await itx.invoke("itx.sheet.value()");
check(val === 21, "2. value() via the expression door", String(val));

// 3. getter returning an object of fns (already works — the baseline)
const tripled = await itx.invoke("itx.sheet.rows.at(5).double()");
check(tripled === 10, "3. getter→object of fns, deep dotted, one shot", String(tripled));

// 4. THE PIPELINING CASE: a method returns a NESTED RpcTarget; call a method ON that
let nested = "";
try {
  const doubled = await itx.invoke("itx.sheet.row().double()");
  check(
    doubled === 42,
    "4. method returns RpcTarget → .double() pipelined through the mount",
    String(doubled),
  );
} catch (e) {
  nested = String(e);
  check(false, "4. method→RpcTarget→.double() pipelined", nested.slice(0, 140));
}

// 5. deeper: nested RpcTarget's own getter returning an object of fns
try {
  const t = await itx.invoke("itx.sheet.row().deep.triple()");
  check(t === 63, "5. method→RpcTarget→getter→fn, all one shot", String(t));
} catch (e) {
  check(false, "5. method→RpcTarget→getter→fn", String(e).slice(0, 140));
}

// 6. stateless run() as a capability (the itx.run thin-wrapper shape)
await itx.invokeCapability({
  path: ["kv", "put"],
  args: [
    "src/greet.js",
    "export default async (itx, who) => `hi ${who} from ${(await itx.whoami()).projectId}`;",
  ],
});
const greeting = await itx.invoke("itx.workers.run(\"itx.kv.get('src/greet.js')\", 'jonas')");
check(
  greeting === `hi jonas from ${CTX}`,
  "6. stateless run() capability with itx callback inside",
  String(greeting),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
