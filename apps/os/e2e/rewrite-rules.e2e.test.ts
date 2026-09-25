// rewrite-rules.e2e.test.ts — the REWRITE-RULE TABLE end to end (context/itx-expression-rewriting.ts
// through the real DO). `itx.builtins.<root>` is the physical scope and the fixed point of rewriting;
// every short name `itx.<root>` is the implicit platform row `itx.<root> ⇒ itx.builtins.<root>`,
// consulted only after the context's own rows. (The resolver's own rows — the depth budget, longest
// match wins, a longer match under a target's prefix — are context/itx-expression-rewriting.test.ts;
// the table as a MAP and a null's delete are __workers-tests__/do-entry-points.test.ts +
// src/stream/core-processor.test.ts.) Pins:
//   • a provided stub at a built-in's name SHADOWS it (the real root: ai-root-shadow-and-fable.e2e); a
//     dead stub's un-set leaves a user's alias to the shadowed root alone, in either configuration order
//   • `provide(match, null)` at a built-in's name is a MASK the handle's dispose lifts; the built-in
//     still answers; the platform-equivalent target deletes the row
//   • `rewriteRules.list()` is the EFFECTIVE table, described, each row with the context it came from
//     (a bare null lists only the context's own rows); `get(match)` canonicalizes the caller's spelling; `resolve(call)` is the
//     pure chain and `invoke(call) ≡ invoke(resolve(call).at(-1))`; `invoke(call, ...args)` applies
//     live args
//   • A BARE `itx` ROW with a target answers every name no implicit row claims (at a child: every
//     project root; the context's own log stays its own); it may not name its OWN context
//   • append refuses a match at `itx.builtins` or at a proxy verb; the platform never spells a short
//     name, so a row at `itx.rpcStubs` or `itx.facets` redirects nothing the platform relies on
//   • an EXPRESSION handle's dispose removes the row it wrote (compare-and-set on the printed target);
//     RED (`createFailing`): while the stream is paused the removal is refused and forgotten
//   • a match may PIN literal args on a call step: `itx.llm.run('special')` beats `itx.llm.run`, the
//     pinned args are consumed, a client's stub can sit behind a pinned match, un-set by that spelling
//   • the table under concurrency: 5 re-sets of ONE match leave one row, the last committed; a
//     NON-CANONICAL match is stored CANONICAL; the newest of 300 rules still rewrites (how fast is
//     perf/rewrite-rules.perf.test.ts); malformed rule events are refused at the append boundary

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { errorCode } from "iterate/lib";
import {
  adminCredentials,
  freshCtx,
  openItx,
  readAll,
  rejection,
  ruleMatchAtRest,
  session,
  sleep,
  until,
} from "./support/client.ts";

// ── the reserved root ──

// A dead stub's un-set removes what NAMES its key, decided against a frozen table
// (context/itx-expression-rewriting.test.ts) — so a user's alias to the shadowed root survives, in
// either configuration order, and resolves to the platform row beneath once the fake is gone.
for (const order of ["alias first", "stub first"] as const)
  test(`a user's alias to a shadowed root survives the shadow's stub dying (${order}) — it resolves to the platform row beneath`, async () => {
    const ctx = freshCtx("alias-survives");
    const itx = openItx(ctx);
    const real = await itx.whoami();
    const stubSession = session();
    const stubItx = stubSession.authenticate(adminCredentials()).projects.get(ctx);
    const alias = () => itx.provide("itx.me", "itx.whoami");
    const fake = () => stubItx.provide("itx.whoami", () => "the fake");
    for (const step of order === "alias first" ? [alias, fake] : [fake, alias]) await step();
    expect(await itx.me()).toBe("the fake");

    stubSession[Symbol.dispose]();
    await until("the real whoami is back", async () => {
      const row = await itx.rewriteRules.get("itx.whoami");
      return row?.target === "itx.builtins.whoami" ? row : undefined; // the implicit row shows again
    });
    expect(await itx.rewriteRules.get("itx.me")).toEqual({
      match: "itx.me",
      target: "itx.whoami",
      context: "/",
    });
    expect((await itx.rewriteRules.resolve("itx.me()")).at(-1)).toBe("itx.builtins.whoami()");
    expect(await itx.me()).toEqual(real);
  });

