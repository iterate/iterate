# Defer preview artifact cleanup

Status: scoped; implementation and live measurements pending. Normal test runs will keep their DO/data reset but leave Cloudflare Artifacts repositories for release cleanup.

The request is to remove artifact sweeps from normal preview runs and measure the result. Existing traces show roughly 90 seconds spent sweeping repositories before and after tests. This work does not change DO lifetime, test scheduling, or restore previews after cleanup.

- [ ] Verify repository identity/isolation, including deployment-wide repositories.
- [ ] Preserve artifacts during pre-test and post-test resets; retain deletion on PR close, explicit release/reclaim, and normal operator erasure.
- [ ] Cover the cleanup policy with focused tests and run required local checks.
- [ ] Open a draft PR and measure a baseline and changed preview run; report reset durations, artifact retention, test outcome, and any unrelated bottlenecks.
- [ ] Address review feedback and record the measured result in the PR.

Assumptions: retaining orphaned repositories until slot release is acceptable. Storage still has a cost; this change does not retain artifacts forever by design. Existing slot ownership checks and all other cleanup stay intact. A missed release may leave repositories until a later full cleanup.

## Implementation log

- Created from `origin/main` at `17e937695b` after PR #2659 merged. Previous lifetime experiments are excluded.
- Historical comparison: the recorded unsharded run spent 4.5s/9.2s on OS reset plus D1/KV and 93.6s/92.5s in artifact cleanup windows before/after tests. These intervals are not isolated DO measurements.

Session: `01a0ab0a-7542-7223-8003-e996bc9bce72`.
