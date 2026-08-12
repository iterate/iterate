---
status: in-progress
size: small
---

# Lint rule: prefer `...(cond && obj)` over `...(cond ? obj : {})`

## Status

Spec committed first; implementation follows in this branch. PR contains the
rule + test, then a separate `--fix` commit applying it across the repo.

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

- [ ] add `iterate/prefer-logical-and-spread` rule to `lint/oxlint-plugin-iterate.ts`
- [ ] enable it as `error` in `.oxlintrc.json`
- [ ] test file `lint/oxlint-plugin-logical-and-spread.test.ts` covering report, fix output (incl. precedence parens), and non-matches
- [ ] run `pnpm lint:fix` across the repo, commit the mechanical fixes separately
