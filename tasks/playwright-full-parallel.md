---
status: in-progress
size: large
---

# Run the preview Playwright catalogue fully in parallel

Status: implementation is in place with shared deployment/readiness, six browser jobs, strict result collection and capacity checks. Local orchestration tests and type checks pass; real Depot validation and review remain.

The user wants fixed shard/worker counts with `shards * workers >= num_tests`, not an adaptive scheduling algorithm. Use six independent CI runners with sixteen Playwright workers each (96 slots). Keep local runs at one worker.

- [ ] Run six Playwright shards after one successful deployment/readiness barrier, alongside the other preview tests.
- [ ] Preserve one preview lifecycle owner across deployment, all tests, result collection, and cleanup; cancellation/new pushes must not erase a live sibling shard.
- [ ] Pin every shard to the same checked-out SHA, preview slot, and deployed Worker versions.
- [ ] Preserve individual-test retries, traces, merged HTML/JSON reports, flake records, and canonical telemetry. Missing or failed shards must fail the preview check.
- [ ] Add a check that discovers the real CI catalogue and fails if the fixed capacity no longer covers it (including per-shard capacity).
- [ ] Exercise failure propagation/report collection, run repository checks, and validate a real sharded preview on Depot.
- [ ] Address CI/review feedback, update docs and PR, then move this task to complete.

## Implementation notes

- Base: origin/main at 611c3769b (includes PRs #2653 and #2656).
- Worktree: ../worktrees/iterate/playwright-full-parallel; branch: codex/playwright-full-parallel.
- Assumption: "fully parallel" means enough scheduler capacity for every independent test, not simultaneous browser launch to the millisecond or removal of deliberate ordering inside a test.
- Initial measurement: `CI=true APP_CONFIG_BASE_URL=https://os-preview-1.iterate.com PLAYWRIGHT_PREVIEW_SLOW_FIRST=1 pnpm spec --list` reports 92 tests in 42 files.
- Depot supports job matrices and reusable workflows. Parallel steps share a host, so they do not provide the extra machines requested here.
