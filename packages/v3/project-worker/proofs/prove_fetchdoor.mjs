// prove_fetchdoor.mjs — cook-1 proof 4 + 6: the seeded site over the ONE fetch door (/cap) as a `code`
// mount (the web→code fold), including a WS upgrade through /cap; and the deleted routes fall through.
import { newWebSocketRpcSession } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? "prj_cook1";
const CAP = encodeURIComponent("itx.site"); // the fetch door resolves an itx expression (the ONE addressing form)

let failures = 0;
function check(cond, label, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

// Mount the seeded /site.js on the fetch door: a mount whose target is a stateless dynamic worker
// (its .fetch serves /cap). `type:'code'` provisioning was folded into the ONE provide door —
// a capability is an itx EXPRESSION (workers.get), same as every other mount.
const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.get();
await seedSources(itx, ["site"]);
await itx.provide({
  path: "itx.site",
  target: "itx.workers.get({ source: \"itx.kv.get('src/site.js')\" })",
});

// ── 4a. GET through the one fetch door ──
const page = await fetch(`https://${BASE}/cap?cap=${CAP}&ctx=${CTX}`);
const html = await page.text();
check(
  page.status === 200 && html.includes("dynamic web capability"),
  '4a. GET /cap?cap=["site"] → 200 HTML (code mount on the fetch lane)',
  `status=${page.status}`,
);

// ── 4b. WebSocket upgrade through /cap → echo ──
const wsResult = await new Promise((resolve) => {
  const ws = new WebSocket(`wss://${BASE}/cap?cap=${CAP}&ctx=${CTX}`);
  const timer = setTimeout(() => resolve("TIMEOUT"), 15000);
  ws.onopen = () => ws.send("hello-from-eyeball");
  ws.onmessage = (e) => {
    clearTimeout(timer);
    ws.close();
    resolve(e.data);
  };
  ws.onerror = () => {
    clearTimeout(timer);
    resolve("WS-ERROR");
  };
});
check(
  wsResult === "site-echo:hello-from-eyeball",
  "4b. WS upgrade through /cap → echo (web→code fold, 101 through the graph)",
  JSON.stringify(wsResult),
);

// ── 6. deleted routes fall through to help text; /version + /state still work ──
const call = await fetch(`https://${BASE}/call?path=itx.whoami&ctx=${CTX}`);
const callBody = await call.text();
check(
  callBody.includes("project-worker —") && !callBody.includes('"ok"'),
  "6a. /call falls through to help text",
  JSON.stringify(callBody.trim()),
);
const wsRoute = await fetch(`https://${BASE}/ws?ctx=${CTX}`);
const wsBody = await wsRoute.text();
check(
  wsBody.includes("project-worker —"),
  "6b. /ws falls through to help text",
  JSON.stringify(wsBody.trim()),
);
const wsUpgrade = await new Promise((resolve) => {
  const ws = new WebSocket(`wss://${BASE}/ws?ctx=${CTX}`);
  const timer = setTimeout(() => {
    try {
      ws.close();
    } catch {}
    resolve("NO-101");
  }, 8000);
  ws.onopen = () => {
    clearTimeout(timer);
    ws.close();
    resolve("UPGRADED");
  };
  ws.onerror = () => {
    clearTimeout(timer);
    resolve("NO-101");
  };
});
check(
  wsUpgrade === "NO-101",
  "6c. a bare WS upgrade to /ws no longer echoes (demo deleted)",
  wsUpgrade,
);
const version = (await (await fetch(`https://${BASE}/version`)).text()).trim();
check(version.length > 0, "6d. /version still works", version); // tag-agnostic — never goes stale
const state = await fetch(`https://${BASE}/state?ctx=${CTX}`);
const stateBody = await state.json();
check(
  state.status === 200 && typeof stateBody.incarnation === "number",
  "6e. /state still works",
  JSON.stringify(stateBody),
);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
