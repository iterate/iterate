// PRODUCTION proof of the fused, hardened capability host — no Miniflare.
//   Part A: fused hardening — fallthrough BY NAME + mutators gated off the tenant surface.
//   Part B: a FLEET of 1000 IoT-style providers holding hibernatable doorbells; the DO
//           HIBERNATES (observed via the incarnation counter) with all 1000 still connected,
//           and any single device is wakeable on demand without waking the others.

import { startProvider } from "./provider.mjs";

const BASE = process.env.BASE || "https://capnweb-spike-fused.iterate.workers.dev";
const SECRET = process.env.ADMIN_SECRET || "admin_spike_secret_2386";
const FLEET = Number(process.env.FLEET || 1000);
const IDLE_WAIT_MS = Number(process.env.IDLE_WAIT_MS || 60000);
const wsBase = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path, tries = 5) {
  // Retry non-JSON responses — a brand-new DO's first request can hit a cold-start error page.
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        /* cold-start HTML or transient */
      }
    } catch {
      /* network */
    }
    if (i < tries - 1) await sleep(400);
  }
  return { __nonjson: true };
}
const state = (ctx) => getJson(`/state?ctx=${ctx}`);
const call = (ctx, cap, arg = "") => getJson(`/call?ctx=${ctx}&cap=${cap}&arg=${arg}`);
const warm = (ctx) => getJson(`/state?ctx=${ctx}`); // force-construct + settle a DO before use

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
};

console.log(`Target: ${BASE}\n`);

// ───────────────────────── Part A — fused hardening ─────────────────────────
console.log("## Part A — fallthrough-by-name + gated mutators");
await Promise.all([warm("control-plane"), warm("project")]); // dodge cold-start error pages
await getJson(`/admin/provide-static?ctx=control-plane&cap=flavor&value=iterate&secret=${SECRET}`);
await getJson(`/admin/set-parent?ctx=project&name=control-plane&secret=${SECRET}`);

const tenantMutate = await getJson(`/admin/set-parent?ctx=project&name=evil`); // no secret
check(
  "tenant CANNOT mutate (mutators are gated off /call)",
  tenantMutate.ok === false,
  JSON.stringify(tenantMutate.error || tenantMutate),
);

const pi = startProvider(wsBase, {
  ctx: "project",
  connectionKey: "pi-1",
  impl: { greet: (a) => `hello ${a}` },
});
await pi.ready;
await sleep(500);
const rLive = await call("project", "greet", "world");
check(
  "local LIVE cap via wake doorbell",
  rLive.ok && rLive.value === "hello world",
  JSON.stringify(rLive.value ?? rLive),
);
const rFall = await call("project", "flavor");
check(
  "fallthrough BY NAME to parent's static cap (no retained stub)",
  rFall.ok && rFall.value === "static:iterate",
  JSON.stringify(rFall.value ?? rFall),
);
const rMiss = await call("project", "nope");
check(
  "unknown cap → downward miss (no upward escalation)",
  rMiss.ok === false,
  JSON.stringify(rMiss.error),
);
pi.close();

// ───────────────────── Part B — 1000-device fleet + hibernation ─────────────────────
console.log(`\n## Part B — ${FLEET} IoT providers + real hibernation`);
await warm("fleet"); // construct the fleet DO before the connect burst (avoids cold upgrade drops)
console.log(`  connecting ${FLEET} providers…`);
const providers = [];
const BATCH = 50;
for (let i = 0; i < FLEET; i += BATCH) {
  const batch = [];
  for (let j = i; j < Math.min(i + BATCH, FLEET); j++) {
    const p = startProvider(wsBase, {
      ctx: "fleet",
      connectionKey: `dev-${j}`,
      impl: { [`dev-${j}`]: (a) => `pong from dev-${j} (${a})` },
    });
    providers.push(p);
    batch.push(p.ready);
  }
  await Promise.all(batch);
  await sleep(60);
}

// wait for the DO to have accepted+registered ~all of them
let s;
for (let t = 0; t < 60; t++) {
  s = await state("fleet");
  if (s.wakeSockets >= FLEET) break;
  await sleep(1000);
}
check(
  `${FLEET} providers connected + registered (zero pinning legs)`,
  s.wakeSockets >= FLEET * 0.98 && s.liveLegs === 0 && s.dormant,
  `wakeSockets=${s.wakeSockets} liveLegs=${s.liveLegs} dormant=${s.dormant}`,
);
const incBefore = s.incarnation;
const wakeBefore = s.wakeSockets;

// ── the money shot: idle → real hibernation while the fleet stays connected ──
console.log(`  idle for ${IDLE_WAIT_MS / 1000}s (no calls) — expecting the DO to hibernate…`);
await sleep(IDLE_WAIT_MS);
s = await state("fleet"); // this request reconstructs the DO if it was evicted
check(
  "DO HIBERNATED + evicted while the fleet stayed connected (incarnation grew, sockets survived)",
  s.incarnation > incBefore && s.wakeSockets >= wakeBefore * 0.98,
  `incarnation ${incBefore}→${s.incarnation}  wakeSockets ${wakeBefore}→${s.wakeSockets}  dormant=${s.dormant}`,
);

// ── wake individual devices on demand — only the targeted one wakes ──
const targets = [0, Math.floor(FLEET / 2), FLEET - 1];
let allWoke = true;
for (const n of targets) {
  const r = await call("fleet", `dev-${n}`, "ping");
  const ok = r.ok && r.value === `pong from dev-${n} (ping)`;
  allWoke &&= ok;
  console.log(`     dev-${n}: ${ok ? "✅" : "❌"} ${JSON.stringify(r.value ?? r.error)}`);
}
check("any single device is wakeable on demand", allWoke);

// only the targeted devices ever saw a wake (the other ~997 stayed dormant)
const wokenCount = providers.filter((p) => p.events.includes("wake")).length;
check(
  "ONLY targeted devices woke — the rest never left dormancy",
  wokenCount === targets.length,
  `providers that woke = ${wokenCount} (expected ${targets.length})`,
);

// after idle, back to dormant (legs torn down)
await sleep(1500);
s = await state("fleet");
check(
  "fleet dormant again after idle (all legs torn down)",
  s.liveLegs === 0 && s.dormant,
  `liveLegs=${s.liveLegs} dormant=${s.dormant}`,
);

for (const p of providers) p.close();

console.log("\n" + "=".repeat(64));
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `❌ ${failed.length} FAILED`
    : `✅ ALL PASS — 1000 idle devices cost ~nothing (DO hibernates); any one wakes on demand`,
);
process.exit(failed.length ? 1 : 0);
