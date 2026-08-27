---
status: in-progress
size: small
---

# Delete the warm-up turn from the script-reuse spec (first test)

## Status summary

In progress. Change is small: remove the throwaway warm-up agent from the
first test in `specs/agent-script-reuse.spec.ts` and give turn 1 the cold
ceiling instead. Verification against a cold local environment pending.

## Problem

The first test in `specs/agent-script-reuse.spec.ts` ("a repeat request
reuses...") fires a throwaway itx-level
`ask({message: "warm up", timeoutMs: 90_000}).catch(() => {})` before the
intercepted turns. It exists because on a cold preview deployment the
project's first agent turn pays all one-time costs at once — DO spin-up +
journal hydration, the tswasm typecheck sidecar's first compile, dynamic
isolate creation — measured at 35–65s, vs a few seconds for every later
turn. The warm-up absorbs that off the clock so the measured turns fit the
`spinnerWaiter.settings.run({spinnerTimeout: 60_000}, ...)` wrappers.

But it's a smell: it hides the real cold first-turn latency from the spec,
costs a whole extra agent + turn per run, and the spinner-waiter exists
precisely to tolerate long-but-healthy waits — it only kills waits where the
UI shows nothing. History: `tasks/complete/2026-08-27-codemode-script-reuse.md`
and PR #2525.

## Fix

Delete the warm-up and let turn 1 absorb the cold cost on the clock, with a
bumped budget scoped to that one turn only:

- [ ] delete the warm-up agent block and the now-dead `"warm up"` entry in
  the first test's `scripts` record
- [ ] bump the FIRST intercepted turn's wrapper to
  `spinnerWaiter.settings.run({spinnerTimeout: 120_000}, ...)`; turn 2 keeps
  60s
- [ ] raise the test-level budget with `test.setTimeout(240_000)` (the heavy
  tier, precedent `specs/agent-chat.spec.ts`) — the default 90s
  `SPEC_TEST_TIMEOUT_MS` cannot hold a 65s cold turn plus the rest of the
  flow; stays at the `E2E_HEAVY_TEST_TIMEOUT_MS` ceiling the e2e-policy
  guard greps for
- [ ] verify against a COLD environment (dev server restart + fresh
  project): the spec passes with the spinner genuinely visible for the whole
  cold stretch — the spinner-waiter is the instrument (it fails fast when no
  spinner is up, and bails when the spinner disappears mid-wait), so a green
  cold run IS the continuity proof
- [ ] no `expect.poll`/retry reintroduced
- [ ] spec passes on the preview lane in CI (runs there cold — the real
  test)

## Scope notes / assumptions

- Scoped to the FIRST test only, per the ask. The second test ("run() return
  values are typed...") keeps its warm-up; on a cold deployment the two
  tests run in parallel in CI, so test 2's warm-up still protects itself.
  Removing it too is a candidate follow-up once this pattern proves out.
- If the spinner is NOT continuously visible during the cold stretch (a dead
  gap before the turn registers), that is a product gap — the finding gets
  reported and this task stops rather than papering over it with a blind
  timeout. Bounding/indicating cold first-turn latency would then be its own
  platform task.

## Implementation log

(appended as work happens)
