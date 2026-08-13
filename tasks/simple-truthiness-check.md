---
status: in-progress
size: medium
---

# Lint rule: simple-truthiness-check

Follow-up to `iterate/prefer-logical-and-spread` (#2487).

**Status summary:** spec fleshed out; rule + tests next, then a separate
commit experimenting with fixes on real code.

## Ask (verbatim-ish)

Don't compare directly to `null`, `undefined`, or `NaN`.

```ts
// before
...(llm.durationMs == null ? {} : { duration: seconds(llm.durationMs) }),
...(llm.inputTokens == null ? {} : { inputTokens: llm.inputTokens }),

// after (durationMs: number | undefined)
...(Number.isFinite(llm.durationMs) && { duration: seconds(llm.durationMs) }),
...(llm.inputTokens && { inputTokens: llm.inputTokens }),
```

## Principles the rule pushes toward

- `null` and `undefined` almost always mean the same thing. Where they don't,
  fix that place rather than writing careful dual checks.
- `''` usually means the same as null/undefined too (`searchInput === ''` is
  not meaningfully different from "not searching").
- `0` often IS different — escape hatch is a positive number guard:
  `Number.isFinite(x)` / `Number.isInteger(x)`. Prefer positive forms over
  `!Number.isNaN(x)`.
- `x == null` (loose) to paper over null-vs-undefined is a hack.
- Trust the type system: for `{ foo: string } | null`, `if (thing)` suffices;
  no `typeof thing === "object" && thing !== null` dance.

## Decisions (made while fleshing out — assumptions marked)

- [ ] Rule `iterate/simple-truthiness-check` in `lint/oxlint-plugin-iterate.ts`,
      flagging `==`/`!=`/`===`/`!==` against `null`, `undefined`, or `NaN`.
- [ ] **Suggestion-only, not autofix** (per the ask: autofix is risky because
      the rewrite is only equivalent under the principles above, which need a
      human to confirm per site — especially numbers). Two suggestions per
      report, truthiness first, `Number.isFinite` second so IDE users pick.
- [ ] Truthiness suggestion is context-aware: bare `x` in boolean contexts
      (`if`/`while`/ternary test, `!`, logical operands feeding those),
      `!!x` where the boolean value itself is used. Parens added when the
      operand binds looser than `!`.
- [ ] `NaN` comparisons suggest `Number.isNaN(x)` (truthiness doesn't apply;
      direct comparison is always-false). _Assumption: zero occurrences in
      repo today, handled for completeness._
- [ ] Enable as `"error"` in `.oxlintrc.json` (lint runs `--deny-warnings`, so
      warn vs error is the same in CI).
- [ ] Tests in `lint/oxlint-plugin-simple-truthiness.test.ts` mirroring the
      logical-and-spread test style (real oxlint binary in a temp fixture,
      `--fix-suggestions` output asserted).
- [ ] Separate commit(s): experiment applying the suggestions to real code.
      _Assumption: repo has ~3.7k raw comparison sites; if the post-ignore
      count is unmanageable for a reviewable sweep, scope the fix commit to a
      representative slice and document the full count + recommendation in the
      PR body rather than bulk-rewriting semantics-sensitive code._

## Implementation log

(appended as work happens)
