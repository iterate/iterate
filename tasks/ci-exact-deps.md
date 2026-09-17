# Near-instant preview dependency setup

Status: investigation and experiment. Worktree created; historical timings, cause, implementation and normal-CI proof remain.

User ask: measure how often preview `pnpm install` takes around 45 seconds, and make exact dependency matches near-instant using the baked Depot image. Test through repeated real PR pushes. Ignore/cancel downstream preview work during experiments. pnpm 12, separate Depot images and nubjs are available options, not required migrations.

Assumptions: scope is `.depot/workflows/preview.yml` and its reusable `preview-run.yml`. Dependency changes may still install normally. An exact reuse check must include workspace manifests/configuration, patches, the runtime and the installed tree, not merely the lockfile. Keep existing images usable by other workflows; build experiments under a separate tag. No merge requested.

- [ ] Measure historical preview install steps, separating changed inputs from unchanged inputs where evidence permits.
- [ ] Reproduce slow setup through Depot and record ranked, falsifiable explanations.
- [ ] Implement and test safe reuse for an exact baked dependency match.
- [ ] Build an isolated image and prove behavior with several normal PR pushes.
- [ ] Record timings, correctness checks, limitations and deployment instructions in the PR.

## Implementation log

- 2026-09-17: started from origin/main (`8f8ff8d695`), branch `ci-exact-deps`. Current image contains node_modules and a pnpm store; every preview job still executes pnpm 10.24.0 install. The image rebuilds on main manifest changes and weekly.
- Initial sample: 61 completed dependency installs across seven recent preview workflows; median 36.5s, maximum 53.9s. Many report “Already up to date”. Ranked explanations: (1) pnpm still scans/rewrites the tree; (2) cold snapshot filesystem reads magnify that overhead; (3) stale image input mismatches explain some, but not all, installs. First normal-push experiment compares initial install to a repeat on the same sandbox. Downstream steps temporarily omitted as requested.
- Historical sample (2026-09-16 12:14 through 2026-09-17 05:48 UTC): 382 completed installs, 46 previews; 39 unfinished installs excluded. 83/382 (21.7%) took >=45s; median 38.05s, p95 54.0s. Git tree comparison confirms 221 exact baked/checkout lock matches: 45/221 (20.4%) >=45s, median 37.9s, p95 51.4s, maximum 58.9s. “Already up to date” alone was not used to establish exact matches.
- Normal push `296bd08b7`, Depot workflow `wv4s3x69lb`: all nine initial/repeated install pairs succeeded. Prepare took 58.7s then 6.4s with identical source/installed lock hashes; other first installs took 6.3–8.4s. Repeats took 6.3–6.4s. This supports costly reads in fresh snapshots plus a remaining pnpm reconciliation cost.
- Nine integration tests use real pnpm and local dependencies: exact reuse, changed lock/config/patch/local sources, stale manifests, removed links, unstamped images and lifecycle scripts. Scripts typecheck and focused lint pass.
- Isolated image build uses `depot ci run` because dispatch validates new input names against main. It publishes `ci-exact-deps-experiment` and a `deps-<fingerprint>` alias; no shared image changed by this experiment.
- First real-push reuse proof (`75ac83ea1`, workflow `b4vjp6m67r`): 9/9 matching jobs skipped pnpm; verifier 517–905ms. Each job subsequently ran tsx, Playwright, oxlint and an esbuild transform successfully. This is an install-only experiment; it is not a claim that downstream deployment/e2e ran.
