# Simple truthiness

`iterate/simple-truthiness-check` checks every line. Where `""` and `undefined`
(or missing and `undefined`) really mean different things, keep the precise
check and say why in a comment next to it.

```ts
// Prefer direct properties.
const before = { ...(input.foo !== undefined && { foo: input.foo }) };
const after = { foo: input.foo };

// Trust declared types; an empty label should get the default too.
declare const input: { foo?: string; items?: string[] };
if (input.items) consume(input.items);
const label = input.foo || "Default";
```

Try hard not to care about the difference between falsy values: something is
badly wrong when a plain object means one thing as `null` and another as
`undefined`, `false`, `""` or `0`.

The rule reports conditional spreads that merely repeat the guarded value,
null/undefined comparisons, redundant `typeof`/`Array.isArray` checks on typed
values, and `??`/`??=` for strings and objects. Type-based checks inspect
identifiers, property references and optional chains of them (`input?.label`).
They preserve number/boolean/bigint unions, unknown/any input validation, and
real string-versus-object discrimination.
Existing `use-isnan` handles invalid direct comparisons with NaN.

There is no automatic fix: changing empty-string handling or property presence
requires inspecting the consumer. Fix our APIs when they needlessly distinguish
omission, undefined, null, and empty strings. A protocol with a real distinction
can use a narrow `oxlint-disable-next-line iterate/simple-truthiness-check`
with a concrete explanation. Do not turn numeric presence tests into
`Number.isFinite` just to satisfy this rule; the rule leaves numbers alone.

Reference: the closed [iterate/iterate#2491](https://github.com/iterate/iterate/pull/2491).
This version omits its broad sweep, numeric guard declarations, and unrelated
length/ternary/optional-chain rewrites.
