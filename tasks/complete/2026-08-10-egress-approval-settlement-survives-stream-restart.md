---
status: complete
size: small
---

# Egress approval settlement survives a stream restart

## Status summary

Complete. Keyed root appends now get one bounded availability replay, approval
decisions are replay-safe, and a fetch cannot report success until its
settlement fact is durable. Focused preview proofs and the full preview suite
pass without retries; PR #2467 is ready for review.

## Problem

Preview 8 worker version `6291b7de-419a-4ba1-92d6-32c9b9e48951` reproduced
this sequence on 2026-08-10:

- the stream restart was injected at `14:14:49.966Z`;
- the approval decision append completed at `14:14:50.993Z`;
- the held Script Execution recovered and returned HTTP 200 at
  `14:14:51.689Z`;
- the worker logged `egress approval: settle append failed` for project
  `prj_dc2de56d94ab423391cb047faae7c420`, approval offset 41, index 0 at
  `14:14:51.459Z`;
- the public `waitForEvent` then expired after 30 seconds because no
  `human-approval-settled` fact existed.

The settlement append already has an idempotency key, so retrying a
retryable Durable Object availability failure is safe. A successful approved
fetch must not return before that durable outcome is recorded. Non-retryable
append failures must still fail loudly instead of becoming a successful but
divergent result.

## Checklist

- [x] Add one regression through the Project Egress public behavior: a held
      request is approved, the first settlement append gets a retryable stream
      reset, the caller receives the upstream response, and exactly one
      settlement fact exists. _The root-append unit test covers the reset and
      one replay; the production-shaped restart e2e proves the end-to-end
      outcome._
- [x] Confirm the regression fails because the current code swallows the
      settlement append failure. _A public collision on the deterministic
      settlement key first reproduced a false HTTP 200 with no settlement._
- [x] Retry the keyed settlement append through the existing bounded,
      observable idempotent-operation policy. _Keyed root appends now get one
      explicit replay; they do not inherit the orphan deadline used by
      non-root processor paths._
- [x] Keep non-retryable settlement failures visible to the caller. _The
      Project DO now rejects the held fetch if success or error settlement
      cannot be journalled._
- [x] Run the focused unit/integration checks, then the forced-restart e2e
      against a preview deployment with no retry layer. _Stream RPC 35/35,
      approve-core 17/17, both package typechecks, settlement-collision e2e,
      and forced-restart e2e passed; the latter two passed on their first
      attempts against preview 1._
- [x] Audit the preview trace/log window for one decision, one settlement,
      no swallowed append warning, and no unexplained errors. _The restart
      window had no settlement warning or attributable retry. The deliberate
      collision trace `ee9193f23c9f92b54d06953904d9e098` records the expected
      egress error, no worker error log, and no settlement fact._

## Implementation log

- 2026-08-10: PR #2460 was squash-merged as `f83499aa`. This follow-up was
  split out after its final docs-only preview's retry was traced to the
  settlement append, not the mobile restoration paths or the parked Script
  Execution recovery itself.
- 2026-08-10: Added deterministic decision idempotency keys so the bounded
  append replay cannot duplicate an approval decision after an ambiguous
  reset.
- 2026-08-10: The first follow-up preview exposed a merge-integration gap:
  #2460 contained the Notifications screen and specs, while its drawer link
  existed only in that branch's old base history. Restored the link alongside
  the current integrations/repos/media entries. Both affected mobile specs
  then passed locally and in canonical preview CI without retries.
- 2026-08-10: Final preview CI on `67168d04` passed every check: 199 OS Vitest
  tests, 73 Playwright tests, and no retries. Its 190.9s OS lane is below the
  preceding failed run's 210.0s, but still trips the repo's existing 100s
  performance warning; this PR did not raise that baseline.
