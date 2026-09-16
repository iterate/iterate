# Defer preview artifact cleanup

Status: implementation and local checks complete; baseline measured, changed preview run pending. Normal test runs will keep their DO/data reset but leave Cloudflare Artifacts repositories for release cleanup.

The request is to remove artifact sweeps from normal preview runs and measure the result. Existing traces show roughly 90 seconds spent sweeping repositories before and after tests. This work does not change DO lifetime, test scheduling, or restore previews after cleanup.

- [x] Verify repository identity/isolation, including deployment-wide repositories. *Project repos include generated project IDs; the global-repo E2E uses a UUID path.*
- [x] Preserve artifacts during pre-test and post-test resets; retain deletion on PR close, explicit reclaim/expiry GC, and normal operator erasure. *`reset` passes `--preserve-artifacts`; `down` keeps the sweep. Close cleanup always includes OS/Streams, even with incomplete app records.*
- [x] Cover the cleanup policy with focused tests and run required local checks. *202 preview tests pass; CLI help accepts the flag. Typecheck, lint, knip and formatting passed. Workspace tests passed in bounded batches after the parallel run timed out in the unchanged shared subprocess test; OS reports 3,183 passing tests.*
- [ ] Open a draft PR and measure a baseline and changed preview run; report reset durations, artifact retention, test outcome, and any unrelated bottlenecks.
- [ ] Address review feedback and record the measured result in the PR.

Manual `preview release` only releases the lease today; its behavior is unchanged.

Assumptions: retaining orphaned repositories until slot release is acceptable. Storage still has a cost; this change does not retain artifacts forever by design. Existing slot ownership checks and all other cleanup stay intact. A missed release may leave repositories until a later full cleanup.

## Measurements

Baseline: [Depot run zv6b4czzbb](https://depot.dev/orgs/0p91s0lz49/workflows/d7psb1f6hf), head `3936a0f106d311ec40b58d7476df0e696553d3a5`, slot `preview_3`, full six-shard preview.

| Metric | Baseline | Preserve artifacts |
| --- | --- | --- |
| Whole run | 600s | Pending |
| Pre-test reset | 101.0s | Pending |
| Post-test reset | 111.3s | Pending |
| Repos swept before/after | 546 / 555; both hit deadline | Pending |
| Outcome | Green; one absorbed Vitest retry | Pending |

Baseline retry: `a stream survives being evicted after journaling oversized events` received `stream-unavailable: Internal error in Durable Object storage caused object to be reset` (reference `fq5ian0vc2nhrjb6s7sudejb`). This predates the implementation.

## Implementation log

- Created from `origin/main` at `17e937695b` after PR #2659 merged. Previous lifetime experiments are excluded.
- Historical comparison: the recorded unsharded run spent 4.5s/9.2s on OS reset plus D1/KV and 93.6s/92.5s in artifact cleanup windows before/after tests. These intervals are not isolated DO measurements.

Session: `01a0ab0a-7542-7223-8003-e996bc9bce72`.

- Independent review caught interrupted-preparation cleanup: the slot can be leased before app records exist. Close cleanup now includes both data owners, while filtering obsolete app names. No runtime/core changes.
