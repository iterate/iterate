// rewrite-rules-map-and-chains.e2e.test.ts — the rewrite-rule table under stress. The
// table is a MAP by canonical match: 5 concurrent re-sets of ONE match end with exactly one rule (the
// last-committed target), a null DELETES it (default-deny — nothing "beneath" to fall back to), and a
// fresh set works; a NON-CANONICAL match spelling is stored CANONICAL and rewrites; 300 event-sourced
// rules keep both the newest rule and a built-in root under 150ms; a chain of rules naming rules 30
// deep resolves under the depth-32 budget and 33 deep fails loudly; malformed rule events are skipped
// without wedging later rules; a longer match under a target's prefix captures the deeper call.

import { expect, test } from "vitest";
import { append, codeOf, freshCtx, openItx, readAll, rejection } from "./support/client.ts";

const REWRITE_RULE_CONFIGURED = "events.iterate.com/itx/rewrite-rule-configured";

test("the table is a MAP: 5 concurrent re-sets of ONE match leave exactly the last-committed target; null deletes (default-deny); a fresh set works", async () => {
  const itx = openItx(freshCtx("map"));
  // five distinguishable client rpc stubs, each behind its own rule
  for (let i = 0; i < 5; i++) await itx.provide(`itx.probe${i}`, () => i);
  const race = () => itx.invoke(["itx", ["race"]]);

  // five concurrent re-sets of itx.race — one event each, one row survives: the LAST committed
  await Promise.all(Array.from({ length: 5 }, (_, i) => itx.provide("itx.race", `itx.probe${i}`)));
  const configured = (await readAll(itx)).filter(
    (e) => e.type === REWRITE_RULE_CONFIGURED && e.payload?.match === "itx.race",
  );
  expect(configured).toHaveLength(5); // every re-set appended exactly one event
  const lastTarget = configured.at(-1)!.payload.target as string;
  expect(await itx.rewriteRules.get("itx.race")).toEqual({
    match: "itx.race",
    target: lastTarget,
  });
  expect(
    (await itx.rewriteRules.list()).filter((r: { match: string }) => r.match === "itx.race"),
  ).toHaveLength(1); // a map: same-match rules never coexist
  expect(await race()).toBe(Number(lastTarget.slice("itx.probe".length)));

  // a re-set REPLACES (no stack) …
  await itx.provide("itx.race", "itx.probe2");
  expect(await race()).toBe(2);
  // … and null DELETES — default-deny, nothing restored from "beneath"
  await itx.provide("itx.race", null);
  expect(await itx.rewriteRules.get("itx.race")).toBeNull();
  expect(codeOf(await rejection(race()))).toBe("NO_ITX_EXPRESSION_MATCH");

  // and the table is not wedged: a fresh set works and answers
  await itx.provide("itx.race", "itx.probe3");
  expect(await race()).toBe(3);
});

test("a NON-CANONICAL match spelling through the rewrite door is stored CANONICAL and rewrites", async () => {
  // The one-canonicalizer pin: the rewrite door canonicalizes ONCE at the top, so the reduce stores
  // exactly the match every later door (dispatch, un-set by match) compares against — a stray space
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
  expect(codeOf(err)).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(err.message).toContain("no rewrite rule matches");
});

