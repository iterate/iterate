---
status: done
size: small
---

# The agents upgrade test flakes on the first wait's `timeoutMs`

**Status:** done. The row asserts the first wait is within 100 ms of two minutes.

## Why

Main's Test job went red on `2c6161676` (#3479):

```
packages/agents  src/install.test.ts > an upgrade commits the pin … 'refused, …'
-     "timeoutMs": 120000,
+     "timeoutMs": 119999,
```

`upgradeAgents` (`packages/agents/src/install.ts`) sets `deadline = Date.now() + 120_000`, then
passes `deadline - Date.now()` to the first `waitForEvent`. When the clock ticks a millisecond
between those two reads, the first wait gets 119 999 ms. That is correct behaviour; the test's
exact `120_000` is what's wrong. Added in #3446.

The same failure also made the job's telemetry step report `Missing expected test telemetry
workspaces: os`: pnpm stopped the recursive run on the agents failure while apps/os was still
building, so os wrote no telemetry. Nothing to fix there.

## Decisions

- Fix the test, not the product: a first wait a millisecond short of two minutes is fine.
- A forgiving assertion rather than fake timers (Misha's call): the first wait's `timeoutMs` is
  within 100 ms of two minutes.

## Checklist

- [x] loosen the `timeoutMs` assertion in `packages/agents/src/install.test.ts` _`expect.any(Number)` in the called-with, then `toBeGreaterThan(119_900)`; a subtraction trips TS because `timeoutMs` is optional_
- [x] `pnpm --dir packages/agents test`, typecheck, lint _green; a 119 800 ms deadline in `install.ts` fails both rows_
