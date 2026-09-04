// rewrite-rules-builtins-root.e2e.test.ts — THE RESERVED ROOT, end to end. `itx.builtins.<root>` is
// the physical scope and the fixed point of rewriting; every short name `itx.<root>` is the implicit
// platform row `itx.<root> ⇒ itx.builtins.<root>`, consulted only after the context's own rows. So:
// a provided stub at a built-in's name SHADOWS it (Misha's deterministic `itx.ai`) and disposing the
// handle gives the real one back; `provide(match, null)` at a built-in's name is a MASK (the call is
// refused, the physical door still answers) that the handle's dispose lifts; a bare `itx` row at a
// context overrides the WHOLE context, `cd(p).builtins.append(…)` still reaching its log;
// `rewriteRules.list()` shows the platform rows with their origin; `rewriteRules.resolve(call)` is the
// pure chain and `invoke(call) ≡ invoke(resolve(call).at(-1))`; `invoke(call, ...args)` applies live
// args; the door refuses a match at `itx.builtins` or at a proxy verb.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { codeOf, freshCtx, openItx, readAll, rejection, until } from "./support/client.ts";

/** A whole context's worth of capability, lent live (a plain object would ride by VALUE; a stub must
 *  be an RpcTarget or a bare function). */
class Override extends RpcTarget {
  readonly seen: unknown[] = [];
  append(...events: unknown[]) {
    this.seen.push(...events);
    return "captured";
  }
  whoami() {
    return "the override";
  }
}

test("MISHA'S TEST: a provided stub at a built-in's name shadows it; the physical spelling is untouched; disposing the handle restores the real one", async () => {
  const ctx = freshCtx("shadow");
  const itx = openItx(ctx);
  const real = await itx.whoami();
  expect(real).toMatchObject({ projectId: ctx, path: "/" });

  const fake = await itx.provide("itx.whoami", () => ({
    projectId: "fake",
    path: "/deterministic",
  }));
  expect(await itx.whoami()).toEqual({ projectId: "fake", path: "/deterministic" });
  expect(await itx.invoke("itx.whoami()")).toEqual({ projectId: "fake", path: "/deterministic" });
  expect(await itx.builtins.whoami()).toEqual(real); // the physical door is never shadowed
  expect(await itx.rewriteRules.get("itx.whoami")).toEqual({
    match: "itx.whoami",
    target: "itx.builtins.rpcStubs.get('itx.whoami')",
    origin: "context",
  });

  fake[Symbol.dispose]();
  // The DO REMOVES the rule when the stub's last pager closes — the platform row shows through again.
  await until("the real whoami is back", async () => {
    const row = await itx.rewriteRules.get("itx.whoami");
    return row?.origin === "platform" ? row : undefined;
  });
  expect(await itx.whoami()).toEqual(real);
  expect(await itx.rewriteRules.get("itx.whoami")).toEqual({
    match: "itx.whoami",
    target: "itx.builtins.whoami",
    origin: "platform",
  });
});

test("a DENY: provide(match, null) at a built-in's name masks it; the physical door still answers; disposing the deny lifts it", async () => {
  const ctx = freshCtx("mask");
  const itx = openItx(ctx);
  await itx.kv.put("k", "v");
  const deny = await itx.provide("itx.kv", null);
  const refused = await rejection(itx.kv.get("k"));
  expect(codeOf(refused)).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(String((refused as Error).message)).toMatch(/is masked/);
  expect(await itx.builtins.kv.get("k")).toBe("v");
  expect(await itx.rewriteRules.get("itx.kv")).toEqual({
    match: "itx.kv",
    target: null,
    origin: "context",
  });
  // a partial mask under the root refuses only what it claims
  await itx.provide("itx.kv.put", null);
  expect(await itx.builtins.kv.get("k")).toBe("v"); // the physical door still answers
  deny[Symbol.dispose]();
  await until("the deny lifted", async () =>
    (await itx.rewriteRules.get("itx.kv"))?.origin === "platform" ? true : undefined,
  );
  expect(await itx.kv.get("k")).toBe("v");
  expect(codeOf(await rejection(itx.kv.put("k", "w")))).toBe("NO_ITX_EXPRESSION_MATCH"); // the partial mask stands
  // the explicit restore: the platform-equivalent target deletes the row
  await itx.provide("itx.kv.put", "itx.builtins.kv.put");
  expect(await itx.rewriteRules.get("itx.kv.put")).toBeNull();
  expect(await itx.kv.put("k", "w")).toEqual({ ok: true });
});

