// capability-table-tour.e2e.test.ts — the capability table, toured end to end against the local
// project-worker. Covers: the built-in roots through the ONE dispatch door, live caps through the ONE provide door (the mount path IS the registry
// key the stub is parked under), THE SHADOW STACK (override → revoke → restore, on expression
// mounts), expression mounts running dynamic workers (stateless fetch+WS, stateful deep call),
// the two views of a live capability — PRESENCE (`itx.rpcStubs.list()`, physical) and the
// table's live MOUNTS (rows targeting the registry, pure data) — default-deny, and the warm
// paged-in stub.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import {
  capUrl,
  freshCtx,
  presence,
  rpcStubMountPaths,
  session,
  workerUrl,
} from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

test("capability table tour: built-in roots, live caps, shadow stack, dynamic-worker mounts, the two views", async () => {
  const ctx = freshCtx("tour");

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
  const sessionA = session();
  const itxA = await sessionA.authenticate().projects.get(ctx);
  await itxA.provide("itx.proverA", new ToolsA());
  const itxB = await session().authenticate().projects.get(ctx);
  await itxB.provide("itx.proverB", new ToolsB());
  await seedSources(itxA, ["site", "counter"]);

  // 1. whoami — a built-in root, reached through the table via the ONE dispatch door
  const who = await itxA.invokeCapability(["itx", ["whoami"]]);
  // 1b. the authenticate() introduction door (a NO-OP today; the shape the real gate lands in)
  const whoAuth = await sessionA
    .authenticate({ token: "ignored-today" })
    .projects.get(ctx)
    .invokeCapability(["itx", ["whoami"]]);
  // authenticate() introduction door
  expect(whoAuth?.projectId).toBe(ctx);
  // whoami through the table
  expect(who?.projectId).toBe(ctx);

  // 2. kv — the built-in root, project-prefixed
  await itxA.invokeCapability(["itx", "kv", ["put", "greet", "hi-crisp"]]);
  const got = await itxA.invokeCapability(["itx", "kv", ["get", "greet"]]);
  // kv round-trip through the table
  expect(got).toBe("hi-crisp");

  // 3. live capability: provide from A through the ONE door (the path IS the identity), invoke from B
  await itxA.provide("itx.tools", new ToolsA());
  const echoed = await itxB.invokeCapability(["itx", "tools", ["echo", "hello"]]);
  // live cap: B invokes A's provider
  expect(echoed).toBe("echo-A:hello");
  // THE TWO VIEWS of the three live caps (proverA, proverB, tools): PRESENCE is the registry —
  // `itx.rpcStubs.list()` names every key with an open transport (the mount path IS the key);
  // the TABLE holds their mounts — ordinary rows whose target is `itx.rpcStubs.get('<path>')`.
  // The echoed call above already proved a paged-in stub SERVES; the raw socket counters are the
  // DO-only transportState(), off this capnweb lane.
  const online = await presence(itxA);
  const mountedLive = await rpcStubMountPaths(itxA);
  for (const p of ["itx.proverA", "itx.proverB", "itx.tools"]) {
    expect(online).toContain(p);
    expect(mountedLive).toContain(p);
  }

  // 4. THE SHADOW STACK: same path mounted twice — newest wins; revoking the mount restores.
  //    A live mount shadows like any other mount, but the door dedupes an IDENTICAL re-provide
  //    (a reconnect is zero events), so the stack is proven on DISTINCT EXPRESSION mounts: each
  //    provider parks its live stub at its own path, then alias-mounts itx.greeter onto it.
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
  const page = await fetch(capUrl(ctx, "itx.site", "http"));
  const html = await page.text();
  // mounted worker serves HTML via /cap
  expect(page.status).toBe(200);
  expect(html).toContain("dynamic web capability");
  const ws = new WebSocket(capUrl(ctx, "itx.site", "ws"));
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
    "itx.load(['itx', 'kv', ['get', 'src/counter.js']]).getDurableObjectClass('CounterDurableObject').get()",
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

  // 7. PRESENCE is the registry (`itx.rpcStubs.list()` — no polling: a provide resolves only
  //    after its pager is open, and the greeter revokes above popped MOUNTS, never stubs), a
  //    dotted single-target call, and fan-out via presence + map over the keys.
  const livePaths = await presence(itxA);
  // the registry lists both provers (and their mounts are still in the table — data, untouched)
  expect(livePaths).toContain("itx.proverA");
  expect(livePaths).toContain("itx.proverB");
  expect(await rpcStubMountPaths(itxA)).toEqual(
    expect.arrayContaining(["itx.proverA", "itx.proverB"]),
  );
  const single = await itxA.invokeCapability("itx.proverB.hello()");
  // the dotted path reaches ONE live capability
  expect(single).toBe("from B");
  // fan-out is presence + map over the keys — no built-in `each`; the caller owns the allSettled.
  const fans = (
    await Promise.all(
      livePaths.map((p: string) => itxA.invokeCapability(`${p}.hello()`).catch(() => undefined)),
    )
  ).filter((v: unknown) => v !== undefined);
  // fan-out via the registry's keys + map (no each) reaches every held live capability
  expect(fans).toContain("from B");
  expect(fans).toContain("from A");

  // 8. /version — the deploy stamp a smoke test waits for (CODE_VERSION in worker.ts)
  const versionRes = await fetch(workerUrl("/version"));
  expect(versionRes.status).toBe(200);
  expect((await versionRes.text()).trim()).toMatch(/^live-\d+$/);
});
