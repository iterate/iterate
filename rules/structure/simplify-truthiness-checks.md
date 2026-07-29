---
id: structure/simplify-truthiness-checks
severity: error
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,test,tests,spec,specs}/**",
  ]
---

Try as hard as you can to avoid needing to care about the difference between falsy values.

Bad:

```ts
const built =
  memoized === undefined
    ? await resolveArtifact(buildKey)
    : { ok: true as const, source: memoized };
```

Better:

```ts
const built = memoized ? { ok: true, source: memoized } : await resolveArtifact(buildKey);
```

In general, something is badly wrong if there's a meaningful semantic difference in the above case when `memoized` is null vs undefined vs false vs `""` vs 0.

This can't be a deterministic rule, partly because there are of course exceptions (especially with `0` which is obviously a legitimate number value). But often things like `memoized` will be plain old js objects, and should _never_ be empty string or `0`. So in most cases we just need to ensure that we're not trying to encode important information in the distinction between `null` and `undefined`, unless we've got a really great reason for doing that.
