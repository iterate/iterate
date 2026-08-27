---
status: in-progress
size: large
base: platform-stall-repros (#2530)
---

# Deadline-derived wakes: waiting states arm their own alarm

## Status summary

In progress, stacked on #2530 (which holds the repros, the analysis, and
the quarantines this fix un-parks). Goal: the minimal implementation of the
fix direction in `tasks/platform-stall-repros.md` — every waiting state
derives a `nextDeadlineAt` from reduced state; the processor host arms its
Durable Object alarm at `min(keepalive, deadline)`; firing runs the
ordinary reconcile. Acceptance is mostly already written: the expected-fail
specs on the base branch flip to plain passing tests.

## The rule

One primitive, per `tasks/platform-stall-repros.md` and extending
`tasks/agent-llm-deadline-alarm.md`:

- Each processor exposes a pure `nextDeadlineAt(reducedState): number|null`
  next to its reduce.
- The host arms the DO alarm at `min(keepaliveAt, nextDeadlineAt)`,
  persists the desire beside the keepalive record, re-arms after every
  commit and every fire. Imperative "arm an alarm and hope" is exactly the
  bug class (see the Bugbot edge on #2530): in-memory intent gets wiped;
  a derivation is recomputed identically by every incarnation.
- On fire: run the ordinary catch-up/reconcile — no new recovery
  entrypoint. The reconcile compares `now` to the same derivation and acts.
- Facts needed by a derivation get journaled ("if it happened and we might
  care, journal it" — Misha, 2026-08-27). Chatty facts ride the ephemeral
  lane; machinery events get no model/UI face unless they earn one.

## Scope: minimal per hat

- [ ] **Host primitive**: deadline slice on the processor host — computed
  from reduced state post-commit, persisted, armed at min with keepalive,
  fire → catch-up. Works for facets via the parent-owned alarm proxy.
- [ ] **Hats 1+2 — LLM attempt progress deadline** (agent processor):
  `nextDeadlineAt = min(lastProgressAt + chunkIdleBudget, expiresAt)` where
  lastProgressAt derives from journaled facts (request, chunks, attempt
  dial stamp — journal the dial as a machinery event). On fire: abandon the
  in-flight slot (the #2498 abort+clear), settle the attempt failed → the
  existing 10/20/40s ladder owns re-dialing. Acceptance: both expected-fail
  specs in `apps/os/src/domains/agents/agent-llm-stall.test.ts` flip to
  passing (drop `.fails`).
- [ ] **Hat 3 — halted subscriptions** (stream event sender): a halt whose
  `workerVersion` differs from the current one derives an immediate-ish
  wake (it IS durable evidence of an owed antidote resume — this replaces
  the bare in-memory `armAlarm` in the `!recorded` branch and closes the
  Bugbot edge); a same-version halt derives `haltedAt + reprobeBackoff` so
  even without a deploy it self-heals, paced. Paused streams derive NO
  deadline (the hot-loop trap) — pause state must gate the derivation.
- [ ] **Hat 4 — bootstrap transient** (worker build backend): classify
  registry-propagation failures transient; park with a journaled `retryAt`
  instead of terminal failure; the saga's deadline derivation retries.
  Acceptance: the #2513 test in
  `apps/os/src/domains/workers/build-backend-transient-resolution.test.ts`
  goes green.
- [ ] **Hat 5 — facet rebuild provenance**: assess cost after scouting; if
  a rebuild can cheaply record its trigger ("source-commit <sha>" vs
  "cold-boot") do it, else defer explicitly with reasoning here. The
  quarantined source-version pin only un-skips when this lands, so
  deferring keeps that quarantine open.
- [ ] Node-harness tests for the new host behavior (docs/
  writing-stream-processors.md; "delicate machinery — do NOT rush" per
  agent-llm-deadline-alarm.md). Budgets (chunkIdleBudget, reprobeBackoff)
  are product decisions — set them deliberately, with comments.
- [ ] Un-quarantine what this fixes where honest: the script-reuse spec
  un-skips only after a green preview run (its exit criteria also want
  #2529's warm-up removal — note the interplay in the PR body rather than
  un-skipping here if sequencing is unclear).
- [ ] Full checks + stacked PR (base `platform-stall-repros`) opened as
  draft; body explains the stack.

## Assumptions (worktreeified while Misha is present but not specifying)

- Budget defaults: chunkIdleBudget ~10s (matches the harness-measured
  revival cadence and the ladder's first rung), reprobeBackoff for halts
  ~5min with cap — flagged for review, argued in comments.
- Hat 5 may be deferred out of this PR; the other four hats are the core.
- The expected-fail specs' 60s placeholder budgets become the real
  assertion budgets unless the chosen product budgets demand adjustment.

## Implementation log

(appended as work happens)
