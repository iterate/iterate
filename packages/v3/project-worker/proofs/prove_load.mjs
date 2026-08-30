// prove_load.mjs — itx.load(source): the Worker-Loader mirror. Load code → a WORKER, then pick the
// host EXPLICITLY, the two accessors Cloudflare exposes: `.getEntrypoint()` (stateless
// WorkerEntrypoint) and `.getDurableObjectClass(name).get(instance?)` (a DurableObject hosted as a
// durable facet). Plus `itx.facets.get(name)` — the separate address-a-RUNNING-facet door.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_load${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const itx = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`).authenticate().get();

// seed the two sources into kv — each EXPORTS its host object (the new contract): a WorkerEntrypoint
// or a DurableObject class. No host-injected wrapper.
await itx.invokeCapability([
  "itx",
  "kv",
  [
    "put",
    "src/greet.js",
    `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Greeter extends WorkerEntrypoint {
  async run(name) { return \`hi \${name}\`; }
}`,
  ],
]);
await itx.invokeCapability([
  "itx",
  "kv",
  [
    "put",
    "src/counter.js",
    `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
  async value() { return (await this.ctx.storage.get('n')) ?? 0; }
}`,
  ],
]);

const SRC_GREET = `"itx.kv.get('src/greet.js')"`;
const SRC_COUNTER = `"itx.kv.get('src/counter.js')"`;

// 1. STATELESS: load → getEntrypoint() → a WorkerEntrypoint isolate, run it.
const g = await itx.invokeCapability(`itx.load(${SRC_GREET}).getEntrypoint().run('jonas')`);
check(g === "hi jonas", "load(src).getEntrypoint().run() — stateless WorkerEntrypoint", String(g));

// 2. DURABLE NAMED: load → getDurableObjectClass('Counter').get('c1') → a facet named 'c1' whose
//    state persists across calls.
await itx.invokeCapability(
  `itx.load(${SRC_COUNTER}).getDurableObjectClass('Counter').get('c1').bump()`,
);
const two = await itx.invokeCapability(
  `itx.load(${SRC_COUNTER}).getDurableObjectClass('Counter').get('c1').bump()`,
);
check(
  two === 2,
  "load(src).getDurableObjectClass('Counter').get('c1').bump() — durable facet keeps state",
  String(two),
);

// 3. ADDRESS BY NAME: itx.facets.get('c1') reaches the SAME running instance with NO source (via the
//    durable registration the .get('c1') materialization wrote).
const val = await itx.invokeCapability(`itx.facets.get('c1').value()`);
check(val === 2, "itx.facets.get('c1') addresses the named durable instance", String(val));

// 4. a DIFFERENT instance name is INDEPENDENT state.
const other = await itx.invokeCapability(
  `itx.load(${SRC_COUNTER}).getDurableObjectClass('Counter').get('c2').bump()`,
);
check(other === 1, "get('c2') is independent state", String(other));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
