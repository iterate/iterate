// prove_hibernate.mjs — HIBERNATION WITH FACETS e2e: the Stream DO must hibernate (evict +
// reconstruct — incarnation grows) while facet processors are ENABLED (iterate-context + tally +
// user-tally) AND two capnweb clients stay CONNECTED with live capabilities (pagers parked).
// Then the wake path: one client invokes the other's capability through the routing table.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = `prj_hib${Date.now() % 100000}`;
const API = `wss://${BASE}/api?ctx=${CTX}`;

// A client edge socket dying mid-hold (observed at 480s idle: peer close 1006) must FAIL a
// check, not crash the harness — capnweb rethrows peer closes as uncaught exceptions.
process.on("uncaughtException", (e) => console.log(`nonfatal socket error: ${e.message}`));

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const state = async () => await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();
const hold = (ms) => new Promise((r) => setTimeout(r, ms));

class ToolsA extends RpcTarget {
  echo(s) {
    return `echo-A:${s}`;
  }
}
class ToolsB extends RpcTarget {
  echo(s) {
    return `echo-B:${s}`;
  }
}

// two connected clients WITH capabilities → two pagers parked on the DO
const sessionA = newWebSocketRpcSession(API);
const itxA = await sessionA.connect({
  connectionKey: "a",
  description: "hibernate prover A",
  capabilities: new ToolsA(),
});
const sessionB = newWebSocketRpcSession(API);
const itxB = await sessionB.connect({
  connectionKey: "b",
  description: "hibernate prover B",
  capabilities: new ToolsB(),
});

// facet processors enabled (built-in + userspace) + one provide so events exist
await itxA.enableProcessor("tally");
await seedSources(itxA, ["user-tally"]);
await itxA.enableProcessor("user-tally", {
  source: "itx.kv.get('src/user-tally.js')",
  className: "UserTally",
});
await itxA.provide({ path: "itx.hello", target: "itx.kv" });

const s1 = await state();
check(s1.dormant === true, "before hold: DO dormant (no legs held)", JSON.stringify(s1));
check(s1.stubs >= 2, "before hold: both client pagers parked", `stubs=${s1.stubs}`);
check(
  Array.isArray(s1.facetProcessors) &&
    s1.facetProcessors.includes("tally") &&
    s1.facetProcessors.includes("user-tally"),
  "before hold: facet processors listed",
  JSON.stringify(s1.facetProcessors),
);
console.log(`incarnation before hold: ${s1.incarnation}`);

// HOLD with the capnweb sockets kept OPEN — NO DO traffic. `session.get()` is pure addressing
// (constructs an Itx around the already-resolved DO stub, zero RPC to the DO), so it keeps the
// EDGE WebSocket + relay isolate alive (Cloudflare recycles idle stateless-worker sockets —
// observed: peer close 1006 after ~5-8min idle, which drops the parked stubs with the relay)
// while the DO itself stays untouched and free to hibernate.
const HOLD_MS = Number(process.env.HOLD_MS ?? 240_000);
const ROUNDS = Number(process.env.ROUNDS ?? 2);
// KEEPALIVE FINDING (runs 4+5): ANY client→edge capnweb traffic during the hold — even the
// pure-addressing `session.get()` that never RPCs the DO — correlated with the DO NEVER being
// evicted (0/4 windows with keepalive vs 4/5 without, ≥300s). So the hold is PURE client-side
// no-op, exactly the spec: sockets open, zero traffic anywhere.
const keepalive = setInterval(() => {}, 30_000);
let s2 = s1;
let grew = false;
for (let round = 1; round <= ROUNDS && !grew; round++) {
  console.log(`holding ${HOLD_MS / 1000}s with sockets open (round ${round})…`);
  await hold(HOLD_MS);
  s2 = await state();
  console.log(
    `after round ${round}: incarnation=${s2.incarnation} stubs=${s2.stubs} dormant=${s2.dormant}`,
  );
  grew = s2.incarnation > s1.incarnation;
}
clearInterval(keepalive);

check(
  grew,
  "DO hibernated + reconstructed during hold (incarnation grew, facets enabled, clients connected)",
  `${s1.incarnation} → ${s2.incarnation}`,
);
check(s2.stubs >= 2, "stubs still parked after hibernation", `stubs=${s2.stubs}`);

// the wake path after hibernation-with-facets: one client invokes the OTHER's live capability
// through the table (two-sided: if one edge socket died during the hold, try the other way).
let echoed = await itxA
  .invoke("itx.connections.get('b').echo('after-hibernate')")
  .catch((e) => String(e));
let wakeDetail = `A→B: ${JSON.stringify(echoed)}`;
let wakeOk = echoed === "echo-B:after-hibernate";
if (!wakeOk) {
  const alt = await itxB
    .invoke("itx.connections.get('a').echo('after-hibernate')")
    .catch((e) => String(e));
  wakeDetail += `; B→A: ${JSON.stringify(alt)}`;
  wakeOk = alt === "echo-A:after-hibernate";
}
check(
  wakeOk,
  "post-hibernation: one client invokes the other's capability (page → stub → invoke)",
  wakeDetail,
);

// and the facets themselves survived: fold state rebuilt from durable identity + the log
const snap = await itxB.facetSnapshot("tally");
check(
  snap.state?.counts?.["events.iterate.com/capability-table/capability-provided"] === 1 &&
    snap.offset >= 1,
  "post-hibernation: facet snapshot still folds (rebuilt from durable identity)",
  JSON.stringify(snap),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
