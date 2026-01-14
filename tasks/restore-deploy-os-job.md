---
state: pending
priority: medium
size: small
---

# Restore Deploy-OS Job in CI/CD

The `deploy-os` job was removed from `.github/ts-workflows/workflows/deploy.ts` when apps/os was deleted.

## What Was Removed

The entire `deploy-os` job in the deploy workflow, which:

- Deployed apps/os to Cloudflare Workers using Alchemy
- Ran with 15 minute timeout
- Enabled QEMU for multi-platform Docker builds
- Output `worker_url` that was consumed by spec tests
- Ran `pnpm run deploy` in `apps/os` directory

## Original Job Definition

```typescript
"deploy-os": {
  name: "deploy-os ${{ inputs.stage }}",
  "timeout-minutes": 15,
  ...utils.runsOn,
  outputs: {
    worker_url: "${{ steps.alchemy_deploy.outputs.worker_url }}",
  },
  steps: [
    ...utils.setupRepo,
    ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
    {
      name: "Enable QEMU",
      uses: "docker/setup-qemu-action@v3",
      with: {
        platforms: "all",
      },
    },
    {
      id: "alchemy_deploy",
      name: "Deploy using Alchemy",
      env: {
        DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
        STAGE: "${{ inputs.stage }}",
      },
      run: "pnpm run deploy",
      "working-directory": "apps/os",
    },
  ],
},
```

## Impact

The workflow output changed:

- **Before**: `worker_url: "${{ jobs.deploy-os.outputs.worker_url }}"`
- **After**: `worker_url: ""` (empty string)

This breaks the spec workflow which depends on the worker_url output.

## Docker/QEMU Context

The QEMU setup was needed because:

- apps/os used Docker to build sandbox containers
- The sandbox Dockerfile extended `cloudflare/sandbox:0.3.2`
- CI needed cross-platform build capability for the sandbox

## To Restore

1. Add the `deploy-os` job back to `.github/ts-workflows/workflows/deploy.ts`:
   - Place it before `deploy-website` in the jobs object
   - Keep all steps including QEMU setup
   - Ensure outputs are defined

2. Update the workflow outputs to reference the restored job:

   ```typescript
   outputs: {
     worker_url: {
       description: "The URL of the deployed worker.",
       value: "${{ jobs.deploy-os.outputs.worker_url }}",
     },
   },
   ```

3. Run `pnpm generate` in `.github/ts-workflows` to regenerate the YAML

## Dependencies

- Requires `apps/os` directory with `alchemy.run.ts` configuration
- Requires Doppler "os" project with stage configs (dev/stg/prd)
- Requires Docker for sandbox builds
- Requires Alchemy CLI for deployment
