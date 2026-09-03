---
status: in-progress
size: small
---

# Per-suite flake sentinels: specs + preview e2e

**Status summary:** Extends the flake pipeline's self-proof to the suites most likely to actually flake. Each suite gets its own deliberately ~10%-flaky, month-gated sentinel (distinct test names → distinct dashboard rows, so a suite whose sentinel reads 0% has broken plumbing), plus the two-line CI wiring that makes its records flow: `FLAKE_RECORD_DIR` on the lane + a `flake-records-<suite>` artifact upload. Ingestion is already suite-agnostic (#2582) — no server changes.

## Checklist

- [ ] `specs/flake-sentinel.spec.ts` — playwright sentinel via `createFlake` (first playwright use of the wrapper)
- [ ] `apps/os/e2e/vitest/flake-sentinel.e2e.test.ts` — preview e2e sentinel (fixture-free: no deployment needed)
- [ ] preview lanes: `FLAKE_RECORD_DIR` per lane in `scripts/preview/preview.ts` (playwright → `test-results/flake-records/specs`, vitest e2e → `.../preview-e2e`), guard tests updated
- [ ] `cloudflare-previews.yml`: `flake-records-specs` + `flake-records-preview-e2e` artifact uploads (`if: always()`, `if-no-files-found: ignore`, `overwrite: true`)
- [ ] docs/testing.md: note the per-suite sentinel convention + the stance that `createFlake` replaces retries only for tests that opted in (unwrapped specs keep playwright retries)

## Post-merge

- [ ] Confirm both new rows appear on the Flake dashboard issue after a preview run on main
