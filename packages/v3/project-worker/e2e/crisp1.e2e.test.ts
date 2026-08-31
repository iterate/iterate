// crisp1.e2e.test.ts — the crisp-1 architecture proof against the local project-worker.
// Covers: routing seeds, live-cap desugar (park+alias), THE SHADOW STACK (override → revoke →
// restore), expression mounts running dynamic workers (stateless fetch+WS, stateful deep call),
// rpcStubs view (get/list), default-deny, and the warm paged-in stub.
// (was proofs/prove_crisp1.mjs)

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, session } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

// The one raw HTTP door with no capnweb equivalent is /cap (fetch-shaped caps + WS upgrades) and
// /version. Reach them on the same local worker the session speaks to (URL from global-setup).
const base = (): string => {
  const u = process.env.WORKER_BASE_URL;
  if (!u) throw new Error("WORKER_BASE_URL unset — the e2e globalSetup/setup did not run");
  return u;
};

test("crisp-1: routing, live caps, shadow stack, dynamic-worker mounts, rpcStubs view", async () => {
  const ctx = freshCtx("crisp");
  const capUrl = (scheme: "http" | "ws"): string => {
    const u = new URL("/cap", base());
    u.protocol = scheme === "ws" ? "ws:" : "http:";
    u.searchParams.set("ctx", ctx);
    u.searchParams.set("cap", "itx.site");
    return u.toString();
  };

  // ── clients A (provider) + B (caller), both on the SAME ctx (one project DO) ──
  class ToolsA extends RpcTarget {
    echo(s: string): string {
      return `echo-A:${s}`;
    }
    hello(): string {
      return "from A";
    }
  }
  class ToolsB extends RpcTarget {
    hello(): string {
      return "from B";
    }
  }
  const sessionA = session(ctx);
  const itxA = await sessionA.get();
  await itxA.rpcStubs.provide(new ToolsA(), { key: "a", description: "prover A" });
  const itxB = await session(ctx).get();
  await itxB.rpcStubs.provide(new ToolsB(), { key: "b", description: "prover B" });
  await seedSources(itxA, ["site", "counter"]);

  // 1. whoami through the routing table (seed itx.whoami ⇒ roots.whoami) — via the ONE dispatch door
  const who = await itxA.invokeCapability(["itx", ["whoami"]]);
  // 1b. the authenticate() introduction door (a NO-OP today; the shape the real gate lands in)
  const whoAuth = await sessionA
    .authenticate({ token: "ignored-today" })
    .get()
    .invokeCapability(["itx", ["whoami"]]);
  // authenticate() introduction door
  expect(whoAuth?.projectId).toBe(ctx);
  // whoami via seed
  expect(who?.projectId).toBe(ctx);

  // 2. kv through the seed (itx.kv ⇒ roots.kv, project-prefixed)
  await itxA.invokeCapability(["itx", "kv", ["put", "greet", "hi-crisp"]]);
  const got = await itxA.invokeCapability(["itx", "kv", ["get", "greet"]]);
  // kv round-trip via seed
  expect(got).toBe("hi-crisp");

  // 3. live capability: provide from A (park an rpc stub under a key + mount it), invoke from B
  const toolsKey = crypto.randomUUID();
  await itxA.rpcStubs.provide(new ToolsA(), { key: toolsKey });
  await itxA.provide({ path: "itx.tools", target: `itx.rpcStubs.get('${toolsKey}')` });
  const echoed = await itxB.invokeCapability(["itx", "tools", ["echo", "hello"]]);
  // live cap: B invokes A's provider
  expect(echoed).toBe("echo-A:hello");
  const s1 = await itxA.hostState();
  // The paged-in stub stays WARM after a call now (disposal is the 60s quiesce alarm —
  // prove_hibernate owns the don't-pin property); what must hold here: stubs attached + paged in.
  // stub pager: 3 attached, tools stub paged in and warm
  expect(s1.stubs).toBeGreaterThanOrEqual(3);
  expect(s1.pagedIn).toBeGreaterThanOrEqual(1);

  // 4. THE SHADOW STACK: same path mounted twice — newest wins; revoking the mount restores
  const greeterKeyA = crypto.randomUUID();
  await itxA.rpcStubs.provide(new ToolsA(), { key: greeterKeyA });
  await itxA.provide({ path: "itx.greeter", target: `itx.rpcStubs.get('${greeterKeyA}')` });
  const greeterKeyB = crypto.randomUUID();
  await itxB.rpcStubs.provide(new ToolsB(), { key: greeterKeyB });
  await itxB.provide({ path: "itx.greeter", target: `itx.rpcStubs.get('${greeterKeyB}')` });
  const winB = await itxA.invokeCapability(["itx", "greeter", ["hello"]]);
  // shadow stack: newest mount wins
  expect(winB).toBe("from B");
  await itxB.revoke({ path: "itx.greeter" });
  const winA = await itxA.invokeCapability(["itx", "greeter", ["hello"]]);
  // shadow stack: revoke restores what was beneath
  expect(winA).toBe("from A");
  await itxA.revoke({ path: "itx.greeter" });
  let denied = "";
  try {
    await itxA.invokeCapability(["itx", "greeter", ["hello"]]);
  } catch (e) {
    denied = String(e);
  }
  // default-deny after last revoke
  expect(denied).toMatch(/no capability matches/);

  // 5. EXPRESSION MOUNT running a stateless dynamic worker (the fetch lane end-to-end)
  await itxA.provide({
    path: "itx.site",
    target: "itx.load(['itx', 'kv', ['get', 'src/site.js']]).getEntrypoint()",
  });
  const page = await fetch(capUrl("http"));
  const html = await page.text();
  // mounted worker serves HTML via /cap
  expect(page.status).toBe(200);
  expect(html).toContain("dynamic web capability");
  const ws = new WebSocket(capUrl("ws"));
  const wsEcho = await new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws timeout")), 8000);
    ws.addEventListener("open", () => ws.send("hello-from-eyeball"));
    ws.addEventListener("message", (e: MessageEvent) => {
      clearTimeout(t);
      resolve(e.data);
      ws.close();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    });
  });
  // WebSocket 101 through the mounted worker
  expect(wsEcho).toBe("site-echo:hello-from-eyeball");

  // 6. EXPRESSION MOUNT running a STATEFUL worker — deep dotted call + callback into the host
  await itxA.provide({
    path: "itx.counter",
    target:
      "itx.load(['itx', 'kv', ['get', 'src/counter.js']]).getDurableObjectClass('Counter').get()",
  });
  const inc = await itxA.invokeCapability(["itx", "counter", ["increment", 2]]);
  // stateful worker: increment(2)
  expect(inc).toBe(2);
  const deep = await itxA.invokeCapability(["itx", "counter", "counters", ["add", 3]]);
  // stateful worker: DEEP dotted counters.add(3)
  expect(deep).toBe(5);
  const val = await itxA.invokeCapability(["itx", "counter", ["value"]]);
  // stateful worker: value()
  expect(val).toBe(5);
  const whoDeep = await itxA.invokeCapability(["itx", "counter", ["whoAmI"]]);
  // stateful worker calls BACK through env.ITX
  expect(whoDeep?.projectId).toBe(ctx);

  // 7. the rpcStubs view: list (held stub keys), single-target get, fan-out via list() + map
  const heldStubs = await itxA.invokeCapability("itx.rpcStubs.list()");
  // rpcStubs.list shows both keyed stubs
  expect(Array.isArray(heldStubs)).toBe(true);
  expect(["a", "b"].every((k) => heldStubs.some((c: { key: string }) => c.key === k))).toBe(true);
  const single = await itxA.invokeCapability("itx.rpcStubs.get('b').hello()");
  // rpcStubs.get(key) reaches ONE stub
  expect(single).toBe("from B");
  // fan-out is list() + map over get(key) — no built-in `each`; the caller owns the allSettled.
  const stubKeys = (await itxA.invokeCapability("itx.rpcStubs.list()")).map(
    (r: { key: string }) => r.key,
  );
  const fans = (
    await Promise.all(
      stubKeys.map((k: string) =>
        itxA.invokeCapability(`itx.rpcStubs.get('${k}').hello()`).catch(() => undefined),
      ),
    )
  ).filter((v: unknown) => v !== undefined);
  // fan-out via rpcStubs.list() + map (no each) reaches every held stub
  expect(fans).toContain("from B");
  expect(fans).toContain("from A");

  // 8. /version
  const version = (await (await fetch(new URL("/version", base()))).text()).trim();
  // /version
  expect(version.length).toBeGreaterThan(0);
});
