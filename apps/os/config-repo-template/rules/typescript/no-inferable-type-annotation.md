---
id: typescript/no-inferable-type-annotation
severity: error
files:
  [
    "**/*.{ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,test,tests,spec,specs}/**",
  ]
---

# Avoid inferable type annotations

Do not declare a type annotation that TypeScript can infer from the value.
