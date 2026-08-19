// prove_push.mjs — the ABSENT-TARGET lane live: the subscription-forwarder facet drives a
// stateless processEvent-style worker from its own SubscriptionDeliveryProgress cursor; the ONE
// failure policy (bounded retries → HALT + audit fact); resumeSubscription as the one recovery
// verb; auto-enablement of the forwarder by the first absent-target subscribe.
import { newWebSocketRpcSession } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_push${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (label, fn, timeoutMs = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
await seedSources(itx, ["digest"]);

// 1. mount the stateless digest cap + the "*" tally (to observe audit facts)
await itx.enableProcessor("tally");
await itx.provide({
  path: "itx.digest",
  target: `itx.workers.get({ type: 'stateless', source: "itx.kv.get('src/digest.js')" })`,
});

// 2. subscribe with an ABSENT target → the subscription-forwarder facet is auto-enabled and
// owns the cursor. maxAttempts bounds the ONE retry-then-halt ladder (small here so the halt
// proof runs in seconds; the production default is 15).
const sub = await itx.subscribe({
  name: "digest",
  target: "itx.digest.run",
  consumes: ["mark"],
  maxAttempts: 2,
  start: "beginning",
});
check(sub.name === "digest", "subscribe returns the row name", JSON.stringify(sub));

// 3. three good marks → the worker's own kv shows 3 (the awaited call IS the ack)
for (let i = 0; i < 3; i++) await itx.invoke(`itx.stream.append({ type: 'mark' })`);
const digested3 = await until("digest=3", async () => {
  const v = await itx.invokeCapability({ path: ["kv", "get"], args: ["digested"] });
  return v === "3" ? v : undefined;
});
check(digested3 === "3", "stateless worker digested 3 marks via the forwarder", digested3);

// 4. a poison mark: the batch fails, retries once (~1s backoff via the parent's alarm proxy —
// facets have no alarms), then HALTS with an audit fact. No skip, no pinning: ONE policy.
const [poisoned] = await itx.invoke(
  `itx.stream.append({ type: 'mark', payload: { poison: true } })`,
);
await itx.invoke(`itx.stream.append({ type: 'mark' })`); // a good one stuck behind it
const tallyAfterHalt = await until(
  "halt audit fact",
  async () => {
    const t = await itx.facetSnapshot("tally");
    return (t.state.counts["events.iterate.com/stream/subscription-delivery-halted"] ?? 0) >= 1
      ? t
      : undefined;
  },
  60000,
);
check(
  tallyAfterHalt !== undefined,
  "2 failed attempts → HALT left an audit fact on the stream",
  JSON.stringify(tallyAfterHalt.state.counts),
);
const digestedStill3 = await itx.invokeCapability({ path: ["kv", "get"], args: ["digested"] });
check(digestedStill3 === "3", "halted subscription delivered nothing more", String(digestedStill3));

// 5. resumeSubscription past the poison — THE one recovery verb — and the stuck good mark lands
await itx.resumeSubscription({ name: "digest", afterOffset: poisoned.offset });
const digested4 = await until(
  "digest=4 (past the poison)",
  async () => {
    const v = await itx.invokeCapability({ path: ["kv", "get"], args: ["digested"] });
    return v === "4" ? v : undefined;
  },
  60000,
);
check(
  digested4 === "4",
  "resume({afterOffset}) skipped the poison, delivered the good mark",
  digested4,
);

// 6. /state: the row rides the forwarder lane; the forwarder facet was auto-enabled
const state = await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();
const row = state.subscriptionMounts?.find((r) => r.name === "digest");
check(
  row?.lane === "forwarder" && state.facetProcessors?.includes("subscription-forwarder"),
  "/state: absent-target row on the forwarder lane, forwarder facet auto-enabled",
  JSON.stringify({ row, facetProcessors: state.facetProcessors }),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
