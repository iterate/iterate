// rewrite-rules-tour.e2e.test.ts — the itx surface, toured end to end against the local
// project-worker. Covers: the built-in roots through the ONE dispatch door, live values through the
// ONE provide door (an opaque rpcStubKey the stub is lent under + the REWRITE RULE that names it),
// THE MAP (a re-set replaces, setting the old target back restores, null deletes — on expression
// rules), expression rules running dynamic workers (stateless fetch+WS, stateful deep call), the two
// views of a lent stub — PRESENCE (`itx.rpcStubs.list()`, physical) and the table's LIVE RULES (rows
// targeting the registry, pure data) — default-deny, and the warm paged-in stub.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import {
  codeOf,
  expressionUrl,
  freshCtx,
  presence,
  rpcStubRewriteRuleMatches,
  session,
  workerUrl,
} from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

test("itx tour: built-in roots, lent stubs, the rule map, dynamic-worker rules, the two views", async () => {
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
  await itxA.provide("itx.proverA", { stub: new ToolsA(), rewrite: "itx.proverA" });
  const itxB = await session().authenticate().projects.get(ctx);
  await itxB.provide("itx.proverB", { stub: new ToolsB(), rewrite: "itx.proverB" });
  await seedSources(itxA, ["site", "counter"]);

  // 1. whoami — a built-in root, reached through the ONE dispatch door
  const who = await itxA.invoke(["itx", ["whoami"]]);
  // 1b. the authenticate() introduction door (a NO-OP today; the shape the real gate lands in)
  const whoAuth = await sessionA
    .authenticate({ token: "ignored-today" })
    .projects.get(ctx)
    .invoke(["itx", ["whoami"]]);
  // authenticate() introduction door
  expect(whoAuth?.projectId).toBe(ctx);
  // whoami through the dispatch door
  expect(who?.projectId).toBe(ctx);

  // 2. kv — the built-in root, project-prefixed
  await itxA.invoke(["itx", "kv", ["put", "greet", "hi-crisp"]]);
  const got = await itxA.invoke(["itx", "kv", ["get", "greet"]]);
  // kv round-trip through the dispatch door
  expect(got).toBe("hi-crisp");

  // 3. a lent stub: provide from A through the ONE door (rpcStubKey + the rule naming it), invoke from B
  await itxA.provide("itx.tools", { stub: new ToolsA(), rewrite: "itx.tools" });
  const echoed = await itxB.invoke(["itx", "tools", ["echo", "hello"]]);
  // lent stub: B invokes A's provider
  expect(echoed).toBe("echo-A:hello");
  // THE TWO VIEWS of the three lent stubs (proverA, proverB, tools): PRESENCE is the registry —
  // `itx.rpcStubs.list()` names every key with an open transport; the TABLE holds their rules —
  // ordinary rows whose target is `itx.rpcStubs.get('<rpcStubKey>')`. The echoed call above already
  // proved a paged-in stub SERVES; the raw socket counters are the DO-only transportState(), off this
  // capnweb lane.
  const online = await presence(itxA);
  const liveRuleMatches = await rpcStubRewriteRuleMatches(itxA);
  for (const p of ["itx.proverA", "itx.proverB", "itx.tools"]) {
    expect(online).toContain(p);
    expect(liveRuleMatches).toContain(p);
  }

  // 4. THE MAP: the same match set twice — a re-set REPLACES (no stack, no identity beyond the
  //    match); setting the old target back RESTORES it; null DELETES it. Proven on DISTINCT
  //    EXPRESSION rules: each provider lends its stub behind its own rule, then points itx.greeter
  //    at that rule.
  await itxA.provide("itx.greeterA", { stub: new ToolsA(), rewrite: "itx.greeterA" });
  await itxA.rewrite("itx.greeter", "itx.greeterA");
  await itxB.provide("itx.greeterB", { stub: new ToolsB(), rewrite: "itx.greeterB" });
  await itxB.rewrite("itx.greeter", "itx.greeterB");
  const winB = await itxA.invoke(["itx", "greeter", ["hello"]]);
  // the map: a re-set replaces
  expect(winB).toBe("from B");
  expect(
    (await itxA.expressionRewriteRules.list()).filter(
      (r: { match: string }) => r.match === "itx.greeter",
    ),
  ).toHaveLength(1); // ONE row per match — nothing is kept "beneath"
  await itxB.rewrite("itx.greeter", "itx.greeterA");
  const winA = await itxA.invoke(["itx", "greeter", ["hello"]]);
  // the map: setting the old target back restores it
  expect(winA).toBe("from A");
  await itxA.rewrite("itx.greeter", null);
  let denied: unknown;
  try {
    await itxA.invoke(["itx", "greeter", ["hello"]]);
  } catch (e) {
    denied = e;
  }
  // default-deny after the delete
  expect(codeOf(denied)).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(String(denied)).toMatch(/no rewrite rule matches/);

  // 5. EXPRESSION RULE running a stateless dynamic worker (the fetch lane end-to-end)
  await itxA.rewrite("itx.site", "itx.load(['itx', 'kv', ['get', 'src/site.js']]).getEntrypoint()");
  const page = await fetch(expressionUrl(ctx, "itx.site", "http"));
  const html = await page.text();
  // the loaded worker serves HTML via /expression
  expect(page.status).toBe(200);
  expect(html).toContain("dynamic web capability");
  const ws = new WebSocket(expressionUrl(ctx, "itx.site", "ws"));
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
  // WebSocket 101 through the loaded worker
  expect(wsEcho).toBe("site-echo:hello-from-eyeball");

  // 6. EXPRESSION RULE running a STATEFUL worker — deep dotted call + callback into the host
  await itxA.rewrite(
    "itx.counter",
    "itx.load(['itx', 'kv', ['get', 'src/counter.js']]).getDurableObjectClass('CounterDurableObject').get()",
  );
  const inc = await itxA.invoke(["itx", "counter", ["increment", 2]]);
  // stateful worker: increment(2)
  expect(inc).toBe(2);
  const deep = await itxA.invoke(["itx", "counter", "counters", ["add", 3]]);
  // stateful worker: DEEP dotted counters.add(3)
  expect(deep).toBe(5);
  const val = await itxA.invoke(["itx", "counter", ["value"]]);
  // stateful worker: value()
  expect(val).toBe(5);
  const whoDeep = await itxA.invoke(["itx", "counter", ["whoAmI"]]);
  // stateful worker calls BACK through env.ITX
  expect(whoDeep?.projectId).toBe(ctx);

  // 7. PRESENCE is the registry (`itx.rpcStubs.list()` — no polling: a provide resolves only
  //    after its pager is open, and the greeter re-sets above touched RULES, never stubs), a
  //    dotted single-target call, and fan-out via presence + map over the keys.
  const liveKeys = await presence(itxA);
  // the registry lists both provers (and their rules are still in the table — data, untouched)
  expect(liveKeys).toContain("itx.proverA");
  expect(liveKeys).toContain("itx.proverB");
  expect(await rpcStubRewriteRuleMatches(itxA)).toEqual(
    expect.arrayContaining(["itx.proverA", "itx.proverB"]),
  );
  const single = await itxA.invoke("itx.proverB.hello()");
  // the dotted match reaches ONE lent stub
  expect(single).toBe("from B");
  // fan-out is presence + map over the keys — no built-in `each`; the caller owns the allSettled.
  // (Every key here was lent with `rewrite` equal to its rpcStubKey, so a key IS a callable match.)
  const fans = (
    await Promise.all(
      liveKeys.map((k: string) => itxA.invoke(`${k}.hello()`).catch(() => undefined)),
    )
  ).filter((v: unknown) => v !== undefined);
  // fan-out via the registry's keys + map (no each) reaches every held stub
  expect(fans).toContain("from B");
  expect(fans).toContain("from A");

  // 8. /version — the deploy stamp a smoke test waits for (CODE_VERSION in worker.ts)
  const versionRes = await fetch(workerUrl("/version"));
  expect(versionRes.status).toBe(200);
  expect((await versionRes.text()).trim()).toMatch(/^live-\d+$/);
});
