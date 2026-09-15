---
status: in-progress
size: large
---

# Playwright parallelisation experimentation

Status: all four worker counts measured and published, including the failed 92-worker run. Repeating 16 and 32 next; final recommendation/configuration and validation remain.

## Request and assumptions

The user wants PR #2659 renamed and used for an overnight experiment: push commits testing 16, 32, 64 and 92 Playwright workers on one runner, update an interactive trace explainer after each result, make the explainer permanent under `explainers/`, and link its branch-served URL from the PR body.

- Keep this existing worktree and branch; do not rewrite history or merge the PR.
- Hold application code, catalogue, Node/pnpm configuration, 16-core/64-GB runner, retries, timeouts, cleanup and readiness policy constant across the four configurations. Do not merge new mainline code mid-comparison.
- Restore the original one-runner `preview run` workflow so deployment, overlapping app tests, browser tests, reporting and cleanup share a machine. Increasing workers changes process concurrency, not runner core count.
- Run configurations sequentially so pushes cannot cancel an unfinished measurement or race a preview lease. Wait for cleanup and retain evidence before pushing the next configuration.
- Record whole-workflow time, setup/install/deployment/readiness/cleanup intervals, Playwright and OS Vitest durations, individual test attempts, outcome and retries, test-window CPU/memory where available, and exact commit/run/image identity where reported.
- Re-run the useful control/finalist comparison if needed to separate first-use caches and service variability from worker count. Keep failed attempts visible; do not loosen tests to manufacture green results.
- Preserve the original unsharded, six-shard and repeat-six-shard traces as historical references, with their comparability limits.
- Publish `explainers/playwright-parallelisation.html` through the existing Iterate project route using `?sha=codex/playwright-full-parallel`. Verify the actual HTTP response and browser interaction before adding the link as working.
- Leave the PR in draft with a measured recommendation and an explicit final configuration. A count larger than the core count is an experiment, not a promise of faster tests. Extra workers must not materially worsen retries or the concurrently running Vitest suite.

## Work

- [x] Rename PR and rewrite its purpose around experimentation, retaining machine-maintained preview sections. *PR #2659 renamed; fresh machine-owned preview/LOC blocks preserved.*
- [x] Restore the unsharded workflow and measure 16 workers. *Run 9p5w4fcrlz: preview success, 604.6s overall, 147.8s Playwright, 127.6s Vitest, no retries; one existing quarantined photo failure. Separate stale unit assertion corrected for the next commit.*
- [x] Push and measure 32 workers. *Run 3nc3m3tfjd: preview success, 532.6s overall, 114.1s Playwright, 124.6s Vitest, one dashboard retry and the same quarantined mobile-photo failure. All unit/lint checks pass.*
- [x] Push and measure 64 workers. *Run g5bvvvj3s3: 623.3s preview, 108.6s Playwright, 120.6s Vitest, two successful browser retries, all 88 browser bodies passed, peak memory 36.1 GB.*
- [x] Push and measure 92 workers. *Run ttxw7whjw1: preview failed, 604.4s overall; Playwright 104.5s, Vitest 119.0s; three browser retries (dashboard still failed), one Vitest retry, peak memory 45.5 GB.*
- [ ] Repeat the useful control/finalist comparison and account for failures and cache variability.
- [ ] Commit a permanent, self-contained explainer and update it with each result; retain reproducible sanitized evidence and trace-generation code.
- [x] Verify the branch-served explainer and put the working URL in the PR body. *HTTP 200 and headless browser interaction verified on the branch-serving route; link is in the PR.*
- [ ] Review the final diff, run relevant checks, address review/CI feedback, and document the recommendation.

## Evidence before this experiment

- Unsharded 16-worker reference: run `j8p7lt2bsk` / workflow `2nltk39ldj`, commit `0277de2`, 9m49s overall, 164.9s Playwright reporter interval, 134.2s OS Vitest, 9.2s pnpm install. Different PR/slot; one OS Vitest retry.
- Six shards × 16 workers: run `nv3l390bf0` / `ts361t0jxg`, commit `2996ffc9c`, 14m01s overall, longest browser shard 90.8s, OS Vitest 146.3s; zero preview test retries.
- Repeated six-shard run: `dbhs702vpk` / `gj4zmqn5kf`, empty commit `ec079ad`, 13m31s overall, longest browser shard 85.7s, OS Vitest 145.5s. Four shard installs took 8–10s, while Prepare/Apps/Finish installs still added 177.6s on the serial path. Zero preview test retries.
- Removing recorded install time alone leaves the repeat sharded workflow at ~10m33s versus ~9m40s for the historical normal run. Job handoffs/startup remain; Vitest limits the benefit of faster browser tests.
- A separate pnpm probe on the baked image took 72.4s then 7.2s on the same runner, adding no packages. Nub v0.9.2 rejects the frozen lockfile over the scoped capnweb override. Dependency-manager changes are outside this worker-count experiment.

## Implementation log

- Existing branch `codex/playwright-full-parallel`, worktree `../worktrees/iterate/playwright-full-parallel`, PR https://github.com/iterate/iterate/pull/2659.
- Owning Codex task: `01a09f64-ea4e-7c61-ab0a-c15eb65df3bc`.

- 16-worker control pushed at `1f2cf5033`; run `9p5w4fcrlz`, preview workflow `3gwspz3c34`, attempt `kv2hxdtlcz`. The general unit job exposed a stale assertion that still required the sharded caller; fixed for the next commit without changing the running preview. All 319 script tests pass locally after the correction.

- Control evidence: `explainers/playwright-parallelisation/runs/workers-16.json`; catalogue hash matches the historical 92 names. CPU during Playwright: sampled mean 5.2/16 cores, peak 12.4; peak memory 15.7 GB. The original pnpm/Depot/Nub findings and all three historical traces remain in the permanent page.

- 32-worker evidence: `runs/workers-32.json` in the permanent explainer source. First-start spread fell from 91.2s to 49.4s; median attempt duration rose from 18.2s to 21.7s. CPU sampled mean 7.6/16 cores, peak 13.7; memory peak 22.3 GB. Post-loading Navigate click timed out at 1s, then passed on retry. No application/test changes made to hide it.

- 64-worker evidence: `runs/workers-64.json`. Only 5.6s browser gain over 32 while per-attempt median rose to 31.5s. The two initial failures were 1s isEnabled checks for Navigate and ONBOARDING.md. Setup was slower independently of the test count (63.8s pnpm and slower deployment). All three worker runs began from image checkout `611c376`; an identical image digest is still not proven.

- 92-worker evidence: `runs/workers-92.json`. First starts span only 2.2s (87 active attempts), so the capacity goal was met. Mobile fixture median grew to 59.3s; local plain-HTML screenshotting also exceeded 1s once. No timeouts or tests changed to make the run pass. Next: repeat the 16-worker control and 32-worker candidate.
