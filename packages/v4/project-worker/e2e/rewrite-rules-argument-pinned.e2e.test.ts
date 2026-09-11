// rewrite-rules-argument-pinned.e2e.test.ts — a rewrite rule's MATCH may PIN literal args on a
// call step (context/itx-expression-rewriting.ts rules 1–3; `llm` is no built-in root, so nothing lies
// beneath these rows — `itx.ai` would fall to its platform row, see rewrite-rules-builtins-root): `itx.llm.run('special')` is a more specific
// rule than `itx.llm.run`, matched by structural equality of the leading args and CONSUMED by the match
// (partial application) — the target sees only the unpinned args. Through the real DO: configure a
// rule, rewrite through it, lend a client's rpc stub behind a pinned match, un-set by the pinned spelling.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

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
  expect(snap.state.itxExpressionRewriteRules["itx.llm.run('special')"].match).toEqual([
    "itx",
    "llm",
    ["run", "special"],
  ]);
  // un-setting by the canonical pinned spelling deletes exactly that rule; the plain rule (rule 3:
  // less specific) matches the call from now on
  await itx.provide("itx.llm.run('special')", null);
  expect(await itx.invoke("itx.llm.run('special')")).toBeNull(); // the plain rule → kv.get('special') → null
});
