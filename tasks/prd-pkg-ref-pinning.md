---
status: in-progress
size: small
---

# Pin prod config-repo installs to the deployed platform commit

**Status summary:** Closes the gap that broke the iterate project's config builds for ~5h on 2026-09-02: previews sha-pin every iterate/iterate pkg.pr.new spec (`APP_CONFIG_ITERATE_REPO_PKG_REF`, set from the PR head sha), but prod installs literal `@main` — a mutable URL the dynamic worker host caches, so freshly-merged package exports weren't resolvable ("the installed 'iterate' package does not provide this entry") and every config commit silently failed to build while the stale worker kept serving.

## Change

- `deploy-os.yml` passes `PLATFORM_DEPLOY_HEAD_SHA: ${{ github.sha }}` on prd deploys.
- `apps/os/scripts/deploy.ts` sets `APP_CONFIG_ITERATE_REPO_PKG_REF` from `PREVIEW_PULL_REQUEST_HEAD_SHA` (unchanged) or, failing that, `PLATFORM_DEPLOY_HEAD_SHA` — and awaits the sha-pinned pkg.pr.new URLs the same way preview deploys already do, closing the deploy-races-publish window.
- Dev/local deploys stay unpinned (no sha build exists for uncommitted state).

Effects: prod dynamic builds install `iterate@<deployed-sha>` (immutable URL — the stale-cache failure class is structurally gone), and config workers move in lockstep with platform deploys: the pinned ref rides the dynamic-build key, so each prd deploy lazily invalidates config-worker builds on next touch.

## Checklist

- [ ] deploy.ts: ref fallback + URL await for the prd sha
- [ ] deploy-os.yml: pass the sha
- [ ] Tests where deploy behavior is pinned (deploy.test.ts / depot-workflows.test.ts as applicable)

## Post-merge

- [ ] After the next prd deploy, re-mount the flake dashboard in the live iterate config (reverted during the incident) and verify via `worker-updated` (NOT just absence of failure — check `worker-update-failed` too)
