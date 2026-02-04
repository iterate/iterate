import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox Docker image locally (no registry push).
 *
 * We don't push to a registry because pulling from ghcr.io to Daytona is slow
 * (10+ mins). For local Docker tests, we just --load the image. Daytona builds
 * use their native --dockerfile approach instead (see build-snapshot.ts).
 *
 * depot.dev's registry might help if we need registry-based workflows later.
 */
export default workflow({
  name: "Build Sandbox Image",
  permissions: {
    contents: "read",
  },
  on: {
    workflow_call: {
      outputs: {
        image_ref: {
          description: "Local sandbox image ref (sha tag)",
          value: "${{ jobs.build.outputs.image_ref }}",
        },
      },
    },
  },
  jobs: {
    build: {
      ...utils.runsOn,
      outputs: {
        image_ref: "${{ steps.output.outputs.image_ref }}",
      },
      steps: [
        ...utils.setupRepo,
        {
          name: "Install Doppler CLI",
          uses: "dopplerhq/cli-action@v2",
        },
        uses("docker/setup-buildx-action@v3"),
        {
          name: "Build sandbox image (local only, no push)",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "ghcr.io/iterate/sandbox:ci",
          },
          run: "pnpm os docker:build",
        },
        {
          id: "output",
          name: "Export image ref",
          run: "echo image_ref=ghcr.io/iterate/sandbox:sha-${{ github.sha }} >> $GITHUB_OUTPUT",
        },
      ],
    },
  },
});
