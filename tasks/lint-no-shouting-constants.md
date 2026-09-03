---
state: in-progress
priority: medium
size: small
tags: [lint, coding-style]
---

# Lint rule: `iterate/no-shouting-constants`

**Status:** rule + tests written; repo sweep pending. See the log at the bottom
for the violation count and the enable/off decision.

## Why

Misha does not like module-level named literals:

```ts
const MAX_SETTLEMENT_BYTES = 1_000_000;
const OVERSIZED_SCRIPT = "...";
// ...
expect(returnedBytes).toBeLessThan(MAX_SETTLEMENT_BYTES);
```

He prefers the literal written where it is used:

```ts
expect(returnedBytes).toBeLessThan(1_000_000);
```

The name adds an indirection the reader has to chase, and the SCREAMING case
implies a shared config knob when it is really a one-off value. Same spirit as
`iterate/no-single-use-helpers` (inline the single-use thing so the reader can
see what is actually happening).

## Policy

Flag a `const` declaration when ALL of these hold:

- it sits at module scope (direct child of `Program`);
- the name is SCREAMING_SNAKE_CASE: `/^[A-Z][A-Z0-9_]*$/` with at least one
  letter after the first (so `A` alone or `_` prefixes are not matched);
- the initializer is a plain literal: number, string, template literal with no
  `${}` parts, or a unary minus in front of a number;
- it is read exactly once. `typeof X` in a type position counts as a read, so a
  const used both as a value and a type is left alone.

Never flag:

- exported consts (`export const`, or `export { X }` later) — public surface;
- objects, arrays, functions, regexes, calls, `as const`, typed annotations —
  not a plain literal (the rule only looks at the four literal shapes above);
- consts read two or more times. Threshold reasoning: with `--deny-warnings`
  every hit blocks CI, and inlining a value twice is a judgment call the rule
  should not make. Single-use is the unambiguous case and matches the sibling
  `no-single-use-helpers` rule. Lowering the threshold later is a one-line
  change once the single-use sweep has landed;
- consts with a JSDoc block comment (`/** ... */`) directly above. That is the
  same escape hatch `no-single-use-helpers` uses: a written rationale means
  the author thought about the name. Line comments do not count.

Message tells the reader to write the literal inline at its use site.

## Severity

Root `pnpm lint` runs `oxlint --deny-warnings`, so `"warn"` fails CI exactly
like `"error"`. Options: enable (and fix every hit in this PR) or register
`"off"` like the other incubating rules (`typed-no-floating-promises`,
`mechanical-class-impl`) and list the hotspots here. Decision recorded in the
log below once the sweep has run.

## Checklist

- [ ] Rule `no-shouting-constants` in `lint/oxlint-plugin-iterate.ts`.
- [ ] Register in root `.oxlintrc.json`.
- [ ] Tests in `lint/oxlint-plugin-no-shouting-constants.test.ts`: flagged
      single-use number/string/template/negative consts; allowed exported,
      non-literal, multi-reference, JSDoc'd, non-module-scope consts.
- [ ] Sweep the repo, record the count and hotspots, fix trivial inlines.
- [ ] `pnpm install && pnpm typecheck && pnpm format && pnpm lint && pnpm knip`
      green; lint workspace tests green (`pnpm --dir lint test`).
- [ ] Draft PR with risk map.

## Implementation log

