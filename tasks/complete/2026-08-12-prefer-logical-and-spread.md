---
status: done
size: small
---

# Lint rule: prefer `...(cond && obj)` over `...(cond ? obj : {})`

## Status

Done, pending review. Rule + tests in commit 2; repo-wide `--fix` in commit 3.
PR: https://github.com/iterate/iterate/pull/2487

## Summary

Add a deterministic, auto-fixable custom oxlint rule (`iterate/prefer-logical-and-spread`)
that rewrites

```ts
const x = {
  ...(f ? { abc: f.def } : {}),
};
```

to

```ts
const x = {
  ...(f && { abc: f.def }),
};
```

Object spread of any falsy value is a no-op (same as spreading `{}`), so the
ternary's `: {}` arm is dead weight.

## Decisions (assumptions, made while Misha is AFK)

- Scope: only spreads inside **object literals** (`SpreadElement` whose parent
  is an `ObjectExpression`). Array spread of falsy throws, so it's excluded.
  JSX spread attributes left out to keep the rule tight.
- Only the exact stated direction: alternate must be an empty object literal
  `{}`. The mirrored `cond ? {} : obj` form is NOT rewritten to `!cond && obj`
  (adds a negation, less obviously a pure win).
- The consequent can be any expression (e.g. `f ? f.extras : {}` →
  `f && f.extras`) — same falsy-spread reasoning applies.
- Fix wraps the test/consequent in parens when precedence demands it
  (`a || b ? x : {}` → `(a || b) && x`; `f ? (a ?? b) : {}` → `f && (a ?? b)`),
  so the fix is always parse- and semantics-preserving.
- If comments live inside the ternary but outside the test/consequent nodes,
  report without a fix rather than silently dropping them.

## Checklist

- [x] add `iterate/prefer-logical-and-spread` rule to `lint/oxlint-plugin-iterate.ts` _implemented with a `needsParensInsideLogicalAnd` precedence helper; reports fix-less when the rewrite would drop a comment_
- [x] enable it as `error` in `.oxlintrc.json` _alongside the other `iterate/*` rules_
- [x] test file `lint/oxlint-plugin-logical-and-spread.test.ts` covering report, fix output (incl. precedence parens), and non-matches _5 tests, runs the real oxlint binary with `--fix` and asserts the rewritten files_
- [x] run `pnpm lint:fix` across the repo, commit the mechanical fixes separately _71 files; see notes_

## Implementation notes

- `oxlint --fix` needed two passes: fixes for conditional spreads *nested
  inside* another conditional spread's consequent overlap the outer fix, so
  oxlint defers them to the next run (7 such sites, e.g.
  `apps/os/src/lib/agent-round-meta-yaml.ts`).
- Three sites in `scripts/preview/{e2e-telemetry,preview}.ts` spread on an
  `unknown`-typed test (caught errors), and `...(unknown && {…})` is TS2698.
  Hand-tweaked to `...(!!input.error && {…})` — identical runtime semantics,
  and `!!` makes the spread type `false | {…}`.
