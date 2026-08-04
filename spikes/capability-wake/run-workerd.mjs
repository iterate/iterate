// Prove the wake-on-call mechanism in REAL workerd (Miniflare). A registered provider stays
// DORMANT (zero pinning stub — hibernation-eligible), is woken on demand by a call, and the
// pinning RPC leg is torn down after the idle window — back to dormant.

import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { startProvider } from "./provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mf = new Miniflare({
  workers: [
    {
      name: "cap-wake",
      modules: true,
      scriptPath: resolve(here, ".built/do.js"),
      compatibilityDate: "2026-07-01",
      durableObjects: { CAP_DO: "CapabilityWakeDO" },
    },
  ],
});

const base = await mf.ready;
const http = base.origin;
const wsBase = http.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = async () => (await fetch(`${http}/state`)).json();
const call = async (cap, arg) => (await fetch(`${http}/call?cap=${cap}&arg=${arg}`)).json();
async function waitFor(pred, ms = 3000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(await state())) return true;
    await sleep(step);
  }
  return false;
}

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
};

console.log("Miniflare up at " + http + "\n");
const provider = startProvider(wsBase, { impl: { greet: (a) => `hello ${a}` } });
await provider.ready;

// 1. A registered provider is DORMANT — costs nothing (no pinning stub), before any call.
await waitFor((s) => s.registered.includes("greet"));
let s = await state();
check(
  "registered provider is DORMANT (no pinning RPC leg) — hibernation-eligible",
  s.registered.includes("greet") && s.liveLegs === 0 && s.dormant === true,
  `wakeSockets=${s.wakeSockets} liveLegs=${s.liveLegs} dormant=${s.dormant}`,
);

// 2. A call WAKES the dormant provider and is forwarded.
const r1 = await call("greet", "world");
check(
  "call wakes the provider and returns",
  r1.ok && r1.value === "hello world",
  JSON.stringify(r1),
);
s = await state();
check(
  "provider woke (wakeCount ≥ 1) and RPC leg is now live",
  s.wakeCount >= 1 && s.liveLegs === 1,
  `wakeCount=${s.wakeCount} liveLegs=${s.liveLegs}`,
);

// 3. After the idle window the pinning leg is TORN DOWN — dormant again, doorbell survives.
const back = await waitFor((x) => x.liveLegs === 0 && x.idleTimers === 0, 3000);
s = await state();
check(
  "idle teardown severs the pinning leg — dormant again (only the doorbell remains)",
  back && s.liveLegs === 0 && s.wakeSockets === 1 && s.dormant === true,
  `liveLegs=${s.liveLegs} wakeSockets=${s.wakeSockets} providerSawIdle=${provider.events.includes("idle")}`,
);

// 4. A second call wakes it AGAIN (the mechanism is repeatable).
const r2 = await call("greet", "again");
s = await state();
check(
  "second call wakes again (repeatable)",
  r2.ok && r2.value === "hello again" && s.wakeCount >= 2,
  `wakeCount=${s.wakeCount} value=${JSON.stringify(r2.value)}`,
);

provider.close();
await mf.dispose();

console.log("\n" + "=".repeat(64));
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `❌ ${failed.length} FAILED`
    : "✅ ALL PASS — dormant costs nothing, wakes on call, tears down after idle",
);
process.exit(failed.length ? 1 : 0);
