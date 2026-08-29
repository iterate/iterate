// prove_crisp1.mjs — the crisp-1 architecture proof against the deployed project-worker.
// Covers: routing seeds, live-cap desugar (park+alias), THE SHADOW STACK (override → revoke →
// restore), expression mounts running dynamic workers (stateless fetch+WS, stateful deep call),
// connections view (get/each/list), default-deny, and the warm paged-in stub.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_crisp${Date.now() % 100000}`;
const API = `wss://${BASE}/api?ctx=${CTX}`;

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const state = async () => await (await fetch(`https://${BASE}/state?ctx=${CTX}`)).json();

// ── clients A (provider) + B (caller) ──
class ToolsA extends RpcTarget {
  echo(s) {
    return `echo-A:${s}`;
  }
  hello() {
    return "from A";
  }
}
class ToolsB extends RpcTarget {
  hello() {
    return "from B";
  }
}
const sessionA = newWebSocketRpcSession(API);
const itxA = await sessionA.connect({
  connectionKey: "a",
  description: "prover A",
  capabilities: new ToolsA(),
});
const sessionB = newWebSocketRpcSession(API);
const itxB = await sessionB.connect({
  connectionKey: "b",
  description: "prover B",
  capabilities: new ToolsB(),
});
await seedSources(itxA, ["site", "counter"]);

// 1. whoami through the routing table (seed itx.whoami ⇒ roots.whoami) — via the ONE dispatch door
const who = await itxA.invokeCapability({ path: ["whoami"], args: [] });
// 1b. the authenticate() introduction door (a NO-OP today; the shape the real gate lands in)
const whoAuth = await sessionA
  .authenticate({ token: "ignored-today" })
  .get()
  .invokeCapability({ path: ["whoami"], args: [] });
check(whoAuth?.projectId === CTX, "authenticate() introduction door", JSON.stringify(whoAuth));
check(who?.projectId === CTX, "whoami via seed", JSON.stringify(who));

// 2. kv through the seed (itx.kv ⇒ roots.kv, project-prefixed)
await itxA.invokeCapability({ path: ["kv", "put"], args: ["greet", "hi-crisp"] });
const got = await itxA.invokeCapability({ path: ["kv", "get"], args: ["greet"] });
check(got === "hi-crisp", "kv round-trip via seed", String(got));

// 3. live capability: provide from A (park + alias desugar), invoke from B
const provision = await itxA.provideCapability({
  path: ["tools"],
  capability: new ToolsA(),
});
const echoed = await itxB.invokeCapability({ path: ["tools", "echo"], args: ["hello"] });
check(echoed === "echo-A:hello", "live cap: B invokes A's provider", String(echoed));
const s1 = await state();
// The paged-in stub stays WARM after a call now (disposal is the 60s quiesce alarm —
// prove_hibernate owns the don't-pin property); what must hold here: stubs attached + paged in.
check(
  s1.stubs >= 3 && s1.pagedIn >= 1,
  "stub pager: 3 attached, tools stub paged in and warm",
  JSON.stringify(s1),
);

// 4. THE SHADOW STACK: same pattern mounted twice — newest wins; revoke restores
const provA = await itxA.provideCapability({
  path: ["greeter"],
  capability: new ToolsA(),
});
const provB = await itxB.provideCapability({
  path: ["greeter"],
  capability: new ToolsB(),
});
const winB = await itxA.invokeCapability({ path: ["greeter", "hello"], args: [] });
check(winB === "from B", "shadow stack: newest mount wins", String(winB));
await provB.revoke();
const winA = await itxA.invokeCapability({ path: ["greeter", "hello"], args: [] });
check(winA === "from A", "shadow stack: revoke restores what was beneath", String(winA));
await provA.revoke();
let denied = "";
try {
  await itxA.invokeCapability({ path: ["greeter", "hello"], args: [] });
} catch (e) {
  denied = String(e);
}
check(/no capability matches/.test(denied), "default-deny after last revoke", denied.slice(0, 80));

// 5. EXPRESSION MOUNT running a stateless dynamic worker (the fetch lane end-to-end)
await itxA.provide({
  path: "itx.site",
  target: "itx.workers.get({ type: 'stateless', source: ['itx', 'kv', ['get', 'src/site.js']] })",
});
const page = await fetch(`https://${BASE}/cap?ctx=${CTX}&cap=${encodeURIComponent("itx.site")}`);
const html = await page.text();
check(
  page.status === 200 && html.includes("dynamic web capability"),
  "mounted worker serves HTML via /cap",
  `${page.status}`,
);
const ws = new WebSocket(`wss://${BASE}/cap?ctx=${CTX}&cap=${encodeURIComponent("itx.site")}`);
const wsEcho = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("ws timeout")), 8000);
  ws.addEventListener("open", () => ws.send("hello-from-eyeball"));
  ws.addEventListener("message", (e) => {
    clearTimeout(t);
    resolve(e.data);
    ws.close();
  });
  ws.addEventListener("error", (e) => {
    clearTimeout(t);
    reject(new Error("ws error"));
  });
});
check(
  wsEcho === "site-echo:hello-from-eyeball",
  "WebSocket 101 through the mounted worker",
  String(wsEcho),
);

// 6. EXPRESSION MOUNT running a STATEFUL worker — deep dotted call + callback into the host
await itxA.provide({
  path: "itx.counter",
  target:
    "itx.workers.get({ type: 'stateful', source: ['itx', 'kv', ['get', 'src/counter.js']], className: 'Counter' })",
});
const inc = await itxA.invokeCapability({ path: ["counter", "increment"], args: [2] });
check(inc === 2, "stateful worker: increment(2)", String(inc));
const deep = await itxA.invokeCapability({ path: ["counter", "counters", "add"], args: [3] });
check(deep === 5, "stateful worker: DEEP dotted counters.add(3)", String(deep));
const val = await itxA.invokeCapability({ path: ["counter", "value"], args: [] });
check(val === 5, "stateful worker: value()", String(val));
const whoDeep = await itxA.invokeCapability({ path: ["counter", "whoAmI"], args: [] });
check(
  whoDeep?.projectId === CTX,
  "stateful worker calls BACK through env.ITX",
  JSON.stringify(whoDeep),
);

// 7. the connections view: list (currently connected clients), single-target get, each() fan-out
const currentlyConnected = await itxA.invoke("itx.connections.list()");
check(
  Array.isArray(currentlyConnected) &&
    ["a", "b"].every((k) => currentlyConnected.some((c) => c.connectionKey === k)),
  "connections.list shows both keyed clients",
  JSON.stringify(currentlyConnected),
);
const single = await itxA.invoke("itx.connections.get('b').hello()");
check(single === "from B", "connections.get(key) reaches ONE client", String(single));
// fan-out is list() + map over get(key) — no built-in `each`; the caller owns the allSettled.
const connKeys = (await itxA.invoke("itx.connections.list()")).map(
  (r) => r.connectionKey ?? r.connectionId,
);
const fans = (
  await Promise.all(
    connKeys.map((k) => itxA.invoke(`itx.connections.get('${k}').hello()`).catch(() => undefined)),
  )
).filter((v) => v !== undefined);
check(
  fans.includes("from B") && fans.includes("from A"),
  "fan-out via connections.list() + map (no each) reaches every attached connection",
  JSON.stringify(fans),
);

// 8. /version
const version = (await (await fetch(`https://${BASE}/version`)).text()).trim();
check(version.length > 0, "/version", version);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
