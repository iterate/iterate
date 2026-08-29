// prove_hibernate3.mjs — HIBERNATION WITH FACETS e2e, 3-client variant. Same proof as
// prove_hibernate.mjs, but with THREE connected clients so the post-hibernation cross-client
// invoke can run between whichever two survived the hold (workers.dev recycles idle stateless
// edge isolates on the same timescale as actor eviction, killing that relay's client socket AND
// its pager — observed ~50% per ~340s idle, always alongside an eviction window).
//
// ⚠️ INHERENTLY UNRELIABLE — NOT part of the reliable board (same CF-eviction-vs-socket-recycle
// tension as prove_hibernate.mjs; see its header). The deterministic proof is
// __workers-tests__/hibernation-at-scale.test.ts (evictDurableObject). Run this manually.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = `prj_hib3${Date.now() % 100000}`;
const API = `wss://${BASE}/api?ctx=${CTX}`;

process.on("uncaughtException", (e) => console.log(`nonfatal socket error: ${e.message}`));

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const state = async () => await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();
const hold = (ms) => new Promise((r) => setTimeout(r, ms));

const makeTools = (name) =>
  new (class extends RpcTarget {
    echo(s) {
      return `echo-${name}:${s}`;
    }
  })();

const NAMES = ["a", "b", "c"];
const clients = {};
for (const n of NAMES) {
  const session = newWebSocketRpcSession(API);
  clients[n] = await session.connect({
    connectionKey: n,
    description: `hibernate prover ${n}`,
    capabilities: makeTools(n.toUpperCase()),
  });
}

await clients.a.enableProcessor("tally");
await seedSources(clients.a, ["user-tally"]);
await clients.a.enableProcessor("user-tally", {
  source: "itx.kv.get('src/user-tally.js')",
  className: "UserTally",
});
await clients.a.provide({ path: "itx.hello", target: "itx.kv" });

const s1 = await state();
check(s1.dormant === true, "before hold: DO dormant (no legs held)", JSON.stringify(s1));
check(s1.stubs >= 3, "before hold: all three client pagers parked", `stubs=${s1.stubs}`);
check(
  ["tally", "user-tally"].every((x) => s1.facetProcessors?.includes(x)),
  "before hold: the enabled facet processors are listed",
  JSON.stringify(s1.facetProcessors),
);
console.log(`incarnation before hold: ${s1.incarnation}`);

// PURE no-op client-side keepalive — zero traffic anywhere (any client→edge traffic, even
// DO-free addressing calls, kept the actor warm: 0/4 evictions with keepalive vs 4+/6 without).
const HOLD_MS = Number(process.env.HOLD_MS ?? 340_000);
const ROUNDS = Number(process.env.ROUNDS ?? 2);
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
check(s2.stubs >= 2, "stubs still parked after hibernation (≥2 of 3)", `stubs=${s2.stubs}`);

// wake path: invoke one surviving client's capability FROM another surviving client
let wakeOk = false;
const attempts = [];
outer: for (const caller of NAMES) {
  for (const target of NAMES) {
    if (caller === target) continue;
    const res = await clients[caller]
      .invoke(`itx.connections.get('${target}').echo('after-hibernate')`)
      .catch((e) => String(e));
    attempts.push(`${caller}→${target}: ${JSON.stringify(res)}`);
    if (res === `echo-${target.toUpperCase()}:after-hibernate`) {
      wakeOk = true;
      break outer;
    }
  }
}
check(
  wakeOk,
  "post-hibernation: one client invokes another's capability (page → stub → invoke)",
  attempts.join("; "),
);

const snap = await clients.a
  .facetSnapshot("tally")
  .catch(() => clients.b.facetSnapshot("tally").catch(() => clients.c.facetSnapshot("tally")));
check(
  snap?.state?.counts?.["events.iterate.com/capability-table/capability-provided"] >= 1 &&
    snap?.offset >= 1,
  "post-hibernation: facet snapshot still folds (rebuilt from durable identity)",
  JSON.stringify(snap),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
