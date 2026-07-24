---
id: structure/avoid-multline-ternaries
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,test,tests,spec,specs}/**",
  ]
---

bad:

```ts
  return built.ok
    ? {
        ok: true,
        output: { assetManifest: {}, assets: {}, ...built.output },
      }
    : built;
```

good:

```ts
if (!built.ok) return built;
return { ok: true, output: { assetManifest: {}, assets: {}, ...built.output } }
```

In general, wasting vertical space like this makes things harder to review because smallish screens get clogged up with low-information lines of code.
