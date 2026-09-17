# Near-instant preview dependency setup

Status: complete for the requested install experiment. Exact image matches skip pnpm; 27/27 real preview jobs finished dependency setup in under one second. The normal image is refreshed and downstream steps restored. Changed-input installs and unrelated test failures remain outside scope.

User ask: measure how often preview `pnpm install` takes around 45 seconds, and make exact dependency matches near-instant using the baked Depot image. Test through repeated real PR pushes. Ignore/cancel downstream preview work during experiments. pnpm 12, separate Depot images and nubjs are available options, not required migrations.

Assumptions: scope is `.depot/workflows/preview.yml` and its reusable `preview-run.yml`. Dependency changes may still install normally. An exact reuse check must include workspace manifests/configuration, patches, the runtime and the installed tree, not merely the lockfile. Keep existing images usable by other workflows; build experiments under a separate tag. No merge requested.

- [x] Measure historical preview install steps. *419 completed installs; 247 verified exact lockfile matches, compared through Git blob hashes.*
- [x] Reproduce slow setup. *Normal push `296bd08b7`: identical source/installed lockfiles, 58.7s first install and 6.4s repeat.*
- [x] Implement and test exact reuse. *Node-only verifier in `scripts/depot-ci/dependencies.mjs`; 11 integration tests exercise real pnpm.*
- [x] Build an isolated image and test normal pushes. *Three pushes, nine preview jobs each; traced shell duration 58–985ms, median 782ms. All runtime smoke checks passed.*
- [x] Record evidence and limitations. *PR #2696 and `docs/depot-ci.md`; normal image published by Depot workflow `pmt7ddhbh1`.*

## Implementation log

- 2026-09-17: started from origin/main (`8f8ff8d695`), branch `ci-exact-deps`. Current image contains node_modules and a pnpm store; every preview job still executes pnpm 10.24.0 install. The image rebuilds on main manifest changes and weekly.
- Initial sample: 61 completed dependency installs across seven recent preview workflows; median 36.5s, maximum 53.9s. Many report “Already up to date”. Ranked explanations: (1) pnpm still scans/rewrites the tree; (2) cold snapshot filesystem reads magnify that overhead; (3) stale image input mismatches explain some, but not all, installs. First normal-push experiment compares initial install to a repeat on the same sandbox. Downstream steps temporarily omitted as requested.
- Corrected historical sample (2026-09-16 12:14 through 2026-09-17 05:48 UTC): 419 completed installs, 46 previews; two incomplete installs excluded. 120/419 (28.6%) took >=45s; median 38.7s, p95 68.6s. Git tree comparison confirms 247 exact baked/checkout lock matches: 71/247 (28.7%) >=45s, median 39.1s, p95 72.0s, maximum 106.1s. The initial tally missed pnpm’s `1m ...s` format; corrected before the final report. “Already up to date” alone was not used to establish exact matches.
- Normal push `296bd08b7`, Depot workflow `wv4s3x69lb`: all nine initial/repeated install pairs succeeded. Prepare took 58.7s then 6.4s with identical source/installed lock hashes; other first installs took 6.3–8.4s. Repeats took 6.3–6.4s. This supports costly reads in fresh snapshots plus a remaining pnpm reconciliation cost.
- Nine integration tests use real pnpm and local dependencies: exact reuse, changed lock/config/patch/local sources, stale manifests, removed links, unstamped images and lifecycle scripts. Scripts typecheck and focused lint pass.
- Isolated image build uses `depot ci run` because dispatch validates new input names against main. It publishes `ci-exact-deps-experiment` and a `deps-<fingerprint>` alias; the shared image remained untouched during these early experiments.
- First real-push reuse proof (`75ac83ea1`, workflow `b4vjp6m67r`): 9/9 matching jobs skipped pnpm; verifier 517–905ms. Each job subsequently ran tsx, Playwright, oxlint and an esbuild transform successfully. This is an install-only experiment; it is not a claim that downstream deployment/e2e ran.
- Second normal push (`3aae0a77d8`, workflow `3rk9fmcf0h`): 9/9 hits, verifier 21–946ms. Complete traced install shell durations across the first two rounds: 58–985ms (18 jobs). Runtime tool smoke checks passed in every job.
- Added and first observed a failing binary-input regression, then fixed fingerprinting to preserve raw bytes. Added an environment-change miss test. All 11 dependency integration tests pass. Full repository typecheck, lint and knip pass.

- Third normal push (`fe82a9497`, [workflow `gw3t5fc5p2`](https://depot.dev/orgs/0p91s0lz49/workflows/gw3t5fc5p2)): 9/9 hits against the final verifier; 552–938ms inside the verifier. Across all three pushes: 27/27 successful complete shell steps, 58–985ms, median 782ms.
- Published the validated recipe to the normal image tag (`node24-pnpm10-worktree`) and `deps-9a7e762691fb69aed32a6189bde85a73a8af71003b8ec36ed25bda13e33c60e5`. [Build `pmt7ddhbh1`](https://depot.dev/orgs/0p91s0lz49/workflows/pmt7ddhbh1) produced digest `sha256:c565cb5f7acb7d74c6e05e36f640435262985a4514b4ec2b9389abc48d5740f2`.
- Restored every downstream preview step and the normal image tag. Full scripts suite: 371 tests pass. `pnpm install`, typecheck, lint, knip and format pass. Root `pnpm test` encounters the pre-existing expired-skip policy failure at `specs/repo-ide-jsonc.spec.ts:19`; no skip was renewed or hidden.

## Evidence and scope

Baseline data came from Depot `ListWorkflows` (Preview/pull_request), `GetWorkflow`, and each attempt’s `GetJobAttemptLogs`. Parse pnpm’s completed duration with seconds **and minutes**. Compare the checkout log’s baked commit and the workflow’s checked-out head using `git ls-tree <sha> -- pnpm-lock.yaml`. Repeated attempts remain separate install observations. This is a recent sample, not a lifetime failure rate.

The [106.1s exact-match example](https://depot.dev/orgs/0p91s0lz49/workflows/g4kr53d1n2?job=7wfxf700xg&attempt=wl62r3w7jl) says “Already up to date”. The [controlled baseline](https://depot.dev/orgs/0p91s0lz49/workflows/wv4s3x69lb), [reuse round one](https://depot.dev/orgs/0p91s0lz49/workflows/b4vjp6m67r) and [round two](https://depot.dev/orgs/0p91s0lz49/workflows/3rk9fmcf0h) preserve the raw execution logs.

The no-op guarantee is structural: a matching receipt never invokes pnpm. VM scheduling and filesystem latency cannot have a 100% wall-clock guarantee. A matching previous PR lockfile is insufficient if the selected baked image has different inputs; those misses deliberately retain the existing install. The receipt trusts the pristine snapshot, with metadata/directory sanity checks rather than a scan of every installed file. The fingerprint tag is for identity; selecting the normal rolling tag avoids another job on the critical path.

Depot’s [custom-image docs](https://depot.dev/docs/ci/how-to-guides/custom-images) confirm filesystem snapshots and `clean: false`; its [CLI docs](https://depot.dev/docs/cli/reference/depot-ci) document local-patch submission. pnpm 12/nubjs were unnecessary: matching jobs do not start a package manager.
