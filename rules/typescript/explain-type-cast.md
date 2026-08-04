---
id: typescript/explain-type-cast
severity: error
files:
  [
    "**/*.{ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,test,tests,spec,specs}/**",
    "!**/e2e/**",
    "!**/*test-{helpers,harness,utils}.{ts,tsx,mts,cts}",
  ]
---

# Explain type casts

Every type cast must have a nearby explanation of why it is safe and cannot reasonably be avoided.
