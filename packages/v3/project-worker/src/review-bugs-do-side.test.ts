// src/review-bugs-do-side.test.ts — the PURE-LOGIC half of the 2026-09-02 DO-side bug hunt
// (docs/reviews/2026-09-02-bugs-do-side.md); the ones that need real storage, a real facet or the
// real loader live in __workers-tests__/review-bugs-do-side.test.ts. `test.fails` is the house
// convention for a known-red proof: flipping it back to `test` is how a fix is proved.

import { expect, test } from "vitest";
import { parse, parseItxExpressionPrefix, print } from "./context/expression.ts";
import {
  matchItxExpressionPrefix,
  pickItxExpressionRewriteRule,
} from "./context/itx-expression-rewriting.ts";

// BUG: two rewrite rules whose matches pin the SAME object by a different key order are two distinct
// rows of the map (their canonical spellings differ) yet both claim the same call, with equal match
// length and equal pin count — so which one wins is decided by nothing but the order
// `Object.values(itxExpressionRewriteRules)` hands them over, i.e. by which was configured first.
// The later rule is silently dead while `itx.rewriteRules.list()` shows it present.
// WHY: `parseItxExpressionPrefix` → `print` canonicalizes each arg with JSON5, which PRESERVES key
// order, so `itx.ai.run({model:'x',fast:true})` and `itx.ai.run({fast:true,model:'x'})` are
// different map keys; but `matchItxExpressionPrefix` compares pinned args with `jsonEqual`, which is
// order-INSENSITIVE, so both match. `pickItxExpressionRewriteRule`'s `moreSpecific` is a strict `>`
// on (length, pins), so a tie keeps whichever rule it saw first. The module header's rule 3 asserts
// this cannot happen — "One rule per match, so two rules with DIFFERENT matches of equal length and
// pins cannot both match one call" — and it does.
// EXPECTED: either the canonical spelling is key-order-normalized (one map row, a re-provide
// REPLACES, as the MAP contract says), or the tie is broken deterministically rather than by
// configuration order.
// FIXED 2026-09-03 the first way: `print` sorts object keys, so both spellings are ONE canonical
// match — one map row, the later provide replaces — and the picker never sees two equal-specificity
// rows for one call. The proof below pins that.
test("a pinned object arg picks the same rule whatever order the rules are scanned in", () => {
  const first = {
    match: parseItxExpressionPrefix("itx.ai.run({model:'x',fast:true})"),
    target: parse("itx.openai.chat"),
  };
  const second = {
    match: parseItxExpressionPrefix("itx.ai.run({fast:true,model:'x'})"),
    target: parse("itx.anthropic.chat"),
  };
  const call = parse("itx.ai.run({model:'x',fast:true}, 'hello')");

  // The two spellings are ONE canonical match — the same row of the rewrite-rule map…
  expect(print(first.match)).toBe(print(second.match));
  // …and either claims this call (the pinned object matches structurally, as before).
  expect(matchItxExpressionPrefix(first.match, call)).not.toBeNull();
  expect(matchItxExpressionPrefix(second.match, call)).not.toBeNull();

  // So the table (a record keyed by the canonical match) holds one rule, the later one — and the
  // picker, handed the table's rows, finds exactly it whatever order they arrive in.
  const table = Object.fromEntries([first, second].map((rule) => [print(rule.match), rule]));
  expect(Object.keys(table)).toHaveLength(1);
  expect(print(pickItxExpressionRewriteRule(Object.values(table), call)!.rule.target)).toBe(
    "itx.anthropic.chat",
  );
});
