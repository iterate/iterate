---
id: structure/prefer-clear-conditionals
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,test,tests,spec,specs}/**",
  ]
---

# Prefer clear conditional shapes

Use an early return or `if` when one branch is exceptional or when it removes nesting. Use a
ternary when choosing between two values, handlers, argument bundles, or JSX alternatives that
feed the same work.

Don't replace a ternary if doing so duplicates shared work, introduces mutation, increases vertical
space, or turns a clear condition into a negative `&&`. Formatter wrapping alone is not a reason to
rewrite a ternary. If Oxfmt insists on wrapping an otherwise clear ternary, don't over-stress about
the extra lines or add a suppression comment just to force it onto one line. Prefer positive
predicates; if neither branch reads clearly, name the condition.

Bad — the failure branch is exceptional, so the ternary wastes vertical space:

```ts
return built.ok
  ? {
      ok: true,
      output: { assetManifest: {}, assets: {}, ...built.output },
    }
  : built;
```

Better:

```ts
if (!built.ok) return built;
return { ok: true, output: { assetManifest: {}, assets: {}, ...built.output } };
```

Keep the ternary when both branches only select inputs for shared work:

```ts
const { handler, prefix } =
  mode === "rpc"
    ? { handler: rpcHandler, prefix: "/rpc" }
    : { handler: openapiHandler, prefix: "/api/v2" };
return handler.handle(request, { context, prefix });
```

Expanding that into two branches which each call `handler.handle` usually makes it worse. In JSX,
`isGlobal ? null : <Button />` can likewise be clearer than `!isGlobal && <Button />`.
