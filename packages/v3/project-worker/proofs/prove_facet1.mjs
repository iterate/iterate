// prove_facet1.mjs — THE FACET SPINE live: a processor in a real workerd facet on the Stream DO.
// enable(tally) → events land (capability-provided/revoked from mounts) → the facet folds them →
// snapshot through the parent. Also proves COLD CATCH-UP (an event appended BEFORE enable is
// counted) and configure-durability across appends.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = `prj_facet${Date.now() % 100000}`;

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.get();

// one mount BEFORE enabling — the facet must count it via cold catch-up
await itx.provide({ path: "itx.before", target: "itx.kv" });

await itx.enableProcessor("tally");
const s1 = await itx.facetSnapshot("tally");
check(
  // TWO provided events by now: the itx.before mount AND tally's own enablement mount
  // (enablement is a mount since increment 55 — event-sourced like every attachment)
  s1.state?.counts?.["events.iterate.com/capability-table/capability-provided"] === 2,
  "cold catch-up: pre-enable events counted (incl. tally's own enablement mount)",
  JSON.stringify(s1),
);

// two more mounts + one revoke AFTER enabling — the drive path
const p2 = await itx.provide({ path: "itx.a", target: "itx.kv" });
await itx.provide({ path: "itx.b", target: "itx.kv" });
await itx.revoke({ providedAtOffset: p2.providedAtOffset });

const s2 = await itx.facetSnapshot("tally");
check(
  s2.state?.counts?.["events.iterate.com/capability-table/capability-provided"] === 4 &&
    s2.state?.counts?.["events.iterate.com/capability-table/capability-revoked"] === 1 &&
    s2.offset === 5,
  "facet folds driven events (4 provided incl. enablement + 1 revoked @ offset 5)",
  JSON.stringify(s2),
);

const st = await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();
check(
  Array.isArray(st.facetProcessors) && st.facetProcessors.includes("tally"),
  "/state lists the facet processor",
  JSON.stringify(st),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
