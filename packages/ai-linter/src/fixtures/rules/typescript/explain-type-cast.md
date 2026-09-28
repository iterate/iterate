---
id: typescript/explain-type-cast
severity: error
files:
  [
    "**/*.{ts,tsx,mts,cts}",
    "!**/*.{test,spec,test-worker,fixtures}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,__workers-tests__,test,tests,spec,specs,e2e,test-support,fixtures}/**",
    "!**/*{test-helper,test-support,test-harness,fixture}*.{ts,tsx,mts,cts}",
    "!**/vitest*.config.*",
    "!packages/ui/src/components/{alert-dialog,avatar,badge,breadcrumb,button,card,checkbox,command,dialog,dropdown-menu,empty,field,input,input-group,label,native-select,select,separator,sheet,sidebar,skeleton,sonner,spinner,table,tabs,textarea,tooltip}.tsx",
    "!packages/ui/src/hooks/use-mobile.ts",
    "!**/*.gen.ts",
  ]
engine: jev
select: cast
window: [15, 3] # lines before, after the unit
question:
  instructions: |
    TypeScript review rule: every type assertion (`value as T`, or `<T>value`) must have a nearby comment that explains why it is safe and why it cannot reasonably be avoided. Test-only code is exempt.
    Judge only the assertion on the line(s) marked ">".
    A nearby explanation is a comment on the same line, directly above the statement, or in the doc comment of the enclosing function or declaration, that says specifically why this assertion holds: what guarantees the value's type, or which library or platform signature forces the assertion.

    Answer true when there is no such explanation for the assertion under review: no comment at all, only comments about other things, or a comment that says a cast happens without saying why it is safe.
  "true": "No nearby comment explains why this assertion is safe or unavoidable."
  "false": "A nearby comment explains why this assertion is safe or unavoidable, or the file is test-only code."
flag: 0.95 # p >= flag: a diagnostic with `message`
pass: 0.7 # p < pass: nothing; between: the LLM judges the unit with this file's prose
message: "This type assertion has no nearby explanation of why it is safe and cannot reasonably be avoided."
---

# Explain type casts

Every type cast must have a nearby explanation of why it is safe and cannot reasonably be avoided.

`as const` is not a cast: it asserts nothing about a value's type, only that a literal stays
narrow and read-only, so it needs no explanation.

Test code is exempt. The negated globs cover the common layouts, but any file that exists only to support tests (helpers, fixtures, harnesses, fake services) is also out of scope even if its name doesn't match one of them.
