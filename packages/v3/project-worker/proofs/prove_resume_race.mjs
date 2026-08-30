// prove_resume_race.mjs — ADVERSARIAL: a resumeSubscription that lands WHILE a forwarder delivery
// is in flight, where that in-flight delivery then FAILS.
//
// The forwarder's #pumpRow holds a per-row in-flight guard. When subscription-resumed arrives,
// #reset bumps `rev` and calls #pumpRow — which BAILS on the in-flight guard. The in-flight
// delivery then rejects, so #onDeliveryFailure runs, sees `fresh.rev !== progress.rev` (the reset
// bumped it) and RETURNS WITHOUT scheduling a retry or a halt. Nothing re-triggers the pump.
//
// EXPECTED (correct): after the operator's resume, the subscription re-delivers promptly (the
//   reset asked for exactly that). A healthy forwarder delivers within ~1-2s.
// SUSPECTED BUG: the row STALLS (no delivery) until the parent's next +60s idle alarm happens to
//   pump the forwarder — a stuck subscription with no error, no halt, no audit fact.
//
// A gated callback (parked as an ABSENT target → the forwarder lane) lets us hold delivery #1 in
// flight, land the resume, then reject delivery #1. Then we measure the stall.
import { newWebSocketRpcSession } from "capnweb";

const BASE = process.env.BASE ?? "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_race${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (label, fn, timeoutMs = 30000, pollMs = 200) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out after ${timeoutMs}ms`);
    await sleep(pollMs);
  }
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
const keep = [];

// ── the gated forwarder target: delivery #1 is held then REJECTED; later deliveries record + ok ──
let invocations = 0;
const seen = []; // { inv, offs } per callback invocation
let releaseGate; // resolves the held first delivery
const gate = new Promise((r) => (releaseGate = r));
const fn = async (events /*, range */) => {
  invocations++;
  const inv = invocations;
  const offs = (events ?? []).map((e) => e.offset);
  seen.push({ inv, offs });
  if (inv === 1) {
    await gate; // hold delivery #1 in flight so the resume can race it
    throw new Error("target down (simulated failure AFTER the resume landed)");
  }
  return { ok: true };
};

// mountHook: park the live callback, alias it at itx.raceHook — an ABSENT target from the
// subscription lane's view, so the subscription rides the subscription-forwarder facet.
const key = crypto.randomUUID();
keep.push(await itx.rpcStubs.provide(fn, { key }));
await itx.provide({ path: "itx.raceHook", target: `itx.rpcStubs.get('${key}')` });

// subscribe (durable/forwarder lane). start:beginning so the reset target (offset 0) is meaningful.
const sub = await itx.subscribe({
  name: "race",
  target: "itx.raceHook",
  consumes: ["mark"],
  start: "beginning",
});
check(!!sub.name, "subscribed on the forwarder lane", JSON.stringify(sub));

const append = (ev) => itx.invoke(`itx.stream.append(${JSON.stringify(ev)})`);

// 1. m1 → the forwarder delivers [m1]; the callback holds it in flight.
const [m1] = await append({ type: "mark", payload: { n: 1 } });
await until("delivery #1 in flight", () => invocations >= 1, 20000);
check(invocations === 1, "delivery #1 is held in flight", `invocations=${invocations}`);

// 2. m2 commits while #1 is in flight (its own pump attempt bails on the in-flight guard).
const [m2] = await append({ type: "mark", payload: { n: 2 } });

// 3. the operator resumes DURING the in-flight delivery — reset to before m1 (bumps rev).
await itx.resumeSubscription({ name: "race", afterOffset: 0 });

// 4. release delivery #1 → it REJECTS → #onDeliveryFailure sees the bumped rev → returns, no retry.
releaseGate();

// 5. STALL WINDOW: a healthy forwarder re-delivers within ~1-2s. Watch for delivery #2 for 8s.
const STALL_WINDOW_MS = 8000;
let recoveredWithin = false;
{
  const t0 = Date.now();
  while (Date.now() - t0 < STALL_WINDOW_MS) {
    if (invocations >= 2) {
      recoveredWithin = true;
      break;
    }
    await sleep(200);
  }
}
console.log(
  `after resume+fail: invocations=${invocations} within ${STALL_WINDOW_MS}ms; seen=${JSON.stringify(seen)}`,
);
// THE BUG ASSERTION: correct behavior re-delivers promptly (recoveredWithin === true). A stall
// (recoveredWithin === false) is the stuck-subscription bug.
check(
  recoveredWithin,
  `subscription re-delivers within ${STALL_WINDOW_MS}ms of the resume (no stall)`,
  `invocations=${invocations}`,
);

// 6. confirm it is a STALL, not permanent loss: it should recover on the parent's ~60s idle alarm.
//    (also proves no data loss — m1,m2 eventually arrive.)
let recovered = recoveredWithin;
if (!recovered) {
  try {
    await until("eventual recovery via the +60s idle alarm", () => invocations >= 2, 75000, 1000);
    recovered = true;
  } catch {
    recovered = false;
  }
}
const laterOffsets = seen.slice(1).flatMap((s) => s.offs);
check(
  recovered,
  "eventually recovers (delivery #2 arrives) — a stall, not permanent loss",
  `invocations=${invocations}`,
);
check(
  recovered && laterOffsets.includes(m1.offset) && laterOffsets.includes(m2.offset),
  "no data loss: m1 and m2 are both (re)delivered after recovery",
  `laterOffsets=${JSON.stringify(laterOffsets)} m1=${m1.offset} m2=${m2.offset}`,
);

// /state sanity: the row is on the durable lane, forwarder facet enabled, and it is NOT halted.
const state = await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();
const row = state.subscriptionMounts?.find((r) => r.name === "race");
check(
  row?.lane === "durable" && state.facetProcessors?.includes("subscription-forwarder"),
  "/state: durable lane + forwarder facet enabled",
  JSON.stringify({ row, facetProcessors: state.facetProcessors }),
);

console.log(
  failures === 0 ? "\nALL PASS (no stall — clean)" : `\n${failures} FAILURES (stall reproduced)`,
);
process.exit(failures === 0 ? 0 : 1);
