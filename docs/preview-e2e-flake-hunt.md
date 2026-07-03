# Preview e2e flake hunt

Goal: run the full preview e2e lane against a real preview environment 50
times in a row without a single flake, fixing and documenting every failure
encountered along the way.

Method: deploy this PR's preview slot, then loop
`doppler run --project _shared --config prd -- pnpm preview test --pull-request-number <N>`
from a workstation. Every failure gets a root-cause diagnosis and the smallest
reliable fix, recorded below. A failure resets the consecutive-green counter.

## Run log

(populated as runs complete)

## Flakes found and fixed

### 1. Leaked semaphore leases starve the slot fleet

Found before the first e2e run: every slot was leased, but pr-1634 and
pr-1636 each held **two** slots while their PR bodies recorded only one. A
deploy run that is cancelled (`cancel-in-progress` on a rapid push) between
the semaphore acquire and the PR-body write leaves a lease no later run knows
about; the next run sees "no lease recorded" and leases a second slot. The
leaked lease blocks other PRs for up to the full lease duration, and their
deploys queue for 20 minutes then fail.

Fix: `claimEnvironmentConfigLease` now adopts any lease the semaphore already
attributes to the holder (re-issued under a fresh leaseId, same pattern as
lease repair) before acquiring a fresh slot. Guard test in
`scripts/preview/preview.test.ts`.
