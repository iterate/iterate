---
status: in-progress
size: large
---

# Flake dashboard: stream, processor, CI wiring, transitions

**Status summary:** All the code landed in PR #2562 alongside the `createFlake` wrapper (scope expanded on request so the whole system reviews as one piece). What remains is post-merge ops (Doppler secrets, prd config deploy) and the agent that acts on transition proposals.

Design decisions were grilled and approved 2026-09-01; see `tasks/create-flake.md` for the full decision list and prior-art research. The wrapper writes one JSONL line per flake-test outcome to `FLAKE_RECORD_DIR` (schema: `FlakeRecord`, mirrored as a zod schema in the contract). This system makes the data go somewhere and come back as decisions.

## In PR #2562

- [x] Event contract: `flakes/created` (birth), `flakes/run-recorded` (CI-appended, idempotency key run+lane+attempt), `flakes/transition-proposed`, `flakes/dashboard-render-settled` _(packages/iterate/src/starter-apps/flake-dashboard/contract.ts)_
- [x] `FlakeDashboardProcessor` on the `/flakes` stream: folds per-test stats (counts, lanes, last flake, default-branch streaks), owns the issue render as a durable obligation (settled events + runtime attempt guard, AI-linter pattern), and appends `transition-proposed` when a streak crosses a threshold — once per streak, keyed on the streak's start _(processor.ts; harness tests incl. refold-after-crash in flake-dashboard.test.ts)_
- [x] GitHub issue render: marker-authoritative get-or-create + body overwrite; single writer by construction; connection resolved from the project's repo links matching the birth config's owner/repo _(render.ts, injected into the processor so tests use a fake)_
- [x] Starter app wiring: worker DO + dynamic worker ref + tsdown/build-manifest entries + package exports (source AND `publishConfig.exports` + `tsconfig.sdk.json` — the packed tarball uses the publish map, and previews install the PR's own pkg.pr.new build via `iterateRepoPkgRef` sha-pinning, so missing publish entries brick preview project creation); mounted in `configs/default/worker.ts`
- [x] CI reporter: `packages/iterate/src/scripts/report-flake-records.ts` — reads `FLAKE_RECORD_DIR`, validates lines, appends birth + one `run-recorded` per run+lane via `connectItx` with the project API key. Every failure path logs and exits 0 behind a 20s deadline
- [x] Unit test lane wired: `FLAKE_RECORD_DIR` set in `.depot/workflows/test.yml` + always-run "Report flake records" post-step (no-ops until secrets exist)

## Post-merge ops

- [x] ~~Add `FLAKE_REPORT_*` secrets to `_shared/prd` Doppler~~ _(done 2026-09-02, then superseded the same day: `tasks/flake-webhook-ingestion.md` replaces the push lane with webhook-pull ingestion, so these secrets should be UNSET once that merges — and consider rotating the project API key, a fragment of which echoed into a local session transcript during setup)_
- [x] Mount the app on the live iterate project _(done 2026-09-02: three `itx.repo.edit` commits to the project's config repo worker.ts)_
- [ ] Confirm first dashboard render on a real CI run (sentinel should appear with a ~10% flake rate as data accumulates)

## Follow-ups

- [ ] Wire the remaining lanes (preview e2e in `cloudflare-previews.yml`, playwright specs) with the same env + post-step recipe
- [ ] The transition-acting agent: consume `transition-proposed`, apply the file-edit guard (streak only trustworthy if the test file didn't change during it — the fold can't see git history), and open the unwrap / switch-to-`failing` PR via the GitHub capability
- [ ] Monthly sentinel roll: when a sentinel's month ends the unwrap proposal fires — roll it forward instead of merging the unwrap
