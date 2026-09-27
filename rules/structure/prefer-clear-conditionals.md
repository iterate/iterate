---
id: structure/prefer-clear-conditionals
severity: error
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,__workers-tests__,test,tests,spec,specs}/**",
    "!packages/ui/src/components/{alert-dialog,avatar,badge,breadcrumb,button,card,checkbox,command,dialog,dropdown-menu,empty,field,input,input-group,label,native-select,select,separator,sheet,sidebar,skeleton,sonner,spinner,table,tabs,textarea,tooltip}.tsx",
    "!packages/ui/src/hooks/use-mobile.ts",
    "!**/*.gen.ts",
  ]
engine: jev
select: conditional
window: [4, 4] # lines before, after the unit
question:
  instructions: |
    TypeScript review rule for conditional shapes. Use an early return or an `if` when one branch is exceptional (a failure or error result, or a no-op that hands back its input unchanged) or when returning early removes nesting. Use a ternary when choosing between two values, handlers, argument bundles or JSX alternatives that feed the same work; a JSX ternary that renders null in one branch is fine when its predicate is positive. An early return is only possible where the conditional is what the function returns or wraps the rest of the function: a ternary inside an argument, a property, an array element or JSX cannot become one. Do not rewrite a ternary when that would duplicate shared work, introduce mutation, add vertical space, or turn a clear condition into a negative `&&`; line wrapping by the formatter alone is not a reason. Prefer positive predicates: a negated predicate that puts the empty branch first reads worse than the positive one.
    Judge only the conditional on the lines marked ">".

    Answer true when the rule asks for a change: a returned conditional where one branch is a failure or hands back its input unchanged, so an early return would read better; a main path nested under an else that an early return would flatten; or a negated predicate that puts the empty branch first. Answer false when both branches are ordinary alternatives for the same work, the conditional sits inside an expression where no early return is possible, or a rewrite would duplicate work, add mutation or add lines.
  "true": "Rewrite it: an exceptional or pass-through branch, a main path nested under else, or a needlessly negated predicate."
  "false": "Keep it: the branches are ordinary alternatives for the same work, or a rewrite would not be clearer."
flag: 0.7 # p >= flag: a diagnostic with `message`
pass: 0.6 # p < pass: nothing; between: the LLM judges the unit with this file's prose
message: "One branch is exceptional or passes its input through: an early return (or a positive predicate) reads more clearly here."
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
