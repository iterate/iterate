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
  ]
---

# Explain type casts

Every type cast must have a nearby explanation of why it is safe and cannot reasonably be avoided.

Test code is exempt. The negated globs cover the common layouts, but any file that exists only to support tests (helpers, fixtures, harnesses, fake services) is also out of scope even if its name doesn't match one of them.
