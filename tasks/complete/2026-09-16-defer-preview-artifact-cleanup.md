# Defer preview artifact cleanup

Status: complete. Normal resets preserve Artifacts; full cleanup still sweeps them. Both preview runs passed: reset time fell from 212.3s to 26.3s, and total run time from 10m00s to 6m31s. Independent review found no remaining issues.

The request is to remove artifact sweeps from normal preview runs and measure the result. Existing traces show roughly 90 seconds spent sweeping repositories before and after tests. This work does not change DO lifetime, test scheduling, or restore previews after cleanup.

- [x] Verify repository identity/isolation, including deployment-wide repositories. *Project repos include generated project IDs; the global-repo E2E uses a UUID path.*
- [x] Preserve artifacts during pre-test and post-test resets; retain deletion on PR close, explicit reclaim/expiry GC, and normal operator erasure. *`reset` passes `--preserve-artifacts`; `down` keeps the sweep. Close cleanup always includes OS/Streams, even with incomplete app records.*
- [x] Cover the cleanup policy with focused tests and run required local checks. *202 preview tests pass; CLI help accepts the flag. Typecheck, lint, knip and formatting passed. Workspace tests passed in bounded batches after the parallel run timed out in the unchanged shared subprocess test; OS reports 3,183 passing tests.*
- [x] Open a draft PR and measure a baseline and changed preview run; report reset durations, artifact retention, test outcome, and any unrelated bottlenecks. *[PR #2680](https://github.com/iterate/iterate/pull/2680); measured runs and resource checks below.*
- [x] Address review feedback and record the measured result in the PR. *Independent re-review passed; interrupted preparation and obsolete app names are covered. GitHub had no review threads at completion; the global PR monitor remains registered.*

Manual `preview release` only releases the lease today; its behavior is unchanged.

Assumptions: retaining orphaned repositories until slot release is acceptable. Storage still has a cost; this change does not retain artifacts forever by design. Existing slot ownership checks and all other cleanup stay intact. A missed release may leave repositories until a later full cleanup.

## Measurements

Baseline: [Depot run zv6b4czzbb](https://depot.dev/orgs/0p91s0lz49/workflows/d7psb1f6hf), head `3936a0f106d311ec40b58d7476df0e696553d3a5`, slot `preview_3`, full six-shard preview.

| Metric | Baseline | Preserve artifacts |
| --- | --- | --- |
| Whole run (created to finished) | 600s | 391s |
| Pre-test reset | 101.0s | 8.1s |
| Post-test reset | 111.3s | 18.2s |
| Repos swept before/after | 546 / 555; both hit deadline | 0 / 0; preserve flag logged |
| Outcome | Green; one absorbed Vitest retry | Green; no reported retries |

Baseline retry: `a stream survives being evicted after journaling oversized events` received `stream-unavailable: Internal error in Durable Object storage caused object to be reset` (reference `fq5ian0vc2nhrjb6s7sudejb`). This predates the implementation.

Changed run: [Depot run b173474nsp](https://depot.dev/orgs/0p91s0lz49/workflows/br8c57ggpd), head `83eee64d209affdc8abb20b0d634c2e21cdeb2c3`, same `preview_3` slot, same six apps and six Playwright shards.

The two resets saved **186.0s**. The whole run saved **209s**, but that is a single before/after pair, not an isolated benchmark: OS deployment also fell from 86.2s to 50.0s, readiness was 112s/111s, and install/test timings varied. The baseline was a manual all-app dispatch; the changed run was an automatic PR run (Dummy Petshop reused its unchanged deployment). No test selection changed. OS E2E still exceeded its existing 100s budget at 136.6s; that warning is separate from cleanup.

Resource evidence after the changed run:

- OS tombstoned nine non-container DO classes; Streams tombstoned its Stream DO. Container handling is unchanged. The API 100403 messages select the existing exports-tombstone fallback, which completed successfully.
- Auth D1 was wiped; cleanup deleted 572 KV keys. A separate project-directory query fell from 285 `project:` keys during tests to zero after cleanup.
- All 200 repositories in the before-cleanup sample remained in the after-cleanup sample; all were created during this test run. This is a sample, not the namespace's total repository count.
- Both reset logs explicitly report `preserved (--preserve-artifacts)`, with no Artifacts list/delete pass. R2 lifecycle rules still apply.
- All preview jobs, unit tests, lint/typecheck and autofix checks passed. Existing expected-fail/skip policies were unchanged; no new quarantines.

## Implementation log

- Created from `origin/main` at `17e937695b` after PR #2659 merged. Previous lifetime experiments are excluded.
- Historical comparison: the recorded unsharded run spent 4.5s/9.2s on OS reset plus D1/KV and 93.6s/92.5s in artifact cleanup windows before/after tests. These intervals are not isolated DO measurements.

- Independent review caught interrupted-preparation cleanup: the slot can be leased before app records exist. Close cleanup now includes both data owners, while filtering obsolete app names. No runtime/core changes.
- Merged #2658's shared main/PR preview targets; 216 preview tests pass. CI exposed a pre-existing Kit/Knip race: typecheck generates the Wrangler config in parallel with Knip. Declaring Kit's Worker entrypoint makes the check independent of that generated file (reproduced without the file before the fix).

Session: `01a0ab0a-7542-7223-8003-e996bc9bce72`.
