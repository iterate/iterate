// Same wake-on-call proof against the DEPLOYED worker on the POC account, over the public
// internet: a Node "provider" holds the hibernatable doorbell (wss), stays dormant, is woken
// on demand, and the pinning leg is torn down after idle.

import { startProvider } from "./provider.mjs";

const BASE = process.env.BASE || "https://capnweb-spike-wake.iterate.workers.dev";
const wsBase = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.log(
      `  ⚠️  ${path} → HTTP ${res.status} (${res.headers.get("content-type")}): ${text.slice(0, 120).replace(/\n/g, " ")}`,
    );
    return { __nonjson: true, status: res.status };
  }
}
const state = () => getJson(`/state`);
const call = (cap, arg) => getJson(`/call?cap=${cap}&arg=${arg}`);
async function waitFor(pred, ms = 5000, step = 50) {
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

console.log("Deployed target: " + BASE + "\n");
const provider = startProvider(wsBase, {
  connectionKey: "pi-deployed",
  impl: { greet: (a) => `hello ${a}` },
});
await provider.ready;

await waitFor((s) => s.registered.includes("greet"));
let s = await state();
check(
  "registered provider is DORMANT (no pinning leg)",
  s.registered.includes("greet") && s.liveLegs === 0 && s.dormant,
  `liveLegs=${s.liveLegs} dormant=${s.dormant}`,
);

const r1 = await call("greet", "world");
check(
  "call wakes the provider and returns",
  r1.ok && r1.value === "hello world",
  JSON.stringify(r1),
);

const back = await waitFor((x) => x.liveLegs === 0 && x.idleTimers === 0, 6000);
s = await state();
check(
  "idle teardown severs the pinning leg — dormant again",
  back && s.liveLegs === 0 && s.wakeSockets === 1,
  `liveLegs=${s.liveLegs} wakeSockets=${s.wakeSockets} sawIdle=${provider.events.includes("idle")}`,
);

const r2 = await call("greet", "again");
check(
  "second call wakes again (repeatable)",
  r2.ok && r2.value === "hello again",
  JSON.stringify(r2.value),
);

provider.close();
console.log("\n" + "=".repeat(64));
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `❌ ${failed.length} FAILED`
    : `✅ ALL PASS on the DEPLOYED wake worker (${BASE})`,
);
process.exit(failed.length ? 1 : 0);
