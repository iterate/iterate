---
state: draft
priority: medium
size: medium
dependsOn: []
---

# Codemode Capability Policy

Design the access policy for codemode session capabilities.

Questions to resolve:

- Which built-in session functions should be available to scripts by default?
- Which built-in session functions should be available to provider execution by default?
- How should provider-to-provider calls be limited?
- How should recursion depth, total call count, payload size, and deadline limits be represented?
- Should policy attach to the session, the script execution, the function call, or the returned capability?

For now the PoC intentionally has no policy layer. The scoped capability exposes
the current `CodemodeSessionCapability` surface directly; policy should later
decide which tool functions and codemode control functions each caller receives.
