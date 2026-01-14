---
state: pending
priority: medium
size: small
---

# Restore Spec Workflow for apps/os

The spec tests GitHub Actions workflow was deleted when apps/os was removed.

## Spec Workflow

The spec workflow ran Playwright tests against deployed apps/os instances.

### Key Features

- **Trigger**: Called from CI workflow after deploy, plus daily cron at 9am
- **Inputs**: `worker_url` (deployment URL) and `stage` (doppler config)
- **Location**: `apps/os/spec-ignoreme` for test files
- **Command**: `doppler run --config <stage> -- pnpm os spec`
- **Retries**: 3 attempts with 30s wait between
- **Artifacts**: Uploaded spec logs on failure

### File Location

`.github/ts-workflows/workflows/spec.ts` - deleted

### Integration Points

In CI workflow (`.github/ts-workflows/workflows/ci.ts`):

- Added as job that depends on `deploy` and `variables`
- Only runs for `prd` or `stg` stages
- Received `worker_url` from deploy job output
- Slack failure handler checked for spec failures and linked artifacts

## To Restore

1. Restore the deleted file from git:

   ```bash
   git show HEAD:.github/ts-workflows/workflows/spec.ts > .github/ts-workflows/workflows/spec.ts
   ```

2. Add spec job back to `.github/ts-workflows/workflows/ci.ts`:

   ```typescript
   spec: {
     if: "needs.variables.outputs.stage == 'prd' || needs.variables.outputs.stage == 'stg'",
     uses: "./.github/workflows/spec.yml",
     secrets: "inherit",
     needs: ["variables", "deploy"],
     with: {
       worker_url: "${{ needs.deploy.outputs.worker_url || 'some_garbage' }}",
       stage: "${{ needs.variables.outputs.stage }}",
     },
   },
   ```

3. Add spec to slack_failure dependencies:

   ```typescript
   slack_failure: {
     needs: ["variables", "deploy", "spec", "release"], // add "spec" back
     // ...
   }
   ```

4. Add spec artifact link back to slack notification:

   ```typescript
   if (failedJobs.includes("spec")) {
     message +=
       " <https://artifact.ci/artifact/view/${{ github.repository }}/run/${{ github.run_id }}.${{ github.run_attempt }}/spec-logs|View Artifacts>.";
   }
   ```

5. Run `pnpm generate` in `.github/ts-workflows` to regenerate YAML files

## Notes

- Spec tests require `apps/os` to exist with test files in `apps/os/spec-ignoreme`
- Requires the "os" Doppler project with dev/stg/prd configs
- Requires Playwright browsers to be installed