test("a DENY: provide(match, null) at a built-in's name masks it; the built-in still answers; disposing the deny lifts it", async () => {
  const ctx = freshCtx("mask");
  const itx = openItx(ctx);
  await itx.kv.put("k", "v");
  const deny = await itx.provide("itx.kv", null);
  const refused = await rejection(itx.kv.get("k"));
  expect(errorCode(refused)).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(String((refused as Error).message)).toMatch(/is masked/);
  expect(await itx.builtins.kv.get("k")).toBe("v");
  expect(await itx.rewriteRules.get("itx.kv")).toEqual({
    match: "itx.kv",
    target: null,
    context: "/",
  });
  // a partial mask under the root refuses only what it claims
  await itx.provide("itx.kv.put", null);
  expect(await itx.builtins.kv.get("k")).toBe("v"); // the built-in still answers
  deny[Symbol.dispose]();
  await until("the deny lifted", async () =>
    (await itx.rewriteRules.get("itx.kv"))?.target === "itx.builtins.kv" ? true : undefined,
  );
  expect(await itx.kv.get("k")).toBe("v");
  expect(errorCode(await rejection(itx.kv.put("k", "w")))).toBe("NO_ITX_EXPRESSION_MATCH"); // the partial mask stands
  // a pinned physical target under the root is a GRANT of exactly that call (the rewrite-rule reduce, stream/core-processor.ts): the row is
  // stored — and re-opens the prefix the partial mask closed
  await itx.provide("itx.kv.put", "itx.builtins.kv.put");
  expect(await itx.rewriteRules.get("itx.kv.put")).toMatchObject({ target: "itx.builtins.kv.put" });
  expect(await itx.kv.put("k", "w")).toEqual({ ok: true });
});

test("rewriteRules.list() is the EFFECTIVE table, DESCRIBED: every implicit row at the root with the platform's one-liner and the context it belongs to; a re-set root shown once as the context's row", async () => {
  const ctx = freshCtx("list");
  const itx = openItx(ctx);
  const before = (await itx.rewriteRules.list()) as {
    match: string;
    target: string | null;
    description?: string;
    context: string;
  }[];
  expect(before.find((row) => row.match === "itx.kv")).toEqual({
    match: "itx.kv",
    target: "itx.builtins.kv",
    description: expect.stringContaining("key-value"),
    context: "/",
  });
  expect(before.find((row) => row.match === "itx.append")).toMatchObject({
    target: "itx.builtins.append",
    description: expect.any(String),
  });
  expect(before.every((row) => row.context === "/" && row.description)).toBe(true);

  await itx.provide("itx.kv", "itx.builtins.whoami", { description: "who, not what" });
  const after = (await itx.rewriteRules.list()) as typeof before;
  expect(after.filter((row) => row.match === "itx.kv")).toEqual([
    { match: "itx.kv", target: "itx.builtins.whoami", description: "who, not what", context: "/" },
  ]);
  expect(after.length).toBe(before.length); // the context row REPLACED the implicit row in the listing
});

test("rewriteRules.list() under a bare row WITH a target still shows every implicit row (they outrank it) plus the row itself; a bare NULL lists only the context's own rows; `itx ⇒ itx.builtins` at the root restates the default and deletes", async () => {
  const itx = openItx(freshCtx("list-under-override"));
  const list = () => itx.rewriteRules.list() as Promise<{ match: string; target: string | null }[]>;
  const implicit = (await list()).length;
  expect(implicit).toBeGreaterThan(10);
  await itx.provide("itx", "itx.builtins.rpcStubs.get('x')");
  const rows = await list();
  expect(rows).toHaveLength(implicit + 1);
  expect(rows.find((row) => row.match === "itx")).toMatchObject({
    target: "itx.builtins.rpcStubs.get('x')",
  });
  await itx.provide("itx", "itx.builtins"); // at the owner root this restates the default: the row is gone
  expect(await list()).toHaveLength(implicit);
  await itx.provide("itx", null); // one row denies all: nothing implicit is listed, nothing resolves
  expect(await itx.builtins.rewriteRules.list()).toEqual([
    { match: "itx", target: null, context: "/" },
  ]);
  expect(errorCode(await rejection(itx.whoami()))).toBe("NO_ITX_EXPRESSION_MATCH");
});