test("300 rules: invoking the NEWEST rule and a built-in root both stay under 150ms", async () => {
  const ctx = freshCtx("rules300");
  const itx = openItx(ctx);
  // Rules are event-sourced — append all 300 rewrite-rule-configured events in ONE commit.
  const rules = Array.from({ length: 300 }, (_, i) => ({
    type: REWRITE_RULE_CONFIGURED,
    payload: { match: `itx.m${i}`, target: "itx.whoami" },
  }));
  const committed = await append(itx, ...rules);
  expect(committed).toHaveLength(300);

  const time = async (fn: () => Promise<unknown>, iters = 12): Promise<number> => {
    const samples: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]; // median
  };

  // Warm both lanes once (table rehydration / DO wake are not what we are measuring).
  const viaNewest = await itx.invoke(["itx", ["m299"]]);
  expect(viaNewest).toMatchObject({ projectId: ctx, path: "/" }); // it really reaches whoami
  await itx.invoke(["itx", ["whoami"]]);

  const newestMs = await time(() => itx.invoke(["itx", ["m299"]]));
  const rootMs = await time(() => itx.invoke(["itx", ["whoami"]]));
  console.log(
    `[300 rules] newest-rule median ${newestMs.toFixed(1)}ms, built-in root median ${rootMs.toFixed(1)}ms`,
  );
  expect(newestMs, `newest rule (m299) median ${newestMs.toFixed(1)}ms`).toBeLessThan(150);
  expect(rootMs, `built-in root (whoami) median ${rootMs.toFixed(1)}ms`).toBeLessThan(150);
}, 90_000);

test("a chain of rules naming rules 30 deep resolves under the depth-32 budget; 33 deep fails loudly", async () => {
  const ctx = freshCtx("chain");
  const itx = openItx(ctx);
  // chain0 → itx.whoami; chainK → itx.chain(K-1). One commit configures all 33 rules.
  const chain = Array.from({ length: 33 }, (_, i) => ({
    type: REWRITE_RULE_CONFIGURED,
    payload: { match: `itx.chain${i}`, target: i === 0 ? "itx.whoami" : `itx.chain${i - 1}` },
  }));
  await append(itx, ...chain);

  // 30 rewrites (chain29 → … → chain0 → whoami) resolve within the budget…
  const resolved = await itx.invoke(["itx", ["chain29"]]);
  expect(resolved).toMatchObject({ projectId: ctx, path: "/" });

  // …33 rewrites trip the guard LOUDLY (never a spin, never a stack overflow).
  await expect(itx.invoke(["itx", ["chain32"]])).rejects.toThrow(/depth 32/);
}, 60_000);

test("malformed rewrite-rule events are skipped without wedging later rules", async () => {
  const ctx = freshCtx("badrule");
  const itx = openItx(ctx);
  // an unparseable target — the reduce throws, the host contains it
  await append(itx, {
    type: REWRITE_RULE_CONFIGURED,
    payload: { match: "itx.broken", target: "((((" },
  });
  // NO payload at all
  await append(itx, { type: REWRITE_RULE_CONFIGURED });
  // wrong shapes inside the payload
  await append(itx, {
    type: REWRITE_RULE_CONFIGURED,
    payload: { match: 42, target: ["not", "a", "string"] },
  });
  // the table still takes rules and resolves them — the checkpoint didn't wedge
  await itx.provide("itx.hello", "itx.whoami");
  expect(await itx.invoke(["itx", ["hello"]])).toMatchObject({ projectId: ctx });
  // and the malformed rule is dead weight, not a row (default-deny still answers there)
  const missErr = await rejection(itx.invoke(["itx", ["broken"]]));
  expect(codeOf(missErr)).toBe("NO_ITX_EXPRESSION_MATCH");
  expect(await itx.rewriteRules.get("itx.broken")).toBeNull();
});

test("a rule is a REWRITE: a longer match under the target's prefix captures the deeper call", async () => {
  const ctx = freshCtx("rewrite");
  const itx = openItx(ctx);
  await itx.provide("itx.store", "itx.kv");
  await itx.provide("itx.store.deep", "itx.whoami"); // longer than `itx.store`: claims `.deep`
  await itx.provide("itx.db", "itx.store");
  // `itx.db.deep()` rewrites to `itx.store.deep()`, which the longer match claims — the kv value's
  // (non-existent) `deep` is never walked.
  expect(await itx.invoke("itx.db.deep()")).toMatchObject({ projectId: ctx, path: "/" });
  // the shorter match still reaches kv through two rewrites
  await itx.invoke("itx.db.put('k', 'v')");
  expect(await itx.invoke("itx.store.get('k')")).toBe("v");
});
