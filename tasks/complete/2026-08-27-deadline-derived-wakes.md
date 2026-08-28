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

- [x] ~~**Host primitive**: deadline slice on the processor host~~ _not
  needed for the minimal fix — scouting showed each hat has a smaller
  honest seam (below). The registry's `setAlarmSlice` machinery exists for
  a future hat that genuinely needs a durable per-processor deadline; the
  scheduler and device processors already use it_
- [x] **Hats 1+2 — LLM attempt progress watchdog** (agent processor):
  chunks are contract-forced ephemeral (can't fold a durable
  lastProgressAt), so the watchdog lives on the in-flight slot instead:
  `lastProgressAtMs` refreshed at dial + every chunk, a `host.sleep` loop
  in the same background dispatch settles the attempt `failed` at 45s idle
  (LLM_ATTEMPT_IDLE_BUDGET_MS, argued in its comment) → the 10/20/40s
  ladder owns re-dialing. Sound despite being in-memory: every loss path
  is covered — eviction loses attempt AND watchdog together, keepalive
  revival's adopt re-dial arms a fresh one. _Both stall pins flipped to
  plain passing tests; new false-trip guard test (slow-but-chunking
  attempt survives); 3 agent-processor tests updated where they held
  manual-respond attempts idle past 45s; the #2498 wedge pin now
  documents watchdog-first settlement (horizon stays the outer backstop,
  still covered by the adopt-expiry test)_
- [x] **Hat 3 — halted subscriptions** (stream event sender): a
  stale-version halt IS durable evidence of an owed antidote resume, so
  `#armAlarmFromStore` now derives the wake from it (1s lifecycle pace),
  gated on `!state.paused`; the `!recorded` branch's bare in-memory
  `armAlarm` — the #2530 Bugbot edge — is deleted in favor of the
  derivation. _Two new sender tests: interrupted-append retry wake
  survives recomputation and lands the resume; paused stream derives no
  wake. Deliberate cut: same-version halts still wake only on the next
  deploy (#2486's shipped design) — a `haltedAt + reprobeBackoff`
  self-heal needs a timestamp and a probe counter in reduced state,
  deferred as not repro-backed_
- [x] **Hat 4 — bootstrap transient** (worker build backend):
  `executeWorkerBuild` re-runs the install/bundle up to 3 attempts when
  every failure line is a version-resolution shape (the two propagation
  -window patterns only; parse/install crashes stay one-shot). No
  artificial pause — the bundler call itself takes seconds, which is the
  pacing. _#2513's pin flipped to a plain passing test; the
  pattern-parameterized loud-failure test updated to model a PERSISTENT
  warning (mockResolvedValue, not Once). Deliberate cut: minute-scale
  propagation windows still fail loudly — the saga-level journaled
  `retryAt` park is a follow-up, per the two-seam analysis_
- [x] **Hat 5 — facet rebuild provenance**: ~~implement here~~ _deferred:
  distinct subsystem (dynamic worker build/probe surface), e2e-only
  verification, no unit pin to flip. Its quarantine's exit criteria
  (rebuilds carry their trigger) is unchanged and still owned by
  tasks/platform-stall-repros.md_
- [x] Tests: all via the existing node harness (advanceTime drives the
  watchdog through the virtualized host.sleep); agents + streams + workers
  domains fully green (854 passed / 7 unrelated expected-fail pins)
- [ ] Un-quarantine sequencing: the script-reuse spec's exit criteria also
  wants a green preview run with #2529's warm-up removed — un-skip lands
  with that merge train, not here; explained in the PR body
- [ ] Full checks + CI green on the stacked PR

## Assumptions (worktreeified while Misha is present but not specifying)

- Budget defaults: chunkIdleBudget ~10s (matches the harness-measured
  revival cadence and the ladder's first rung), reprobeBackoff for halts
  ~5min with cap — flagged for review, argued in comments.
- Hat 5 may be deferred out of this PR; the other four hats are the core.
- The expected-fail specs' 60s placeholder budgets become the real
  assertion budgets unless the chosen product budgets demand adjustment.

## Implementation log

- Three scout maps (host/keepalive/alarm machinery; agent turn-loop
  lifecycle; build-backend failure path) reshaped the plan from "one grand
  host primitive" to three small local seams. Key findings that drove it:
  chunk events are contract-forced ephemeral and not consumed (no durable
  lastProgressAt is derivable), `#atHead` runs only on delivery, a hung
  attempt never fails so the ladder never starts, and the sender's
  `#armAlarmFromStore` is already the derive-from-durable-state pattern the
  fix generalizes.
- The "derive from reduced state" principle survives in amended form: derive
  from durable state where the wake must outlive an incarnation (hat 3), and
  use an in-incarnation watchdog where every incarnation-loss path is
  already covered by an existing durable wake (hats 1-2: keepalive revival →
  adopt re-dial → fresh watchdog).
- Collateral test updates were all of one shape: suites that held
  manual-respond attempts idle across large advanceTime windows now meet
  the watchdog; tightened their timelines rather than widening the budget.
- Spec-1's original tail (`openRequest` ends null) was under-specified — the
  true contract is stronger (the ladder re-dials, so a fresh request
  legitimately opens); rewritten with a comment saying so.
