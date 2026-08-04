// SOAK: prove the graceful, no-spike version. Fixes the lesson from the first run:
//   • STAGGERED connect (small paced batches) so the single DO isn't thundering-herded into
//     dropping sockets — that drop+auto-reconnect churn is what produced the clientDisconnected
//     "error" spike and the odd mid-idle wake.
//   • 5-minute idle to show a multi-minute, ~0-activeTime hibernation (not just one minute).
//   • GRACEFUL close (code 1000) at teardown.
// After it runs, read Cloudflare DO analytics for the window (see the printed UTC range).

import { startProvider } from "./provider.mjs";

const BASE = process.env.BASE || "https://capnweb-spike-fused.iterate.workers.dev";
const FLEET = Number(process.env.FLEET || 1000);
const IDLE_MIN = Number(process.env.IDLE_MIN || 5);
const CTX = process.env.CTX || `soak-${Math.random().toString(36).slice(2, 8)}`;
const wsBase = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(path, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`);
      const t = await res.text();
      try {
        return JSON.parse(t);
      } catch {}
    } catch {}
    await sleep(400);
  }
  return { __nonjson: true };
}
const state = () => getJson(`/state?ctx=${CTX}`);
const call = (cap, arg = "") => getJson(`/call?ctx=${CTX}&cap=${cap}&arg=${arg}`);

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
};
const stamp = () => new Date().toISOString().slice(11, 19) + "Z";

console.log(`ctx=${CTX}  fleet=${FLEET}  idle=${IDLE_MIN}min`);
console.log(`WINDOW START ${new Date().toISOString()}`);
await getJson(`/state?ctx=${CTX}`); // construct the DO first

// ── staggered connect: 25 every 250ms (~100/s) so the DO is never herded ──
console.log(`[${stamp()}] connecting ${FLEET} providers, staggered…`);
const providers = [];
for (let i = 0; i < FLEET; i++) {
  providers.push(
    startProvider(wsBase, {
      ctx: CTX,
      connectionKey: `dev-${i}`,
      impl: { [`dev-${i}`]: (a) => `pong-${i}-${a}` },
    }),
  );
  if (i % 25 === 24) await sleep(250);
}
await Promise.all(providers.map((p) => p.ready));

let s;
for (let t = 0; t < 90; t++) {
  s = await state();
  if (s.wakeSockets >= FLEET) break;
  await sleep(1000);
}
check(
  `${FLEET} connected (staggered)`,
  s.wakeSockets >= FLEET * 0.99 && s.liveLegs === 0,
  `wakeSockets=${s.wakeSockets} dormant=${s.dormant}`,
);

// churn baseline BEFORE idle: how many providers already had to reconnect during connect?
const churnAfterConnect = providers.filter((p) => p.reconnects > 0).length;
console.log(`[${stamp()}] connect-phase reconnects: ${churnAfterConnect}/${FLEET} providers`);
const incBefore = s.incarnation;

// ── 5-minute idle soak ──
console.log(
  `[${stamp()}] idle ${IDLE_MIN} min — expecting deep hibernation, no spontaneous wakes…`,
);
for (let m = 1; m <= IDLE_MIN; m++) {
  await sleep(60000);
  s = await state();
  console.log(
    `[${stamp()}]   +${m}min: incarnation=${s.incarnation} wakeSockets=${s.wakeSockets} wakeCount=${s.wakeCount} dormant=${s.dormant}`,
  );
}

check(
  "survived a 5-min idle with the fleet connected (evicted+reconstructed, sockets kept)",
  s.incarnation > incBefore && s.wakeSockets >= FLEET * 0.99,
  `incarnation ${incBefore}→${s.incarnation} wakeSockets=${s.wakeSockets}`,
);
const spontaneousWakes = providers.filter((p) => p.events.includes("wake")).length;
check(
  "NO device woke during idle (no spontaneous/random wakes)",
  spontaneousWakes === 0 && s.wakeCount === 0,
  `providersThatWoke=${spontaneousWakes} do.wakeCount=${s.wakeCount}`,
);
const churnDuringIdle = providers.filter((p) => p.reconnects > 0).length - churnAfterConnect;
check(
  "NO reconnect churn during idle (stable fleet ⇒ no clientDisconnected spike)",
  churnDuringIdle <= FLEET * 0.01,
  `reconnectsDuringIdle=${churnDuringIdle}`,
);

// ── wake exactly one device, confirm targeted wake still works after deep hibernation ──
const r = await call("dev-500", "ping");
check(
  "targeted wake after deep hibernation",
  r.ok && r.value === "pong-500-ping",
  JSON.stringify(r.value ?? r),
);

console.log(`[${stamp()}] graceful teardown (close code 1000)…`);
for (const p of providers) p.close();
await sleep(2000);
console.log(`WINDOW END ${new Date().toISOString()}   (read DO analytics for this range)`);

console.log("\n" + "=".repeat(64));
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `❌ ${failed.length} FAILED`
    : "✅ ALL PASS — staggered connect, deep hibernation, no spontaneous wakes, graceful close",
);
console.log(`ANALYTICS_CTX=${CTX}`);
process.exit(failed.length ? 1 : 0);
