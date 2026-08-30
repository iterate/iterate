// prove_load.mjs — itx.load(ref): the ONE loaded-code door over workers+facets. Stateless
// WorkerEntrypoint, durable-object-as-a-facet, NAMED durable instances, and address-by-name.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_load${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const itx = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`).authenticate().get();

// seed the two sources into kv
await itx.invokeCapability({
  path: ["kv", "put"],
  args: ["src/greet.js", "export default (itx, name) => `hi ${name}`;"],
});
await itx.invokeCapability({
  path: ["kv", "put"],
  args: [
    "src/counter.js",
    `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
  async value() { return (await this.ctx.storage.get('n')) ?? 0; }
}`,
  ],
});

// 1. STATELESS: a WorkerEntrypoint (default export), run it.
const g = await itx.invoke(`itx.load({source:"itx.kv.get('src/greet.js')"}).run('jonas')`);
check(g === "hi jonas", "load({source}).run() — stateless worker", String(g));

// 2. DURABLE NAMED: a DurableObject hosted as a facet named 'c1' — state persists across calls.
await itx.invoke(
  `itx.load({source:"itx.kv.get('src/counter.js')",className:'Counter',name:'c1'}).bump()`,
);
const two = await itx.invoke(
  `itx.load({source:"itx.kv.get('src/counter.js')",className:'Counter',name:'c1'}).bump()`,
);
check(two === 2, "load({source,className,name}).bump() — durable facet keeps state", String(two));

// 3. ADDRESS BY NAME: load({name:'c1'}) reaches the SAME instance with NO source (via the registration).
const val = await itx.invoke(`itx.load({name:'c1'}).value()`);
check(val === 2, "load({name}) addresses the named durable instance", String(val));

// 4. a DIFFERENT name is INDEPENDENT state.
const other = await itx.invoke(
  `itx.load({source:"itx.kv.get('src/counter.js')",className:'Counter',name:'c2'}).bump()`,
);
check(other === 1, "load({name:'c2'}) is independent state", String(other));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
