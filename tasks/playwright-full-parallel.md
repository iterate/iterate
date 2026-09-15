---
status: in-progress
size: large
---

# Run the preview Playwright catalogue fully in parallel

Status: implementation is in place with shared deployment/readiness, six browser jobs, strict result collection and capacity checks. Repository checks pass and a real six-shard run has exercised report merging and failure propagation. One browser click failure remains under investigation; final green validation and review remain.

The user wants fixed shard/worker counts with `shards * workers >= num_tests`, not an adaptive scheduling algorithm. Use six independent CI runners with sixteen Playwright workers each (96 slots). Keep local runs at one worker.

- [x] Run six Playwright shards after one successful deployment/readiness barrier, alongside the other preview tests. *Defined in cloudflare-preview-sharded.yml; live validation is underway.*
- [ ] Preserve one preview lifecycle owner across deployment, all tests, result collection, and cleanup; cancellation/new pushes must not erase a live sibling shard.
- [x] Pin every shard to the same checked-out SHA, preview slot, and deployed Worker versions. *ciPrepare/ciTest validate the plan against checkout, workflow attempt and live lease.*
- [ ] Preserve individual-test retries, traces, merged HTML/JSON reports, flake records, and canonical telemetry. Missing or failed shards must fail the preview check.
- [x] Add a check that discovers the real CI catalogue and fails if the fixed capacity no longer covers it (including per-shard capacity). *Discovered 92 tests; shard counts are 16,16,15,15,15,15. An intentionally undersized real CLI run fails.*
- [ ] Exercise failure propagation/report collection, run repository checks, and validate a real sharded preview on Depot.
- [ ] Address CI/review feedback, update docs and PR, then move this task to complete.

## Implementation notes

- Base: origin/main at 611c3769b (includes PRs #2653 and #2656).
- Worktree: ../worktrees/iterate/playwright-full-parallel; branch: codex/playwright-full-parallel.
- Assumption: "fully parallel" means enough scheduler capacity for every independent test, not simultaneous browser launch to the millisecond or removal of deliberate ordering inside a test.
- Initial measurement: `CI=true APP_CONFIG_BASE_URL=https://os-preview-1.iterate.com PLAYWRIGHT_PREVIEW_SLOW_FIRST=1 pnpm spec --list` reports 92 tests in 42 files.
- Depot supports job matrices and reusable workflows. Parallel steps share a host, so they do not provide the extra machines requested here.

- Local validation: full `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm knip`, and `pnpm format:check` pass. Focused tests additionally cover missing/foreign/failed receipts and shared readiness preparation.
- A real six-process Playwright report exercise preserves four passing tests, one retry-then-pass and one final failure, and produces HTML/JSON at the expected paths through the production merge config.
- Draft PR: https://github.com/iterate/iterate/pull/2659. Global monitor registered for task 01a09f64-ea4e-7c61-ab0a-c15eb65df3bc.
- First implementation CI proof (77e125f, run xcb07kjntm) is testing fan-out. Follow-up commits strengthen telemetry cardinality and fix merge-config-relative output paths; these require a subsequent exact-head proof.

- Run `3v0rvw0gg3` at `4cdd25e` started all six independent jobs. Each shard launched all 15–16 assigned tests together. Playwright durations were 35.7–84 seconds, including one retry; the jobs themselves started within three seconds but some spent roughly a minute longer in dependency setup. Sharding capacity does not guarantee identical test start times across runners.
- The live run exposed simultaneous semaphore lease renewal in readers; `4cdd25e` fixes this by checking ownership without reacquiring the slot. All six readers subsequently passed.
- Shard 5 failed on `seeded-apps.spec.ts:394`: the Docs Source button was visible/enabled, but its stability check exceeded the existing 1000 ms action budget. `createFlake` reports this unexpected error as “Expected to fail, but passed”; the product body did not pass. A minimal local two-tab reproduction did not fail. No timeout, skip, or allowed-flake pattern was changed.
- Keep browser runners at the original 16-core size, so adding sharding does not also halve CPU per worker. The first run's 8-core shape showed no sustained saturation, so this is preserving the baseline, not claiming to fix the click failure.
