---
status: in-review
size: medium
---

# Platform stall repros, consolidated: parked states need a wake condition

## Status summary

Consolidation branch: merges the three open repro PRs (#2518, #2513, #2486),
adds one new expected-fail spec (the eviction-churn LLM re-dial hang found
while investigating #2529's preview failure), and names the mechanism they
share plus a fix direction that covers all of them. Repro-only apart from
the halt self-heal fix carried in from #2486. The three source PRs close in
favor of this one.

## The five threads

1. **Mid-stream LLM stall never settles** — #2510 (already merged):
   `apps/os/src/domains/agents/agent-llm-stall.test.ts`. A hung attempt
   never fails, so nothing settles until the keepalive wedge breaker
   (~15min).
2. **Eviction-churn re-dial hang** (new, this branch): second expected-fail
   in the same file. Eviction mid-attempt recovers fine (revival + re-dial
   within ~10s — #2480's fix works), but when the re-dial goes out during
   the same churn window and also hangs, no third attempt and no settle
   happen for ~15m10s on a quiet stream. On busy preview streams,
   deliveries shorten that to the observed 150s/183s first turns (PR #2529
   investigation; Depot run w1hcwnlc3q; projects
   `agent-script-reuse-mtbkj6o8-c56ce7a9` / `-mtbkmi8q-b6f3c4e3` on
   preview_6). The 10/20/40s retry ladder (#1826) never engages because a
   hung attempt never *fails*.
3. **Halted fan-out subscription is parked forever** — from #2486 (with its
   fix): a halt had no wake condition until the deploy-version antidote;
   pre-existing halts still need manual resume, and a halt under an
   unchanged deploy still waits indefinitely.
4. **Transient registry-propagation failure kills bootstrap permanently** —
   from #2513: `build-backend-transient-resolution.test.ts`. A retryable
   egress failure is classified terminal; the saga parks with no retry
   deadline.
5. **Facet source-version pin false-alarms** — from #2518:
   `userspace-facet-recycle-false-alarm.e2e.test.ts`. A coincidental
   recycle is indistinguishable from the commit-triggered rebuild because
   rebuilds carry no provenance (no "why did I rebuild").

## The common mechanism

Threads 1–4 are one gap wearing four hats: **a parked or in-flight state
whose progress depends on an external push that may never come**. The
platform re-drives obligations on *delivery*; no state carries its own
deadline. An open LLM attempt has no chunk-idle budget; the 10-minute
expiry is a comparison, not a timer (`tasks/agent-llm-deadline-alarm.md`,
proven live with FOUR-DAY orphans on prd); a halted subscription had no
wake until #2486 taught it one specific wake (deploy version change); a
bootstrap saga hit by weather parks terminally instead of parking *with a
retry time*.

Thread 5 is the observability twin: states change without recording **why**
— the same shape #2486 had to fix by stamping `workerVersion` on halts
before the antidote could be decidable.

## Fix direction (one primitive, four applications)

Extend `tasks/agent-llm-deadline-alarm.md`'s sketch from "arm an alarm at
the expiry horizon" to a general rule: **every parked/in-flight state in
reduced state carries a `nextDeadlineAt`, and the processor host arms its
DO alarm at `min(keepalive, nextDeadlineAt over all obligations)`;
firing runs the ordinary catch-up/reconcile.** Because the deadline derives
from reduced state, it is recomputed on revival and survives eviction by
construction.

Applications:

- **LLM attempts** (threads 1, 2): deadline = `min(lastProgressAt +
  chunkIdleBudget, expiresAt)` where progress = dial or chunk (both already
  journaled). On fire: abort the in-flight slot, settle the attempt
  `failed` — the existing 10/20/40s ladder then owns re-dialing. This turns
  a churn-window severance from "30s–15min of dead air per cycle" into
  "chunkIdleBudget + ladder step", and makes first-turn latency on preview
  boundable — which is what unblocks deleting spec warm-ups (#2529).
- **Halted subscriptions** (thread 3): keep #2486's deploy antidote, add
  `haltedAt + reprobeBackoff` as a deadline so a halt self-heals (paced)
  even without a deploy, and pre-existing versionless halts stop needing an
  operator.
- **Bootstrap saga** (thread 4): classify registry-propagation failures as
  transient; park with `retryAt` instead of terminal failure. Same
  primitive, different obligation.
- **Provenance** (thread 5): facet rebuilds record their trigger
  ("source-commit <sha>" vs "cold-boot"), the way halts now record
  `workerVersion`. The pin then asserts causality instead of coincidence.

The budgets (chunkIdleBudget, reprobeBackoff, retry caps) are product
decisions the fix makes; the expected-fail specs deliberately pin
placeholder numbers (60s) the same way #2510 did.

## Checklist

- [x] merge `facet-recycle-false-alarm-repro` (#2518) _clean merge_
- [x] merge `worker-build-registry-race-spec` (#2513) _clean merge_
- [x] merge `stream-fanin-stall-repro` (#2486) _one additive conflict in
  the sender test harness args (both sides added options — kept both);
  generated itx api files regenerated and confirmed identical_
- [x] new expected-fail spec for the eviction-churn re-dial hang _sibling
  test in `agent-llm-stall.test.ts`, budget measured with a throwaway probe
  first: re-dial at +10s works, then nothing until +15m10s_
- [x] verify the new spec fails for the intended reason when unmarked
  _`{settled: 0, attemptsDialed: 2}` a minute after revival_
- [ ] close #2518, #2513, #2486 pointing here
- [ ] checks green, PR open

## Implementation log

- The eviction-churn spec's numbers come from a probe run before writing
  the assertion: crash at t0 → revival fact + re-dial at t0+10s (first
  keepalive alarm) → no further state change until t0+15m10s, when the
  wedge breaker settles the request. See PR #2529's investigation for the
  live preview evidence this models.
