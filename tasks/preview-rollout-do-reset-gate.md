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

> **Corrected after the Codex cross-check.** An earlier version of this task
> proposed an *active readiness probe* (one touch per DO namespace class). That
> is **not provably correct**: Cloudflare DO rollout is globally eventually
> consistent *per object/placement*, so probing one identity does not prove a
> future test identity (different placement) has converged. No gate or probe can
> prove convergence — only operations that survive a reset whenever/wherever it
> lands.

Make project creation (and every first-touch operation) **self-heal** across a
reset, then delete the gate — full candidate comparison and recommendation in
[`docs/flake-athon-refactor-options.md`](../docs/flake-athon-refactor-options.md):

1. **Split the availability classifier** so `overloaded` is propagated as typed
   backpressure and never retried (audit finding B2); reacquire only
   `reset`/`retryable`.
2. **Finish the create saga self-heal**: `waitForEvent`
   (`rpc-targets.ts:628-719`) re-arms on reset under its existing deadline, the
   way `waitUntilProcessed` already does — the one residual gap; all other saga
   steps and on-demand DOs already self-heal via the relay + keyed-append door.
3. **Model `create()`'s outcome explicitly** instead of the ambiguous 15 s reject
   while birth continues (finding B3), so a committed create is never surfaced as
   an error.
4. **Consolidate to one canonical `createTestProject()` fixture** and delete the
   per-spec `testInfo.setTimeout` extensions.
5. **Delete** the blind gate + all plumbing.
6. **Replace it with a post-deploy recovery canary** — create a fresh real
   project right after deploy and assert it recovers without a framework retry.
   Proof, not a sleep.

## Interim state (already landed)

- Constant moved onto the guarded ladder (`budgets.ts`) so it can't drift as a
  bare literal — see `docs/flake-athon-audit-2026-07.md` § 7-A.

## Exit criteria (remove this task when all hold)

- [ ] The blind `previewMinimumDeploymentAgeMs` sleep and its plumbing are gone;
      project creation self-heals across a reset (no gate).
- [ ] The availability classifier discriminates `reset|retryable|overloaded`;
      `overloaded` is never retried into a loop.
- [ ] A post-deploy recovery canary asserts a fresh project recovers without a
      framework retry.
- [ ] `scripts/preview/flake-hunt-loop.sh` reaches the **25-consecutive-zero-retry**
      release bar with **no** `Durable Object reset because its code was updated`
      in any first attempt across the streak.
- [ ] The healthy-run start delay is zero — no fixed post-deploy sleep.
