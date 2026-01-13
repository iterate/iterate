---
state: pending
priority: medium
size: small
---

# Restore E2E Workflow for apps/os

The E2E tests GitHub Actions workflow was deleted when apps/os was removed.

## E2E Workflow

The E2E workflow ran Playwright tests against deployed apps/os instances.

### Key Features

- **Trigger**: Called from CI workflow after deploy, plus daily cron at 9am
- **Inputs**: `worker_url` (deployment URL) and `stage` (doppler config)
- **Location**: `apps/os/e2e-ignoreme` for test files
- **Command**: `doppler run --config <stage> -- pnpm os e2e`
- **Retries**: 3 attempts with 30s wait between
- **Artifacts**: Uploaded e2e logs on failure

### File Location

`.github/ts-workflows/workflows/e2e.ts` - deleted

### Integration Points

In CI workflow (`.github/ts-workflows/workflows/ci.ts`):

- Added as job that depends on `deploy` and `variables`
- Only runs for `prd` or `stg` stages
- Received `worker_url` from deploy job output
- Slack failure handler checked for e2e failures and linked artifacts

## To Restore

1. Restore the deleted file from git:

   ```bash
   git show HEAD:.github/ts-workflows/workflows/e2e.ts > .github/ts-workflows/workflows/e2e.ts
   ```

2. Add e2e job back to `.github/ts-workflows/workflows/ci.ts`:

   ```typescript
   e2e: {
     if: "needs.variables.outputs.stage == 'prd' || needs.variables.outputs.stage == 'stg'",
     uses: "./.github/workflows/e2e.yml",
     secrets: "inherit",
     needs: ["variables", "deploy"],
     with: {
       worker_url: "${{ needs.deploy.outputs.worker_url || 'some_garbage' }}",
       stage: "${{ needs.variables.outputs.stage }}",
     },
   },
   ```

3. Add e2e to slack_failure dependencies:

   ```typescript
   slack_failure: {
     needs: ["variables", "deploy", "e2e", "release"], // add "e2e" back
     // ...
   }
   ```

4. Add e2e artifact link back to slack notification:

   ```typescript
   if (failedJobs.includes("e2e")) {
     message +=
       " <https://artifact.ci/artifact/view/${{ github.repository }}/run/${{ github.run_id }}.${{ github.run_attempt }}/e2e-logs|View Artifacts>.";
   }
   ```

5. Run `pnpm generate` in `.github/ts-workflows` to regenerate YAML files

## Notes

- E2E tests require `apps/os` to exist with test files in `apps/os/e2e-ignoreme`
- Requires the "os" Doppler project with dev/stg/prd configs
- Requires Playwright browsers to be installed
