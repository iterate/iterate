---
status: in-progress
size: small
---

# Egress approval settlement survives a stream restart

## Status summary

Diagnosed from PR #2460's final preview audit. The approved fetch and Script
Execution recover correctly, but one retryable stream reset can drop the
per-request `human-approval-settled` fact because its keyed append is logged
and swallowed. Missing: a red public-behavior regression, the bounded
idempotent retry, and preview proof.

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

- [ ] Add one regression through the Project Egress public behavior: a held
      request is approved, the first settlement append gets a retryable stream
      reset, the caller receives the upstream response, and exactly one
      settlement fact exists.
- [ ] Confirm the regression fails because the current code swallows the
      settlement append failure.
- [ ] Retry the keyed settlement append through the existing bounded,
      observable idempotent-operation policy.
- [ ] Keep non-retryable settlement failures visible to the caller.
- [ ] Run the focused unit/integration checks, then the forced-restart e2e
      against a preview deployment with no retry layer.
- [ ] Audit the preview trace/log window for one decision, one settlement,
      no swallowed append warning, and no unexplained errors.

## Implementation log

- 2026-08-10: PR #2460 was squash-merged as `f83499aa`. This follow-up was
  split out after its final docs-only preview's retry was traced to the
  settlement append, not the mobile restoration paths or the parked Script
  Execution recovery itself.
