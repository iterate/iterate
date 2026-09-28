---
id: structure/validate-unknown-shapes
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
select: shape
window: [3, 2] # lines before, after the unit
question:
  instructions: |
    TypeScript review rule: validate unknown shapes at the boundary. When a value's type is unknown or untrusted (parsed JSON, stored data, a network, RPC or message payload, URL search params, or anything typed `unknown` or `any`), do not prove its shape by hand with an anonymous chain of typeof, null, Array.isArray, property and `in` checks, and do not assert parsed data straight to a type with `as`. Parse it once with a schema, or use a type guard whose name states a real domain concept and owns the invariant for its callers.
    Judge only the expression on the lines marked ">".

    Answer true when it checks or asserts the shape of an unknown or untrusted value by hand in that way. Answer false when it narrows a value whose type is already known (a typed union, an optional field, a string that may be empty), checks an error's class, is the body of a named domain guard that owns the invariant, or is not about a value's shape at all.
  "true": "It proves or asserts the shape of an unknown or untrusted value by hand."
  "false": "It narrows an already-typed value, checks an error's class, is the body of a named domain guard, or is not about a value's shape."
flag: 0.75 # p >= flag: a diagnostic with `message`
pass: 0.75 # p < pass: nothing; between: the LLM judges the unit with this file's prose
message: "This proves or asserts the shape of an unknown value by hand. Parse it once with a schema, or use a domain-named guard."
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
