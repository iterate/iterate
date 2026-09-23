# Simple truthiness for new code

`iterate/simple-truthiness-check` uses `grandfatherRule` with an inclusive
**2026-09-11 00:00 UTC** author-date cutoff. September 8 caught 405 violations;
this later cutoff keeps the initial fixes small. Changed and uncommitted lines
are always checked. See [grandfatherRule](../grandfather-rule.md).

```ts
// Prefer direct properties.
const before = { ...(input.foo !== undefined && { foo: input.foo }) };
const after = { foo: input.foo };

// Trust declared types; an empty label should get the default too.
declare const input: { foo?: string; items?: string[] };
if (input.items) consume(input.items);
const label = input.foo || "Default";
```

This enforces part of the existing [truthiness review policy](../../rules/structure/simplify-truthiness-checks.md).

The rule reports conditional spreads that merely repeat the guarded value,
null/undefined comparisons, redundant `typeof`/`Array.isArray` checks on typed
values, and `??`/`??=` for strings and objects. Type-based checks currently inspect
identifiers and property references. They preserve number/boolean/bigint unions,
unknown/any input validation, and real string-versus-object discrimination.
Existing `use-isnan` handles invalid direct comparisons with NaN.

There is no automatic fix: changing empty-string handling or property presence
requires inspecting the consumer. Fix our APIs when they needlessly distinguish
omission, undefined, null, and empty strings. A protocol with a real distinction
can use a narrow `oxlint-disable-next-line iterate/simple-truthiness-check`
with a concrete explanation. Do not turn numeric presence tests into
`Number.isFinite` just to satisfy this rule; the rule leaves numbers alone.

Reference: the closed [#2491](https://github.com/iterate/iterate/pull/2491).
This version omits its broad sweep, numeric guard declarations, and unrelated
length/ternary/optional-chain rewrites.
