import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Reusable workflow to build a Daytona snapshot.
 * Call this from other workflows to avoid building the same snapshot multiple times.
 *
 * Usage:
 *   build-snapshot:
 *     uses: ./.github/workflows/build-snapshot.yml
 *     secrets: inherit
 *     with:
 *       doppler_config: dev  # or prd
 *
 * Then depend on it and use the output:
 *   my-job:
 *     needs: [build-snapshot]
 *     env:
 *       DAYTONA_SNAPSHOT_NAME: ${{ needs.build-snapshot.outputs.snapshot_name }}
 */
export default workflow({
  name: "Build Daytona Snapshot",
  on: {
    workflow_call: {
      inputs: {
        doppler_config: {
          description: "Doppler config to use (dev, prd, etc.)",
          required: true,
          type: "string",
        },
      },
      outputs: {
        snapshot_name: {
          description: "The name of the built snapshot (iterate-sandbox-{commitSha})",
          value: "${{ jobs.build.outputs.snapshot_name }}",
        },
      },
    },
  },
  jobs: {
    build: {
      ...utils.runsOn,
      outputs: {
        snapshot_name: "${{ steps.build.outputs.snapshot_name }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.doppler_config }}" }),
        {
          id: "build",
          name: "Build and push Daytona snapshot",
          env: {
            DAYTONA_API_KEY: "${{ secrets.DAYTONA_API_KEY }}",
            SANDBOX_ITERATE_REPO_REF: "${{ github.sha }}",
          },
          run: [
            "pnpm os daytona:build",
            'echo "snapshot_name=iterate-sandbox-${{ github.sha }}" >> $GITHUB_OUTPUT',
          ].join("\n"),
        },
      ],
    },
  },
});
