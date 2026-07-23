---
title: Replace the blind preview rollout age-gate with an active readiness probe
status: open
severity: medium
area: preview-ci
owner: unassigned
created: 2026-07-23
tracks:
  - "#2140 (added the readiness barrier)"
  - "#2261 (removed it)"
  - "#2265 (restored it as a blind 90s age gate)"
---

# Preview rollout DO-reset gate: make it provable, not a blind sleep

## Context

When a fresh preview Worker version deploys, the first access to each Durable
Object triggers Cloudflare to reset that DO to load the new code. A test that
creates a project (or otherwise touches a DO) inside that window fails with
`Durable Object reset because its code was updated`.

- **#2140** guarded this with an active readiness barrier
  (`apps/os/src/deployment-readiness.ts`): ~10 probe waves per namespace, a 10s
  settle, then complete-set revalidation, gating the deploy→`awaiting-tests`
  transition that *all* lanes waited behind.
- **#2261** removed that barrier (fair critique: ~500 synthetic probe RPCs per
  deploy dominated the tail, and a finite sample can't prove the whole fleet),
  but left only an onboarding-smoke gate in front of Vitest — no replacement
  barrier, and no tracking task. Its own round-9 marathon evidence shows the
  reset race recurring and being **retry-absorbed** (7 Vitest + 2 Playwright on
  retry; `OS preview smoke` failing both attempts).
- **#2265** restored a barrier as a **blind fixed 90s sleep**
  (`previewMinimumDeploymentAgeMs = 90_000`, `scripts/preview/preview.ts`):
  DO-backed suites and project-create helpers wait until 90s after the deploy
  timestamp. Both lanes are gated again, so this is not an open production hole.

## Problem

The current gate is a **blind time constant**, not a proof:

1. It *hopes* 90s ≥ the reset-settle window. If the window ever exceeds 90s the
   race silently returns and is absorbed by the single test retry — the exact
   failure the marathon already shows. This is the "sleep through it instead of
   proving the state" anti-pattern (`docs/testing.md` principle 4), relocated
   from the test into the orchestrator.
2. It taxes every healthy run the full 90s even when the rollout settled in ~15s.
3. It lives off the guarded ladder (see the companion budgets.ts follow-up) and
   until this task existed had no protocol tracking.

Evidence the reset flake is still real and retry-absorbed: #2244's marathon
accepted-streak is **0**; the retired harness failed iteration 5 with 12 retries,
most first failures `Durable Object reset because its code was updated`.

## Proposed fix

Replace the blind age gate with a **cheap active readiness gate** that checks the
real invariant and returns as soon as it holds:

- One readiness request **per DO namespace class the suite actually uses** (a
  handful, not 500 fleet-wide synthetic probes), issued once, that forces and
  confirms the post-deploy reset. The reset is idempotent and one-shot per
  version, so a single touch per namespace is sufficient — provable, not
  probabilistic.
- Retry a namespace probe **only** on `durableObjectReset`/`overloaded` until the
  version served matches the deployed Worker version, then move on. Never a fixed
  sleep.
- Bounded by `PREVIEW_ROLLOUT_READINESS_WATCHDOG_MS` on the guarded ladder, sized
  ~2× the measured p99 settle. A rollout that never settles *should* fail the run
  (principle 3), not be slept through.
- Both lanes wait on the same ready signal (Vitest at its fan-out boundary,
  Playwright's project-create helpers on the same gate).

Sketch in `docs/flake-athon-audit-2026-07.md` § 1 and § 7-D.

## Interim state (already landed)

- Constant moved onto the guarded ladder (`budgets.ts`) so it can't drift as a
  bare literal — see `docs/flake-athon-audit-2026-07.md` § 7-A.

## Exit criteria (remove this task when all hold)

- [ ] The blind `previewMinimumDeploymentAgeMs` sleep is gone; the gate is an
      active readiness probe bounded by a laddered watchdog.
- [ ] `scripts/preview/flake-hunt-loop.sh` reaches a **non-zero zero-retry
      streak** with **no** `Durable Object reset because its code was updated`
      in any first attempt across the streak.
- [ ] The healthy-run start delay is the *measured* settle time, not a fixed 90s.
