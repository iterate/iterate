---
id: structure/validate-unknown-shapes
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,test,tests,spec,specs}/**",
  ]
---

# Validate unknown shapes at the boundary

When a value is `unknown`, do not manually prove its shape with a long anonymous chain of
`typeof`, null, array, property, and key checks. Parse it once with a schema or use a domain-named
type guard that owns the invariant.

Bad:

```ts
const empty =
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;
```

Better:

```ts
const EmptyBrowserFeedState = z.strictObject({});
const empty = EmptyBrowserFeedState.safeParse(value).success;
```

Do not extract the anonymous check chain into a single-use helper merely to hide it. A named guard
is useful when it represents a real domain concept, centralizes the invariant, and narrows values
for its callers.