// An EXPRESSION handle's undo is compare-and-set on the row's target: `#removeRuleInBackground`
// (src/iterate-context.ts) removes the row only while its target is still the one this handle wrote —
// spelled the way `rewriteRules.get` spells it (PRINTED, with holes), since the appended event carries
// the PARSED form.
test("disposing an EXPRESSION provide handle removes the rule it wrote — the platform row beneath shows through again", async () => {
  const itx = openItx(freshCtx("expression-dispose"));
  const handle = await itx.provide("itx.kv", "itx.builtins.whoami");
  expect(await itx.rewriteRules.get("itx.kv")).toMatchObject({
    target: "itx.builtins.whoami",
    context: "/",
  });
  handle[Symbol.dispose]();
  await until(
    "the implicit row back",
    async () =>
      (await itx.rewriteRules.get("itx.kv"))?.target === "itx.builtins.kv" ? true : undefined,
    5_000,
  );
});

test("rewriteRules.get(match) canonicalizes the caller's spelling — whitespace, quotes, key order — before the lookup", async () => {
  const itx = openItx(freshCtx("get-canonical"));
  await itx.provide("itx.ai.run('x', {b:1, a:2})", "itx.builtins.whoami");
  for (const spelling of [
    "itx.ai.run('x',{a:2,b:1})",
    'itx.ai.run("x", { b: 1, a: 2 })',
    "itx.ai.run( 'x' , {b:1, a:2} )",
  ])
    expect((await itx.rewriteRules.get(spelling))?.target).toBe("itx.builtins.whoami");
  expect(await itx.rewriteRules.get("not an expression at all")).toBeNull();
});

test("resolve(call) is the pure chain, and THE LAW holds: invoke(call) ≡ invoke(resolve(call).at(-1)); invoke(call, ...args) applies live args", async () => {
  const ctx = freshCtx("resolve");
  const itx = openItx(ctx);
  await itx.kv.put("k", "v");
  await itx.provide("itx.db", "itx.kv");
  await itx.provide("itx.store", "itx.db");
  expect(await itx.rewriteRules.resolve("itx.store.get('k')")).toEqual([
    "itx.store.get('k')",
    "itx.db.get('k')",
    "itx.kv.get('k')",
    "itx.builtins.kv.get('k')",
  ]);
  expect(await itx.rewriteRules.resolve("itx.builtins.kv.get('k')")).toEqual([
    "itx.builtins.kv.get('k')",
  ]);
  for (const call of ["itx.store.get('k')", "itx.whoami()", "itx.builtins.kv.get('k')"]) {
    const chain = (await itx.rewriteRules.resolve(call)) as string[];
    expect(await itx.invoke(chain.at(-1)!)).toEqual(await itx.invoke(call));
  }
  // a refused call resolves to the same refusal (the chain is what would run — nothing runs)
  expect(errorCode(await rejection(itx.rewriteRules.resolve("itx.nope.x()")))).toBe(
    "NO_ITX_EXPRESSION_MATCH",
  );
  // live args: the string is the pure part, the args the live part
  expect(await itx.invoke("itx.kv.get", "k")).toBe("v");
  expect(await itx.invoke("itx.store.get", "k")).toBe("v");
  expect(await itx.invoke("itx.whoami()")).toMatchObject({ projectId: ctx }); // no args: the call as spelled
});

