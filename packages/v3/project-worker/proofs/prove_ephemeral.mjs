// prove_ephemeral.mjs — the ephemeral lane, live: shared offsets, named-type opt-in,
// "*" never sweeps, appends through the routing table (itx.stream.append).
import { newWebSocketRpcSession } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_eph${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const cap = async (expr) => {
  const r = await fetch(`https://${BASE}/cap?ctx=${CTX}&cap=${encodeURIComponent(expr)}`);
  return { status: r.status, text: await r.text() };
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
await seedSources(itx, ["chunky"]);

// 1. enable the userspace ephemeral consumer + the built-in "*" tally
await itx.enableProcessor("chunky", { source: "itx.kv.get('src/chunky.js')", export: "Chunky" });
await itx.enableProcessor("tally");

// 2. durable mark, three ephemeral chunks, another durable mark — all through the table
const mark = await itx.invoke(`itx.stream.append({ type: 'mark' })`);
check(
  Array.isArray(mark) && mark[0]?.offset >= 1,
  "durable append via itx.invoke (full expression)",
  JSON.stringify(mark),
); // enablement mounts consume earlier offsets
// (no absolute offset pins: chunky's live-state change events interleave on the shared
//  sequence — assert the shared-sequence INVARIANT instead: strictly increasing offsets)
let lastOffset = mark[0].offset;
for (let i = 0; i < 3; i++) {
  const c = await itx.invoke(`itx.stream.append({ type: 'chunk', ephemeral: true })`);
  check(
    c?.[0]?.ephemeral === true && c?.[0]?.offset > lastOffset,
    `ephemeral append ${i + 1} (shared offset sequence, > ${lastOffset})`,
    JSON.stringify(c),
  );
  lastOffset = c[0].offset;
}
await itx.invoke(`itx.stream.append({ type: 'mark' })`);

// 3. the NAMED consumer folded the chunks; "*" saw none; both cursors cover the whole window
// (drives are fire-and-forget — wait for the reduce to land rather than racing it)
const until = async (label, fn, timeoutMs = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 400));
  }
};
const chunky = await until("chunky reduced the chunks", async () => {
  const snap = await itx.facetSnapshot("chunky");
  return snap.state.chunks === 3 && snap.state.marks === 2 ? snap : null;
});
check(
  chunky.state.chunks === 3 && chunky.state.marks === 2,
  "named-type consumer folded 3 ephemeral chunks + 2 durable marks",
  JSON.stringify(chunky),
);
const tally = await until("tally caught up to chunky", async () => {
  const snap = await itx.facetSnapshot("tally");
  return snap.offset >= chunky.offset ? snap : null;
});
check(
  tally.state.counts["chunk"] === undefined,
  "'*' never sweeps ephemerals",
  JSON.stringify(tally.state.counts),
);
check(
  tally.state.counts["mark"] === 2,
  "'*' consumer saw both durable marks",
  JSON.stringify(tally.state.counts),
);
check(
  tally.offset >= chunky.offset && chunky.offset >= 5,
  "both cursors advanced over the SHARED offset sequence (ephemeral offsets included)",
  `chunky@${chunky.offset} tally@${tally.offset}`,
);

// 4. ephemeral misuse is a loud error
let bad = "";
try {
  await itx.invoke(`itx.stream.append({ type: 'x', ephemeral: true, idempotencyKey: 'k' })`);
} catch (e) {
  bad = String(e);
}
check(/idempotencyKey/.test(bad), "ephemeral+idempotencyKey rejected", bad.slice(0, 80));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
