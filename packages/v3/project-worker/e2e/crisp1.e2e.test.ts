// crisp1.e2e.test.ts — the crisp-1 architecture proof against the local project-worker.
// Covers: routing seeds, live caps through the ONE provide door (the mount path IS the stub's
// identity), THE SHADOW STACK (override → revoke → restore, on expression mounts), expression
// mounts running dynamic workers (stateless fetch+WS, stateful deep call), the capability-table
// presence view (live rows), default-deny, and the warm paged-in stub.
// (was proofs/prove_crisp1.mjs)

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, session, until } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

// The one raw HTTP door with no capnweb equivalent is /cap (fetch-shaped caps + WS upgrades) and
// /version. Reach them on the same local worker the session speaks to (URL from global-setup).
const base = (): string => {
  const u = process.env.WORKER_BASE_URL;
  if (!u) throw new Error("WORKER_BASE_URL unset — the e2e globalSetup/setup did not run");
  return u;
};

test("crisp-1: routing, live caps, shadow stack, dynamic-worker mounts, capability-table view", async () => {
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
  await itxA.provide("itx.proverA", new ToolsA());
  const itxB = await session(ctx).get();
  await itxB.provide("itx.proverB", new ToolsB());
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

  // 3. live capability: provide from A through the ONE door (the path IS the identity), invoke from B
  await itxA.provide("itx.tools", new ToolsA());
  const echoed = await itxB.invokeCapability(["itx", "tools", ["echo", "hello"]]);
  // live cap: B invokes A's provider
  expect(echoed).toBe("echo-A:hello");
  // PRESENCE: three live rows in the capability table (proverA, proverB, tools — the mount path
  // IS each stub's identity; the echoed call above already proved a paged-in stub SERVES, and the
  // raw socket counters are the DO-only transportState(), off this capnweb lane).
  const s1 = await itxA.invokeCapability("itx.facets.get('capability-table').snapshot()");
  const liveNow = (s1?.state?.mounts ?? []).filter((m: { live?: true }) => m.live);
  expect(liveNow.length).toBeGreaterThanOrEqual(3);

  // 4. THE SHADOW STACK: same path mounted twice — newest wins; revoking the mount restores.
  //    Live rows don't stack (one live row per path, superseded in place), so the stack is proven
  //    on EXPRESSION mounts: each provider parks its live stub at its own path, then alias-mounts
  //    itx.greeter onto it — expression mounts keep full shadow-stack semantics.
  await itxA.provide("itx.greeterA", new ToolsA());
  await itxA.provide("itx.greeter", "itx.greeterA");
  await itxB.provide("itx.greeterB", new ToolsB());
  await itxB.provide("itx.greeter", "itx.greeterB");
  const winB = await itxA.invokeCapability(["itx", "greeter", ["hello"]]);
  // shadow stack: newest mount wins
  expect(winB).toBe("from B");
  await itxB.revoke("itx.greeter");
  const winA = await itxA.invokeCapability(["itx", "greeter", ["hello"]]);
  // shadow stack: revoke restores what was beneath
  expect(winA).toBe("from A");
  await itxA.revoke("itx.greeter");
  let denied = "";
  try {
    await itxA.invokeCapability(["itx", "greeter", ["hello"]]);
  } catch (e) {
    denied = String(e);
  }
  // default-deny after last revoke
  expect(denied).toMatch(/no capability matches/);

  // 5. EXPRESSION MOUNT running a stateless dynamic worker (the fetch lane end-to-end)
  await itxA.provide("itx.site", "itx.load(['itx', 'kv', ['get', 'src/site.js']]).getEntrypoint()");
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
  await itxA.provide(
    "itx.counter",
    "itx.load(['itx', 'kv', ['get', 'src/counter.js']]).getDurableObjectClass('Counter').get()",
  );
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

  // 7. PRESENCE is the capability table: rows where `live` (the path IS each stub's identity),
  //    a dotted single-target call, and fan-out via snapshot + map over the live paths.
  //    Presence reads poll inside `until` — table appends (provides/auto-revokes) are async.
  const liveRows = await until("both prover mounts live in the table", async () => {
    const snap = await itxA.invokeCapability("itx.facets.get('capability-table').snapshot()");
    const rows = (snap?.state?.mounts ?? []).filter((m: { live?: true }) => m.live);
    return ["itx.proverA", "itx.proverB"].every((p) =>
      rows.some((m: { path: string[] }) => m.path.join(".") === p),
    )
      ? rows
      : undefined;
  });
  // the capability table lists both prover mounts as live rows
  expect(Array.isArray(liveRows)).toBe(true);
  expect(
    ["itx.proverA", "itx.proverB"].every((p) =>
      liveRows.some((m: { path: string[] }) => m.path.join(".") === p),
    ),
  ).toBe(true);
  const single = await itxA.invokeCapability("itx.proverB.hello()");
  // the dotted path reaches ONE live capability
  expect(single).toBe("from B");
  // fan-out is snapshot + map over the live paths — no built-in `each`; the caller owns the allSettled.
  const livePaths = liveRows.map((m: { path: string[] }) => m.path.join("."));
  const fans = (
    await Promise.all(
      livePaths.map((p: string) => itxA.invokeCapability(`${p}.hello()`).catch(() => undefined)),
    )
  ).filter((v: unknown) => v !== undefined);
  // fan-out via the table's live rows + map (no each) reaches every held live capability
  expect(fans).toContain("from B");
  expect(fans).toContain("from A");

  // 8. /version
  const version = (await (await fetch(new URL("/version", base()))).text()).trim();
  // /version
  expect(version.length).toBeGreaterThan(0);
});