test("A BARE `itx` ROW WITH A TARGET at a child: a live capability answers every name no implicit row claims — the context's own log stays its own; `builtins` is the unmaskable built-in", async () => {
  const ctx = freshCtx("override");
  const root = openItx(ctx);
  const live = new Override();
  const override = await root.cd("/x").provide("itx", live);
  // the context roots are implicit at a child and OUTRANK the bare row: append lands in /x's log
  const [landed] = await root.cd("/x").append({ type: "t", payload: { n: 1 } });
  expect(landed).toMatchObject({ type: "t", payload: { n: 1 } });
  expect(await root.cd("/x").whoami()).toEqual({ projectId: ctx, path: "/x" });
  // a name nothing implicit claims goes to the stub — at a child that includes every project root
  expect(await root.cd("/x").anything({ type: "t", payload: { n: 2 } })).toBe("captured");
  expect(live).toMatchObject({ seen: [{ type: "t", payload: { n: 2 } }] });
  expect(await root.cd("/x").kv()).toBe("the override"); // `kv` is no context root: the row answers
  // an EXPRESSION-side cd from the root goes through /x's rows too
  expect(await root.invoke("itx.cd('/x').anything(3)")).toBe("captured");
  expect(await root.invoke("itx.cd('/x').builtins.whoami()")).toEqual({
    projectId: ctx,
    path: "/x",
  });
  override[Symbol.dispose]();
  await until("the override gone", async () => {
    const row = await root.cd("/x").builtins.rewriteRules.get("itx");
    return row === null ? true : undefined;
  });
  expect(errorCode(await rejection(root.cd("/x").kv.get("k")))).toBe("NO_ITX_EXPRESSION_MATCH"); // nothing project-level is implicit at a child
});

test("append refuses a match rooted at itx.builtins or at a proxy verb; the platform never spells a short name", async () => {
  const ctx = freshCtx("refusals");
  const itx = openItx(ctx);
  expect(String((await rejection(itx.provide("itx.builtins.kv", "itx.whoami"))).message)).toMatch(
    /may not be rooted at "itx\.builtins"/,
  );
  expect(String((await rejection(itx.provide("itx.provide", "itx.whoami"))).message)).toMatch(
    /proxy's own verb "provide"/,
  );
  // `cd` is a NAME: a row at it is legal (a null there is the wall a jail relies on)
  (await itx.provide("itx.cd('/y')", "itx.whoami"))[Symbol.dispose]();
  // what the platform writes is builtins-rooted, so a row at `itx.rpcStubs` or `itx.facets`
  // redirects the caller's calls and nothing the platform relies on
  await itx.provide("itx.rpcStubs", null);
  await itx.provide("itx.tool", () => "still served");
  expect(await itx.tool()).toBe("still served");
  expect(errorCode(await rejection(itx.rpcStubs.list()))).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(await itx.builtins.rpcStubs.list()).toContain("itx.tool");
  const events = await readAll(itx);
  const ruleTargets = events
    .filter((e) => e.type === "events.iterate.com/itx/rewrite-rule-configured" && e.payload.target)
    .map((e) => e.payload.target as string);
  expect(ruleTargets).toContainEqual(["itx", "builtins", "rpcStubs", ["get", "itx.tool"]]);
});

test("append refuses a whole-context override that names its OWN context (every call would route back into itself, a fresh resolve per hop); a sibling context is fine", async () => {
  const itx = openItx(freshCtx("own-context-override")).cd("/x");
  for (const target of ["itx.builtins.cd('/x')", "itx.builtins.cd('.')"])
    expect((await rejection(itx.provide("itx", target))).message).toMatch(/own context/);
  // …spelled short as well: `cd` is implicit and outranks the bare row, so `itx.cd('/x')` resolves
  // to the built-in and the same self-hop is refused
  for (const target of ["itx.cd('/x')", "itx.cd('../x')"])
    expect((await rejection(itx.provide("itx", target))).message).toMatch(/own context/);
  const sibling = await itx.provide("itx", "itx.builtins.cd('/y')");
  sibling[Symbol.dispose]();
});

