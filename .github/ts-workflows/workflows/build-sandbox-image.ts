import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox Docker image with ghcr.io registry layer caching.
 *
 * Uses docker buildx with --cache-from/--cache-to for persistent layer caching.
 */
export default workflow({
  name: "Build Sandbox Image",
  permissions: {
    contents: "read",
    packages: "write", // for ghcr.io cache push/pull
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
        ...utils.setupDoppler({ config: "dev" }),
        ...utils.setupBuildx,
        ...utils.loginGhcr,
        {
          name: "Build sandbox image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "iterate-sandbox:ci",
            SANDBOX_BUILD_PLATFORM: "${{ inputs.docker_platform }}",
            // Use local buildx with registry cache
            DOCKER_BUILD_MODE: "local",
          },
          run: "pnpm os docker:build",
        },
        {
          id: "output",
          name: "Export image ref",
          run: [
            "GIT_SHA=$(git rev-parse HEAD)",
            'echo "image_ref=ghcr.io/iterate/sandbox-cache:sha-$GIT_SHA" >> $GITHUB_OUTPUT',
          ].join("\n"),
        },
      ],
    },
  },
});