test("rewriteRules.list() is the EFFECTIVE table: platform rows with their origin, a re-set root shown once as the context's row", async () => {
  const ctx = freshCtx("list");
  const itx = openItx(ctx);
  const before = await itx.rewriteRules.list();
  expect(before).toContainEqual({ match: "itx.kv", target: "itx.builtins.kv", origin: "platform" });
  expect(before).toContainEqual({
    match: "itx.append",
    target: "itx.builtins.append",
    origin: "platform",
  });
  expect(before.every((row: { origin: string }) => row.origin === "platform")).toBe(true);
  await itx.provide("itx.kv", "itx.builtins.whoami");
  const after = await itx.rewriteRules.list();
  expect(after.filter((row: { match: string }) => row.match === "itx.kv")).toEqual([
    { match: "itx.kv", target: "itx.builtins.whoami", origin: "context" },
  ]);
  expect(after.length).toBe(before.length); // the context row REPLACED the platform row in the listing
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
  expect(codeOf(await rejection(itx.rewriteRules.resolve("itx.nope.x()")))).toBe(
    "NO_ITX_EXPRESSION_MATCH",
  );
  // live args: the string is the pure part, the args the live part
  expect(await itx.invoke("itx.kv.get", "k")).toBe("v");
  expect(await itx.invoke("itx.store.get", "k")).toBe("v");
  expect(await itx.invoke("itx.whoami()")).toMatchObject({ projectId: ctx }); // no args: the call as spelled
});

test("THE WHOLE-CONTEXT OVERRIDE: a bare `itx` row at a context sends every short-named call to a live capability; `builtins` still reaches its log", async () => {
  const ctx = freshCtx("override");
  const root = openItx(ctx);
  const live = new Override();
  const override = await root.cd("/x").provide("itx", live);
  expect(await root.cd("/x").append({ type: "t", payload: { n: 1 } })).toBe("captured");
  expect(await root.cd("/x").whoami()).toBe("the override");
  expect(live.seen).toEqual([{ type: "t", payload: { n: 1 } }]);
  // the physical door at /x is the fixed point: its log, not the stub
  const [landed] = await root.cd("/x").builtins.append({ type: "t", payload: { n: 2 } });
  expect(landed).toMatchObject({ type: "t", payload: { n: 2 } });
  expect(await root.cd("/x").builtins.whoami()).toEqual({ projectId: ctx, path: "/x" });
  const log = (await root.cd("/x").builtins.read(0, 500)).events as {
    type: string;
    payload: unknown;
  }[];
  expect(log.filter((e) => e.type === "t").map((e) => e.payload)).toEqual([{ n: 2 }]); // n:1 went to the stub
  // an EXPRESSION-side cd from the root goes through /x's rows too (the fast path is gone)
  expect(await root.invoke("itx.cd('/x').whoami()")).toBe("the override");
  expect(await root.invoke("itx.cd('/x').builtins.whoami()")).toEqual({
    projectId: ctx,
    path: "/x",
  });
  override[Symbol.dispose]();
  await until("the override gone", async () => {
    const row = await root.cd("/x").builtins.rewriteRules.get("itx"); // through the physical door: the override is still in force
    return row === null ? true : undefined;
  });
  expect(await root.cd("/x").whoami()).toEqual({ projectId: ctx, path: "/x" });
});

test("the door: a match rooted at itx.builtins, or at a proxy verb, is refused; the platform never spells a short name", async () => {
  const ctx = freshCtx("door");
  const itx = openItx(ctx);
  expect(String((await rejection(itx.provide("itx.builtins.kv", "itx.whoami"))).message)).toMatch(
    /may not be rooted at "itx\.builtins"/,
  );
  expect(String((await rejection(itx.provide("itx.provide", "itx.whoami"))).message)).toMatch(
    /proxy's own verb "provide"/,
  );
  expect(String((await rejection(itx.provide("itx.cd('/y')", "itx.whoami"))).message)).toMatch(
    /proxy's own verb "cd"/,
  );
  // what the platform writes is builtins-rooted, so a row at `itx.rpcStubs` or `itx.facets`
  // redirects the caller's calls and nothing the platform relies on
  await itx.provide("itx.rpcStubs", null);
  await itx.provide("itx.tool", () => "still served");
  expect(await itx.tool()).toBe("still served");
  expect(codeOf(await rejection(itx.rpcStubs.list()))).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(await itx.builtins.rpcStubs.list()).toContain("itx.tool");
  const events = await readAll(itx);
  const ruleTargets = events
    .filter((e) => e.type === "events.iterate.com/itx/rewrite-rule-configured" && e.payload.target)
    .map((e) => e.payload.target as string);
  expect(ruleTargets).toContain("itx.builtins.rpcStubs.get('itx.tool')");
});