// RED (a `createFailing` pin — a known defect, too costly to fix now): an EXPRESSION handle's undo is a
// compare-and-set that runs in the edge's waitUntil and DISCARDS its failure; while the stream is
// paused the removal is refused (STREAM_PAUSED) and forgotten, so the session-scoped row outlives its
// handle forever. The fix is a retained, observable removal (retry after resume) — a new mechanism.
createFailing(test, /until\(the rule disposed while paused is gone after resume\): timed out/, {
  timeoutMs: 60_000,
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
})(
  "disposing an EXPRESSION provide handle while the stream is paused removes the rule once the stream resumes",
  async () => {
    const itx = openItx(freshCtx("expression-dispose-paused"));
    const handle = await itx.provide("itx.paused", "itx.builtins.whoami");
    await itx.append({ type: "events.iterate.com/itx/paused" });
    handle[Symbol.dispose]();
    await sleep(500);
    await itx.append({ type: "events.iterate.com/itx/resumed" });
    await until(
      "the rule disposed while paused is gone after resume",
      async () => ((await itx.rewriteRules.get("itx.paused")) === null ? true : undefined),
      3_000,
    );
  },
);

// ── a match with PINNED arguments (rules 1–3; `llm` is no built-in root, so nothing lies beneath these
// rows — `itx.ai` would fall to its platform row): `itx.llm.run('special')` is a more specific rule
// than `itx.llm.run`, matched by structural equality of the leading args and CONSUMED by the match
// (partial application) — the target sees only the unpinned args ──

test("itx.llm.run('special') rewrites past the plain itx.llm.run rule; pinned args are consumed; a client's rpc stub can sit behind a pinned match", async () => {
  const ctx = freshCtx("pinned");
  const itx = openItx(ctx);
  await itx.provide("itx.llm.run", "itx.kv.get"); // the plain rule: itx.llm.run(k) → itx.kv.get(k)
  await itx.provide("itx.llm.run('special')", "itx.whoami"); // pinned: itx.llm.run('special') → itx.whoami()
  await itx.invoke("itx.kv.put('other', 'from-kv')");
  expect(await itx.invoke("itx.llm.run('special')")).toMatchObject({ projectId: ctx });
  expect(await itx.invoke("itx.llm.run('other')")).toBe("from-kv");
  // a live capnweb value behind a pinned match — the pinned arg never reaches it
  await itx.provide(
    "itx.llm.run('live')",
    (...unpinned: unknown[]) => `live:${JSON.stringify(unpinned)}`,
  );
  expect(await itx.invoke("itx.llm.run('live', 7)")).toBe("live:[7]");
  // the table is a MAP keyed by the CANONICAL pinned spelling; each row carries the parsed match
  const snap: any = await itx.invoke("itx.facets.get('core').snapshot()");
  expect(Object.keys(snap.state.itxExpressionRewriteRules)).toEqual(
    expect.arrayContaining(["itx.llm.run('special')", "itx.llm.run('live')"]),
  );
  expect(snap.state.itxExpressionRewriteRules["itx.llm.run('special')"]).toMatchObject({
    match: ["itx", "llm", ["run", "special"]],
  });
  // un-setting by the canonical pinned spelling deletes exactly that rule; the plain rule (less specific,
  // `pickItxExpressionRewriteRule`) matches the call from now on
  await itx.provide("itx.llm.run('special')", null);
  expect(await itx.invoke("itx.llm.run('special')")).toBeNull(); // the plain rule → kv.get('special') → null
});

// ── the table under stress ──

test("the table is a MAP under concurrency: 5 concurrent re-sets of ONE match leave exactly one row — the last-committed target — and the match follows it", async () => {
  const itx = openItx(freshCtx("map"));
  // five distinguishable client rpc stubs, each behind its own rule
  for (let i = 0; i < 5; i++) await itx.provide(`itx.probe${i}`, () => i);

  // five concurrent re-sets of itx.race — one event each, one row survives: the LAST committed
  await Promise.all(Array.from({ length: 5 }, (_, i) => itx.provide("itx.race", `itx.probe${i}`)));
  const configured = (await readAll(itx)).filter(
    (e) =>
      e.type === "events.iterate.com/itx/rewrite-rule-configured" &&
      ruleMatchAtRest(e) === "itx.race",
  );
  expect(configured).toHaveLength(5); // every re-set appended exactly one event
  const lastTarget = (configured.at(-1)!.payload.target as string[]).join("."); // at rest the parsed form; `get()` prints
  expect(await itx.rewriteRules.get("itx.race")).toEqual({
    match: "itx.race",
    target: lastTarget,
    context: "/",
  });
  expect(
    (await itx.rewriteRules.list()).filter((r: { match: string }) => r.match === "itx.race"),
  ).toHaveLength(1); // a map: same-match rules never coexist
  expect(await itx.invoke(["itx", ["race"]])).toBe(Number(lastTarget.slice("itx.probe".length)));
});

