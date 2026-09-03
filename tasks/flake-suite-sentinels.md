---
status: in-progress
size: small
---

# Per-suite flake sentinels: specs + preview e2e

**Status summary:** Extends the flake pipeline's self-proof to the suites most likely to actually flake. Each suite gets its own deliberately ~10%-flaky, month-gated sentinel (distinct test names → distinct dashboard rows, so a suite whose sentinel reads 0% has broken plumbing), plus the two-line CI wiring that makes its records flow: `FLAKE_RECORD_DIR` on the lane + a `flake-records-<suite>` artifact upload. Ingestion is already suite-agnostic (#2582) — no server changes.

## Checklist

- [x] `specs/flake-sentinel.spec.ts` — playwright sentinel _(verified through the real spec runner: expected-fail registration accepted, record line written; cosmetic wart: playwright shows the wrapper's file as the test location)_
- [x] `apps/os/e2e/vitest/flake-sentinel.e2e.test.ts` — preview e2e sentinel _(verified under the e2e vitest config; it flaked on the verification run and stayed green, recording the flake-fail)_
- [x] preview lanes: `FLAKE_RECORD_DIR` per lane in `scripts/preview/preview.ts` (playwright → `test-results/flake-records/specs`, vitest e2e → `.../preview-e2e`), guard tests updated
- [x] `cloudflare-previews.yml`: `flake-records-specs` + `flake-records-preview-e2e` artifact uploads (`if: always()`, `if-no-files-found: ignore`, `overwrite: true`)
- [x] docs/testing.md: note the per-suite sentinel convention + the stance that `createFlake` replaces retries only for tests that opted in (unwrapped specs keep playwright retries)
- [x] createFlake pins per-test `retry: 0` on vitest _(surfaced by the first real preview run: the e2e suite's `retry: {count:1, delay:5000}` re-ran the sentinel after the wrapper's green throw — vitest retry fires before the `.fails` inversion — recording every green outcome twice; fixture child now runs with suite retry to pin it)_
- [x] ingestion: drop the Depot run-status filter _(also surfaced live: Depot's per-sha run status settles only after the LAST check completes, and that check's webhook beats the flip, so `status: ["finished","failed"]` in ListRuns permanently skipped the last-completing check's artifacts — always the slow preview check, i.e. exactly these two new suites)_

## Post-merge

- [ ] Confirm both new rows appear on the Flake dashboard issue after a preview run on main

## Implementation log

- Preview slot 17 was damaged (missing container classes, upstream Cloudflare gap); repaired by deleting the `os-preview-17` worker via the Cloudflare API (no queue consumers were attached) and letting the bootstrap recreate it on the next deploy. No dedicated repair script exists — `erase-data` deliberately leaves workers in place.
- Run rs7dwp1l27 attempt 3 proved the wiring end to end: both sentinels ran, recorded, and uploaded (`flake-records-specs` 276B, `flake-records-preview-e2e` 286B); the job's only real failure was an unrelated mobile chat-photos flake.
- Those two artifacts were then never ingested — replaying the deployed ingestion steps locally (ListRuns/ListArtifacts/download/unzip/parse) all succeeded, which isolated the run-status race fixed above.
