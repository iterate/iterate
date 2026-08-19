// prove_userfacet.mjs — USERSPACE facet processors live: a loader-loaded DurableObject class
// (duck-typed configure/deliver/snapshot) hosted as a workerd facet on the Stream DO, side by
// side with the built-in tally facet. enable(user-tally via source expression) + enable(tally)
// → 2 provides + 1 revoke → both facets fold identically (counts + own cursor at offset 3).
import { newWebSocketRpcSession } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = `prj_ufacet${Date.now() % 100000}`;

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.get();
await seedSources(itx, ["user-tally"]);

// enable the USERSPACE processor (class arrives via the loader from a source expression),
// and the BUILT-IN tally alongside it
await itx.enableProcessor("user-tally", {
  source: "itx.kv.get('src/user-tally.js')",
  export: "UserTally",
});
await itx.enableProcessor("tally");

// 2 provides + 1 revoke → offsets 1..3
const p1 = await itx.provide({ path: "itx.a", target: "itx.kv" });
await itx.provide({ path: "itx.b", target: "itx.kv" });
await itx.revoke({ providedAtOffset: p1.providedAtOffset });

const PROVIDED = "events.iterate.com/capability-table/capability-provided";
const REVOKED = "events.iterate.com/capability-table/capability-revoked";

const su = await itx.facetSnapshot("user-tally");
check(
  // 4 provided: the two enablement mounts (user-tally, tally) + the two test mounts
  su.state?.counts?.[PROVIDED] === 4 && su.state?.counts?.[REVOKED] === 1 && su.offset === 5,
  "USERSPACE facet folds (4 provided incl. enablements + 1 revoked @ own cursor 5)",
  JSON.stringify(su),
);

const sb = await itx.facetSnapshot("tally");
check(
  sb.state?.counts?.[PROVIDED] === 4 && sb.state?.counts?.[REVOKED] === 1 && sb.offset === 5,
  "BUILT-IN tally still works side-by-side (same reduce @ offset 5)",
  JSON.stringify(sb),
);

const st = await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();
check(
  Array.isArray(st.facetProcessors) &&
    st.facetProcessors.includes("user-tally") &&
    st.facetProcessors.includes("tally"),
  "/state lists both facet processors",
  JSON.stringify(st.facetProcessors),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
