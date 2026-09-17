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
