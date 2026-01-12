# Deprecate and Remove apps/os

This task tracks the deprecation and eventual removal of `apps/os` in favor of `apps/os2`.

## Status

- [x] Mark apps/os as deprecated in documentation
- [x] Add apps/os to .cursorignore and .vscodeignore
- [x] Update vibe-rules to be generic (not os-specific)
- [x] Update repository-structure.md to reflect os2 as primary
- [ ] Delete apps/os/e2e tests (no longer needed)
- [ ] Migrate any remaining unique features from os to os2
- [ ] Remove apps/os workspace paths from pnpm-workspace.yaml
- [ ] Delete apps/os directory entirely

## CI/CD Workflows to Update

All these workflows are apps/os specific and need to be updated or removed:

- [ ] `.github/workflows/e2e.yml` - Runs apps/os Playwright e2e tests (daily cron + post-deploy). Either delete or update for os2.
- [ ] `.github/workflows/eval.yml` - Runs LLM evals in apps/os. Either delete or update for os2.
- [ ] `.github/workflows/deploy.yml` - The `deploy-os` job deploys apps/os. Need to add `deploy-os2` or replace.
- [ ] `.github/workflows/ci.yml` - Changelog tracks `apps/os` changes separately. Update to track os2.
- [ ] Remove the daily e2e cron schedule (runs at 9am, unnecessary for deprecated app)

## Items Discovered During Cleanup

- `apps/os/vite.config.ts` and `apps/os/backend/utils/utils.ts` may have ngrok references that will break when packages/ngrok is removed (but apps/os is deprecated anyway)
- `packages/sdk/` is also deprecated and ignored
- Root `package.json` still has many os-specific scripts (iterate, os, e2e, eval, vitest, db:\* commands) - these can be migrated to os2 equivalents when ready

## Migration Checklist

Before deleting apps/os, ensure:

1. All production deployments are on apps/os2
2. Any os-specific features have been ported to os2
3. CI/CD pipelines updated to use os2
4. Documentation updated to remove os references
