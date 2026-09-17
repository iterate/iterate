---
status: in-progress
size: medium
---

# Retire preview DOs, then restore the tested deployment

Specification committed first. This experiment replaces post-test parking with
park-then-restore, and tests whether GitHub can show green after tests pass while
the cleanup job continues. No merge is authorized.

## Request and decisions

- Start from current main, not the closed storage-wipe experiment. Keep the
  existing class-retirement reset, then redeploy the real app code/configuration
  on the same slot. Do not resurrect deleted namespaces or restore old data.
- Limit the new behavior to post-test cleanup. Pre-deploy reset and final
  PR-close/expiry reclamation retain their existing behavior. Keep the lifecycle
  lock until restoration finishes, and refuse stale-head/foreign-lease writes.
- Prefer the existing deploy machinery so secrets, assets, service bindings,
  container metadata and DO exports are restored consistently. Determine whether
  a direct snapshot/re-upload is actually simpler before adding another deploy
  implementation. Use the exact tested checkout and record new Worker versions.
- After all consumers settle and their results are validated, let test success
  show green while post-test work continues. Do not overwrite a failed test or
  another attempt's result. Investigate updating the exact Depot-owned check;
  a same-named commit status does not replace that check. If this cannot work
  reliably, use an explicit test result and separate cleanup reporting instead.
- Cleanup/restoration failure must produce red on the originating commit.
  Verify success, failure, cancellation and stale-run behavior experimentally;
  do not quietly swallow errors or change repository protection settings.
- Restore application usability, not merely HTTP 200. Prove old non-container
  namespace IDs were retired, fresh project/stream work succeeds, deployed
  versions and bindings match, and leftover work is not burning resources.
  Existing retained container-class limitations must be stated explicitly.
- Produce a clear report and PR body with measured test-green time, cleanup/
  restoration time, platform constraints, cancellation behavior and verdict.
  A negative result is acceptable; avoid product hacks to force success.

## Work

- [ ] Research current restore machinery and GitHub/Depot check ownership.
- [ ] Implement and test the smallest post-test park/restore path.
- [ ] Implement and test honest early-green/final-failure reporting.
- [ ] Run preview experiments, including an injected cleanup failure and recovery.
- [ ] Validate resulting namespaces, fresh application behavior and activity.
- [ ] Complete local checks, independent review and CI/review follow-up.
- [ ] Publish report, update PR and mark task complete.

## Implementation log

- Base: main `8f8ff8d695`. Previous experiment PR #2693 is closed. The change-type
  planner branch is preserved separately and is not part of this experiment.
- Acceptance distinguishes GitHub's check status from Depot's real job state;
  advancing the former must not release locks or start consumers early.