test("a NON-CANONICAL match spelling through provide is stored CANONICAL and rewrites", async () => {
  // The one-canonicalizer pin: provide canonicalizes ONCE at the top, so the reduce stores
  // exactly the match every later step (dispatch, un-set by match) compares against — a stray space
  // can never mint a row no call reaches.
  const ctx = freshCtx("canon");
  const itx = openItx(ctx);
  await itx.provide(" itx.ghost", "itx.whoami");
  const snap = await itx.invoke("itx.facets.get('core').snapshot()");
  expect(snap.state.itxExpressionRewriteRules["itx.ghost"]).toMatchObject({
    match: ["itx", "ghost"],
    target: ["itx", "whoami"],
  }); // stored CANONICAL, parsed
  expect(await itx.invoke(["itx", ["ghost"]])).toMatchObject({ projectId: ctx }); // and rewritten
  await itx.provide("itx.ghost", null); // the canonical spelling is what the un-set finds
  const err = await rejection(itx.invoke(["itx", ["ghost"]]));
  expect(errorCode(err)).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(err.message).toContain("no rewrite rule matches");
});

test("300 rules: the NEWEST rule still rewrites", async () => {
  const ctx = freshCtx("rules300");
  const itx = openItx(ctx);
  // Rules are event-sourced — append all 300 rewrite-rule-configured events in ONE commit.
  const rules = Array.from({ length: 300 }, (_, i) => ({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: `itx.m${i}`, target: ["itx", "whoami"] },
  }));
  expect(await itx.append(...rules)).toHaveLength(300);
  expect(await itx.invoke(["itx", ["m299"]])).toMatchObject({ projectId: ctx, path: "/" });
});

test("malformed rewrite-rule events are REFUSED at the append boundary — no dead-weight row ever enters the log", async () => {
  const ctx = freshCtx("badrule");
  const itx = openItx(ctx);
  // The append BOUNDARY validates every control event (core-processor `normalizeControlEvent`), so a
  // malformed rewrite-rule is rejected at append — not committed and then skipped at the reduce.
  // An unparseable target:
  const unparseable = await rejection(
    itx.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.broken", target: "((((" },
    }),
    "an unparseable target",
  );
  expect(unparseable.message).toMatch(/expected|itx/i);
  // NO payload at all:
  await rejection(
    itx.append({ type: "events.iterate.com/itx/rewrite-rule-configured" }),
    "a payload-less rewrite rule",
  );
  // wrong shapes inside the payload:
  await rejection(
    itx.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: 42, target: ["not", "a", "string"] },
    }),
    "wrong payload shapes",
  );
  // the table is untouched — it still takes rules and resolves them (no refusal wedged append)
  await itx.provide("itx.hello", "itx.whoami");
  expect(await itx.invoke(["itx", ["hello"]])).toMatchObject({ projectId: ctx });
  // and the refused match is no row at all (default-deny answers there)
  const missErr = await rejection(itx.invoke(["itx", ["broken"]]));
  expect(errorCode(missErr)).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(await itx.rewriteRules.get("itx.broken")).toBeNull();
});

/** A whole context's worth of capability, lent live (a plain object would ride by VALUE; a stub must
 *  be an RpcTarget or a bare function). */
class Override extends RpcTarget {
  readonly seen: unknown[] = [];
  anything(...events: unknown[]) {
    this.seen.push(...events);
    return "captured";
  }
  kv() {
    return "the override";
  }
}
