# Code review — Scheduler PR #1698 (self-review, branch six-reptile)

Scope: full PR diff vs main. Rules: `jonasland/RULES.md` does not exist in this checkout, so the review
ran against the repo's canonical rule sources (docs/coding-style.md, docs/typescript-conventions.md,
docs/testing.md, docs/vitest-patterns.md, docs/domain-objects-and-stream-processors.md, CONTEXT.md
glossary) plus standing feedback rules. Three parallel reviewers: adversarial correctness/concurrency,
repo conventions, test quality/API.

## Correctness findings

### F1 — Schema-invalid raw appends poison the fold (platform-wide behavior, scheduler aggravation)

`stream-processor.ts:475` parses payloads before reduce; a malformed raw `schedule-set` poisons ingest
(3 retries → disconnect; catchUp swallows forever; command surface times out; due entries hot-loop the
alarm at 1s). The parse-poison itself is the platform's established behavior for every processor
(changing `#reduceRawEvent` semantics repo-wide is out of scope for this PR, and silent-skip has its own
data-loss failure mode — see the itx-v2 ZodError incident). **Decision: fix the scheduler-specific
aggravation only — barren-wake backoff (see F2) so a wedged scheduler degrades to slow polling, not a
1s hot loop. Base-class behavior left for a follow-up discussion.**

### F2 — trigger-requested idempotency key collides across schedule incarnations (BLOCKER)

`scheduler-processor-implementation.ts` keyed requests `scheduler/trigger-requested:${key}:${nextTriggerAt}`.
Stream idempotency is forever, so re-setting a one-shot with the same `{at}` dedupes against the OLD
request → never triggers → due-forever → 1s alarm hot loop. **Fix: include the incarnation —
`…:${definedAtOffset}:${nextTriggerAt}` — plus exponential barren-wake backoff in triggerDue (a wake
that only deduped backs off toward the heartbeat instead of re-arming at 1s).**

### F3 — Checkpoint-loss replay re-executes history (BLOCKER-ish)

The `processEvent` pending-gate is dead code (per-event reduction state always contains the just-reduced
request); the real guard is the post-barrier recheck, which misses completions in later catch-up pages
(500-event boundaries). A checkpoint reset (erase-data, DO migration) would re-run every historical
trigger whose completion is in a later page. **Fix: `#execute` checks the stream for the completion's
idempotency key before invoking (one indexed read per execution, trivial at scheduler rates); dead gate
removed; comment rewritten honestly.**

### F4 — Failed success-append recorded as `outcome: "failed"`

The catch around invoke+append conflates a transient completion-append failure with a script failure
(and drops the result). **Fix: try scopes the invoke only; the completion append happens outside and
propagates to the sweep-retry path on failure.**

### F5 — alarm() can exhaust CF retries and leave a due scheduler alarm-less

`triggerDue`'s stream append throws before any repoint during a Stream-DO outage; CF's alarm retry
budget is bounded. **Fix: alarm() catches, arms a 60s fallback alarm, rethrows.**

### F6 — Recurrence union ambiguity (`{ every: 60, at: "garbage" }` silently parks)

looseObject union members admit sibling discriminant keys; schema-match and runtime `in`-dispatch can
disagree. **Fix: `assertValidRecurrence` requires exactly one of at/every/cron and (per test review A1)
rejects cron expressions with no future occurrence. Raw appends still park totally in reduce.**

### Also verified safe (details in reviewer transcripts)

triggerDue vs in-flight batch state; double completion impossible; pendingTriggers cannot leak (sweep +
heartbeat); waitUntilEvent barrier has no lost-wakeup; setAlarm replace semantics; worker-loader cache
keys are content-hashed (no isolate churn); script wrapper syntax containment; RPC/serialization of
ScheduleView; test harness fidelity (restart test, dedupe semantics).

## Product decision taken

### C4 — Immortal heartbeat on empty schedulers

"Never delete the alarm" means every project that ever touched the scheduler wakes a DO every 15min
forever, including emptied ones (each e2e run adds two). **Decision: `nextWakeAtMs` returns null when
schedules AND pendingTriggers are both empty → alarm deleted; the next set() re-arms via the command
path (read-your-writes + arm). Residual: a raw-append-only first schedule on an empty scheduler relies
on the configured-subscriber wake chain + its stream-side retries — same residual already accepted in
the design discussion.**

## Convention findings (all fixed)

- V1: "Q5 layer 2 of the design discussion" comment references an artifact not in the repo → deleted.
- V2: "fired by a durable alarm" in the published `Scheduler` docstring violates the glossary
  (_Avoid: firing_) → "triggered"; same in recurrence.ts ("already fired" → "already ran");
  types-source regenerated.
- M1: duplicated 3am constraint prose at the DO callsite → trimmed to one line.
- M2: test fixture key "job" (glossary-avoided) → "report"; "double-fire" comment → "double-trigger".
- M3: reduce override's type intersection dropped if it compiles bare (matches siblings).
- M4: `readAlarm` made required (optionality only served the test harness; `?? null` papered over it).
- json() returns JsonValue like the capability-host twin.

## Test findings (adopted: A1, A2, A3, A4, A5, A6, B6 + new tests for F2/F3/F4/backoff; skipped: A7 duplicate-executionId raw-append (adversarial-only), A8/B5/B7 marginal assertions)

- A5: repointAlarm rejection keeps the batch retryable (the await is load-bearing); default fake async.
- A1: parked-cron lifecycle (no-future cron rejected at set; raw-append parks visibly, survives completion).
- A6: `canonicalRecurrence` moved to recurrence.ts (pure math; testable) + table test for `{in}` sugar.
- A2: raw-append ghost-key trigger-requested → skipped completion; unknown-executionId completion no-op.
- A3: getScheduleView/listScheduleViews shape pinned (metadata round-trip, ISO conversion, sort).
- A4: manual trigger advances the recurring clock / consumes a one-shot (docstring promises).
- B6: e2e asserts exactly one marker event (exactly-once side effect per occurrence).

# Plan (TODO)

Executed autonomously in this order (goal-hook session; decisions recorded above in bold):

1. ✅ F2: incarnation-scoped idempotency key + barren-wake exponential backoff.
2. ✅ F3: completion-existence pre-check in #execute; remove dead gate.
3. ✅ F4: append outside the invoke try.
4. ✅ F5: alarm() fallback re-arm on failure.
5. ✅ F6 + A1: exactly-one recurrence key + no-future-cron rejection in assertValidRecurrence.
6. ✅ C4: alarm deleted when state is empty (repointAlarm takes number | null again).
7. ✅ Convention fixes V1/V2/M1/M2/M3/M4 + JsonValue.
8. ✅ Test additions A1-A6, B6 + regression tests for F2/F3/F4/backoff; full suite + e2e re-run.
