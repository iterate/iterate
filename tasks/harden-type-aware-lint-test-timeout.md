---
state: todo
priority: medium
size: small
tags: [ci, tests, flake, lint]
---

# Bump testTimeout for the type-aware lint tests (5s is too tight)

`lint/oxlint-type-aware-plugin.test.ts` flakes on the `Test` CI workflow. The
first test — "mechanical-class-impl fixes implementation signatures from the
TypeScript checker" — times out at the vitest **5000ms** default under runner
load. Each test in the file does a real `spawnSync(oxlint)` + TypeScript native
type-check; the first one eats the cold oxlint/TS warmup, and the whole file
legitimately takes ~24s. So 5s per test is fragile, not a real failure.

Surfaced when `test` moved to Depot CI (PR #1613): passed on the PR, timed out
on the main push (attempt #1), passed on `depot ci rerun`. It will recur.

## Fix

Give this file (or these tests) a realistic timeout — e.g. a file-level
`testTimeout` of 30_000ms, or pass the per-test timeout arg. Options:

- Add `import { test } from "vitest"` already present — pass timeout as the
  3rd arg to each `test(...)`, or
- Set `test: { testTimeout: 30_000 }` in the lint package's vitest config so
  the whole heavy type-aware suite gets headroom.

The type-aware tests are inherently >5s cold; the timeout should reflect that.

Owner context: these tests came in with #1577 (type-aware Iterate lint rules).
