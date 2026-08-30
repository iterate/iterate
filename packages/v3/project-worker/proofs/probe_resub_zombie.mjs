// probe_resub_zombie.mjs — ADVERSARIAL PROOF (RED on live-31): re-subscribe same name + unsubscribe
// resurrects a ZOMBIE subscription that keeps delivering to the FIRST callback.
//
// ROOT CAUSE (two cooperating defects):
//   1. itx.subscribe() ALWAYS mints a fresh relay+key and calls Parking.addNamed(name, relay)
//      (core/itx-surface.ts:108-111 + :416). addNamed OVERWRITES #named[name] but leaves the
//      previous relay in #relays, NEVER disposed — so the first callback's parked stub stays ONLINE.
//   2. unsubscribe(name) revokes BY PATH (core/itx-surface.ts:431); revokeCapability-by-path pops
//      only the NEWEST winner and RESTORES the shadowed older mount
//      (stream-durable-object.ts:1008-1012). disposeNamed(name) disposes only the relay in #named
//      (the newest). So after unsubscribe: the OLD mount M1 becomes the winner again, its target key
//      is still online (defect 1) → the commit pump resumes delivery to the FIRST callback.
//
// The client both REPLACED (re-subscribe same name) and UNSUBSCRIBED that name, yet delivery
// continues to a callback it can no longer see or address. Delivery-after-unsubscribe + stale /state.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_zomb${Date.now() % 1000000}`;
const API = `wss://${BASE}/api?ctx=${CTX}`;
process.on("uncaughtException", (e) => console.log(`nonfatal: ${e.message}`));

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const session = newWebSocketRpcSession(API);
const itx = await session.get();

// ── CONTROL: a SINGLE subscribe then unsubscribe must stop delivery (unsubscribe works normally) ──
let ctrl = 0;
await itx.subscribe({
  name: "control",
  consumes: ["ctl"],
  target: (events) => (ctrl += events.length),
});
await itx.invoke("itx.stream.append({ type: 'ctl', payload: { n: 1 } })");
await sleep(2000);
check(ctrl === 1, "control: single subscribe delivers", `ctrl=${ctrl}`);
await itx.unsubscribe({ name: "control" });
await sleep(800);
await itx.invoke("itx.stream.append({ type: 'ctl', payload: { n: 2 } })");
await sleep(2500);
check(
  ctrl === 1,
  "control: NO delivery after unsubscribe (unsubscribe works for a single sub)",
  `ctrl=${ctrl}`,
);

// ── BUG: re-subscribe the SAME name, then unsubscribe once ──
let cb1 = 0;
let cb2 = 0;
const cb1seqs = [];
await itx.subscribe({
  name: "s",
  consumes: ["mark"],
  target: (events) => events.forEach((e) => (cb1++, cb1seqs.push(e.payload?.n))),
});
await itx.subscribe({
  name: "s", // re-subscribe SAME name — the client's model: this replaces cb1
  consumes: ["mark"],
  target: (events) => (cb2 += events.length),
});

await itx.invoke("itx.stream.append({ type: 'mark', payload: { n: 1 } })");
await sleep(2500);
check(
  cb2 === 1 && cb1 === 0,
  "while both subscribed: only newest (cb2) delivered",
  `cb1=${cb1} cb2=${cb2}`,
);

await itx.unsubscribe({ name: "s" }); // client expects: subscription 's' fully gone
await sleep(1000);
await itx.invoke("itx.stream.append({ type: 'mark', payload: { n: 2 } })");
await sleep(3000);

const st = await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();
console.log(`\nafter unsubscribe('s'): cb1=${cb1} (${cb1seqs}) cb2=${cb2}`);
console.log(`/state: ${JSON.stringify({ stubs: st.stubs, subs: st.subscriptionMounts })}`);

// THE CONTRACT the bug violates: after unsubscribe('s'), no callback under 's' receives anything.
check(
  cb1 === 0 && !cb1seqs.includes(2),
  "after unsubscribe('s'), the FIRST callback receives NOTHING (no zombie)",
  `cb1=${cb1} seqs=${cb1seqs}`,
);
check(
  !st.subscriptionMounts?.some((r) => r.name === "s"),
  "after unsubscribe('s'), /state shows NO subscription named 's'",
  JSON.stringify(st.subscriptionMounts),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES (RED — bug present)`);
process.exit(failures === 0 ? 0 : 1);
