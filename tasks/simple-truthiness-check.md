---
status: in-progress
size: medium
---

# Lint rule: simple-truthiness-check

Follow-up to `iterate/prefer-logical-and-spread` (#2487).

**Status summary:** rule + tests done (suggestion-only, `--fix-suggestions`
applies the truthiness form). Repo-wide it flags ~3.9k sites in 589 files, so
the fix experiment is type-aware (numbers get `Number.isFinite`, not
truthiness) rather than a blind sweep. Fix commits in progress.

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

- [x] Rule `iterate/simple-truthiness-check` in `lint/oxlint-plugin-iterate.ts`,
      flagging `==`/`!=`/`===`/`!==` against `null`, `undefined`, or `NaN`.
      _Also collapses the dual `x !== null && x !== undefined` check into one
      report/fix so applying it yields `x`, not `x && x`._
- [x] **Suggestion-only, not autofix** (per the ask: autofix is risky because
      the rewrite is only equivalent under the principles above, which need a
      human to confirm per site — especially numbers). Two suggestions per
      report, truthiness first, `Number.isFinite` second so IDE users pick.
- [x] Truthiness suggestion is context-aware: bare `x` in boolean contexts
      (`if`/`while`/ternary test, `!`, logical operands feeding those),
      `!!x` where the boolean value itself is used. Parens added when the
      operand binds looser than `!`. _`isBooleanContext` + `BANG_SAFE_EXPRESSION_TYPES`._
- [x] `NaN` comparisons suggest `Number.isNaN(x)` (truthiness doesn't apply;
      direct comparison is always-false). _Zero occurrences in repo today,
      handled for completeness._
- [x] Enable as `"error"` in `.oxlintrc.json` (lint runs `--deny-warnings`, so
      warn vs error is the same in CI).
- [x] Tests in `lint/oxlint-plugin-simple-truthiness.test.ts` mirroring the
      logical-and-spread test style (real oxlint binary in a temp fixture,
      `--fix-suggestions` output asserted). _8 tests._
- [ ] Separate commit(s): experiment applying the suggestions to real code.
      _Assumption: repo has ~3.7k raw comparison sites; if the post-ignore
      count is unmanageable for a reviewable sweep, scope the fix commit to a
      representative slice and document the full count + recommendation in the
      PR body rather than bulk-rewriting semantics-sensitive code._

## Implementation log

- Rule + 8 tests landed. `--fix-suggestions` applies the first suggestion, so
  ordering truthiness first makes bulk application possible while keeping the
  rule suggestion-only for IDE/`--fix` users.
- Armed repo-wide: **3,884 violations in 589 files** (biggest:
  stream-state-panel.tsx 134, rpc-targets.ts 127, stream-event-sender.ts 95).
  A blind `--fix-suggestions` sweep would silently convert number-typed sites
  to truthiness (dropping 0); plan is a type-aware codemod: oxlint JSON spans
  → TypeScript checker classifies each operand (number-ish → `Number.isFinite`
  form, boolean-ish → flag for hand review as tri-state risk, else truthiness).
- Found 2 pre-existing `prefer-logical-and-spread` errors in
  `apps/mobile/src/components/note-composer.tsx` — merge race between #2483
  and the #2487 sweep. Auto-fixed in the fixes commit.
