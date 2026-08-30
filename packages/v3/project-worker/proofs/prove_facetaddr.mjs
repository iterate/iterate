// prove_facetaddr.mjs — the facet ADDRESS: any facet method through the routing table,
// aliasable/shadowable; the barrier verb rides the same address.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_addr${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
await itx.enableProcessor("tally");
await itx.invoke(`itx.stream.append({ type: 'mark' })`);

// 1. a facet method through the SEEDED address
const snap = await itx.invoke(`itx.facets.get('tally').snapshot()`);
check(
  snap?.state?.counts?.mark === 1,
  "itx.facets.get('tally').snapshot() through the table",
  JSON.stringify(snap),
);

// 1b. itx.stream.processors.get(...) is THIN SUGAR over itx.facets.get(...) — same reduce.
const viaProcessors = await itx.invoke(`itx.stream.processors.get('tally').snapshot()`);
check(
  viaProcessors?.state?.counts?.mark === 1,
  "itx.stream.processors.get('tally') is thin sugar over itx.facets.get",
  JSON.stringify(viaProcessors),
);

// 2. the barrier verb through the same address
await itx.invoke(`itx.facets.get('tally').waitUntilProcessed({ offset: 1, timeoutMs: 5000 })`);
check(true, "waitUntilProcessed rides the facet address");

// 3. userspace ALIAS + shadow-stack (the address is an ordinary capability)
const prov = await itx.provide({ path: "itx.counts", target: "itx.facets.get('tally')" });
const aliased = await itx.invokeCapability({ path: ["counts", "snapshot"], args: [] });
check(
  aliased?.state?.counts?.mark === 1,
  "aliased facet address via the dotted door",
  JSON.stringify(aliased?.state),
);
await itx.revoke(prov);

// 4. the facets.get(slug).snapshot() address still answers
const sugar = await itx.invoke("itx.facets.get('tally').snapshot()");
check(
  sugar?.state?.counts?.mark === 1,
  "facets.get(slug).snapshot() rides the address",
  JSON.stringify(sugar?.state),
);

// 5. probe-resistance carries over: inherited built-ins unreachable on the facet
let denied = "";
try {
  await itx.invoke(`itx.facets.get('tally').toString()`);
} catch (e) {
  denied = String(e);
}
check(
  /is not a method/.test(denied),
  "inherited built-ins unreachable through the address",
  denied.slice(0, 70),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
