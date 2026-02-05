import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox Docker image.
 */
export default workflow({
  name: "Build Sandbox Image",
  permissions: {
    contents: "read",
    "id-token": "write", // Required for Depot OIDC authentication
  },
  on: {
    workflow_call: {
      inputs: {
        docker_platform: {
          description: "Build platform for docker buildx (e.g. linux/amd64).",
          required: false,
          type: "string",
          default: "linux/amd64",
        },
      },
      outputs: {
        image_ref: {
          description: "Local sandbox image ref",
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
        ...utils.setupDoppler({ config: "dev" }),
        ...utils.setupDepot,
        {
          name: "Build sandbox image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "iterate-sandbox:ci",
            SANDBOX_BUILD_PLATFORM: "${{ inputs.docker_platform }}",
          },
          run: "pnpm os docker:build",
        },
        {
          id: "output",
          name: "Export image ref",
          run: 'echo "image_ref=iterate-sandbox:ci" >> $GITHUB_OUTPUT',
        },
      ],
    },
  },
});
