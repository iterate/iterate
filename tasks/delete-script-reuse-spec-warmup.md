---
status: in-review
size: small
---

# Delete the warm-up turn from the script-reuse spec (first test)

## Status summary

Implemented and verified against a cold local environment (spec green with
the spinner-visible path exercised); awaiting the preview CI lane, which
runs the spec against a genuinely cold deployment — that's the decisive
check. PR: #2529.

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

- [x] delete the warm-up agent block and the now-dead `"warm up"` entry in
  the first test's `scripts` record _both removed; test 2 untouched_
- [x] bump the FIRST intercepted turn's wrapper to
  `spinnerWaiter.settings.run({spinnerTimeout: 120_000}, ...)`; turn 2 keeps
  60s _done, with a comment explaining the spinner-waiter keeps the wide
  budget honest_
- [x] raise the test-level budget with `test.setTimeout(240_000)` (the heavy
  tier, precedent `specs/agent-chat.spec.ts`) — the default 90s
  `SPEC_TEST_TIMEOUT_MS` cannot hold a 65s cold turn plus the rest of the
  flow; stays at the `E2E_HEAVY_TEST_TIMEOUT_MS` ceiling the e2e-policy
  guard greps for _done_
- [x] verify against a COLD environment (dev server restart + fresh
  project): the spec passes with the spinner genuinely visible for the whole
  cold stretch — the spinner-waiter is the instrument (it fails fast when no
  spinner is up, and bails when the spinner disappears mid-wait), so a green
  cold run IS the continuity proof _green in 20.4s after a full dev-server
  restart (workerd freshly killed) + fresh fixture project; local cold is
  much milder than preview cold (~10s turn 1 vs 35–65s), so the preview CI
  lane below is the decisive continuity check_
- [x] no `expect.poll`/retry reintroduced _diff is pure deletion + two
  budget lines_
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

- Read middlewright's spinner-waiter source to confirm the verification
  premise: on a wait it fails fast (~1s) when no spinner is visible, and
  while a spinner IS visible it polls every 250ms (after a 3s grace) and
  bails the moment the spinner disappears without the target. So the green
  cold run is itself the "spinner visible for the whole stretch" proof — no
  extra instrumentation needed.
- e2e-policy guard check: its grep matches lowercase `timeout:` literals
  only, so neither `spinnerTimeout: 120_000` nor `test.setTimeout(240_000)`
  trips it, and 240s is exactly the `E2E_HEAVY_TEST_TIMEOUT_MS` ceiling it
  enforces (agent-chat.spec.ts already sits there, so no new lane worst
  case).
- Local cold verification hiccup, twice: `pnpm spec` failed with "Process
  from config.webServer exited early" when the dev server was up but
  workerd was cold — Playwright's health probe timed out, so it launched
  `dev.ts start --detach --keep-alive`, which hit the "already running"
  early-return (apps/os/scripts/dev.ts:66) and exited before the URL was
  ready. That early-return path never reaches the keep-alive hold.
  Pre-existing, unrelated to this change; noting rather than fixing here.
- Cold run: dev-server restart (workerd additionally auto-killed for RSS
  right before) + fresh fixture project → first test green in 20.4s, turn 1
  through the spinner-visible wait path.
- Net effect vs before: the spec is now cheaper (one agent + one turn less)
  and slightly faster even on cold, since the warm-up previously paid the
  same cold cost at the itx level plus its own agent setup.
