---
id: structure/no-small-single-use-helper
severity: error
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,test,tests,spec,specs}/**",
  ]
---

# Avoid small single-use helpers

Do not introduce a small helper used only once when keeping the logic at its call site would be clearer.
