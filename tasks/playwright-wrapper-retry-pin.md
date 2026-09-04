---
status: in-progress
size: small
branch: playwright-wrapper-retry-pin
---

# Pin retries: 0 for playwright-wrapped flake/failing tests

Agreed in discussion 2026-09-04. Playwright has no per-test `retry` option
(vitest does — the wrappers already pass `{ retry: 0 }` there), so the
playwright branch of `createFlake`/`createFailing` registers inside an
anonymous `test.describe` scope carrying
`test.describe.configure({ retries: 0 })`.

## Why

The green paths were already structurally unretryable (both end in a throw
that satisfies `test.fail`, and playwright only retries unexpected
outcomes). The leak is the RED path: "passed unexpectedly" IS unexpected, so
playwright retried it — double-recording ❌ and occasionally rescuing the run
into a green that distorts the record stream. With the pin, both runners have
identical semantics: a wrapped test never retries, period.

An anonymous describe keeps identity intact: it contributes an empty title
segment that `titlePath().filter(Boolean)` drops, so the leaf title — the
dashboard row key — and reported fullName are unchanged.

## Checklist

- [x] createFlake: playwright branch registers via anonymous describe +
      `configure({ retries: 0 })`.
- [x] createFailing: same.
- [x] Faithful fakes, not production fallbacks (Misha's call): the unit-test
      fake playwright objects grow `describe`/`describe.configure` (invoking
      the callback synchronously), and the tests assert the configure call —
      no `"describe" in test` hedging in the wrappers.

## Notes

- #2575 (open) restructures failing-test.ts's registration branch around
  `"setTimeout" in test`; this PR keeps the existing `"fails" in test` split
  and only wraps the else branch, so whichever lands second does a small
  fix-up.
