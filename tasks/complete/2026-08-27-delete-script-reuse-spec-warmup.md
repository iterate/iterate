---
status: in-review
size: small
base: deadline-derived-wakes (#2532), itself stacked on platform-stall-repros (#2530)
---

# Delete the warm-up turn from the script-reuse spec (first test)

## Status summary

Re-stacked as the final car of the merge train (#2530 repros → #2532 fix →
this): `deadline-derived-wakes` is merged in, both script-reuse tests are
UN-QUARANTINED, and the warm-up deletion stands. This PR's preview runs are
the quarantine's own exit-criteria proof — the warm-up-free first turn
under real churn, bounded by the attempt-progress watchdog (worst case two
severed attempts: 45+10+45+20 = 120s = exactly the turn-1 spinner budget).
PR: #2529.

The earlier investigation (below) found the warm-up wasn't absorbing a
compute cost but a platform gap — an in-flight LLM request severed by
eviction churn was invisible until a staleness wake; first turns took
150s/183s. The UI was always fine (spinner continuous, honest "processor
revived" dividers).

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
  test) _FAILED both attempts on run w1hcwnlc3q: "Spinner was still visible
  after 120000ms". Server-side journals show both turns completed — in 150s
  and 183s — after repeated processor evictions with a hung re-dial per
  cycle. Blocked on the #2530 fix direction; see the investigation log
  below_

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

## Preview-failure investigation (2026-08-27)

- Preview lane run w1hcwnlc3q: both attempts failed with "Spinner was still
  visible after 120000ms" — so the working indicator WAS continuous (no UI
  dead gap; the screenshots even show honest "agent processor revived" /
  "capability-host processor revived" dividers). The platform just didn't
  deliver turn 1 in 120s.
- Server-side journals (fixture projects persist on preview_6): attempt 1's
  turn settled 150s after `llm-request-requested`, spanning one
  `stream/processor-revived`; the retry's settled at 183s — after the whole
  suite had ended — spanning four revivals. Pattern: request → silence →
  30-40s staleness wake → revival → re-dial that ALSO hangs (same churn
  window) → repeat until an attempt lands on a healthy path.
- Harness probe (virtual time): eviction → revival + re-dial at +10s
  (works, #2480), then a hung re-dial is invisible until the keepalive
  wedge breaker at +15m10s. A hung attempt never FAILS, so the 10/20/40s
  retry ladder never engages — the missing piece is an attempt-progress
  deadline (#2510's gap, entered through the routine churn path).
- The warm-up therefore wasn't masking slowness; it was a sacrificial agent
  absorbing churn-window wedge risk behind a swallowed `.catch`.
  Reproified + fix direction proposed in #2530 (which merged the other open
  repro PRs #2518/#2513/#2486 and closed them).
- Also seen that run, all pre-existing: the vitest lane failed on the known
  facet source-version false alarm (#2518's subject), and mobile approvals
  hit a 4901 pager close.
