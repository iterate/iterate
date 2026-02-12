import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox image and run provider tests:
 * 1) Build image + run Docker-provider tests (single job, avoids cross-runner image pull issues)
 * 2) Run Fly-provider tests (uses Fly registry image from build)
 *
 * Daytona provider tests are handled by the separate daytona-test.yml workflow.
 */
export default workflow({
  name: "Sandbox Tests",
  permissions: {
    contents: "read",
    "id-token": "write",
  },
  on: {
    push: {
      branches: ["main"],
      paths: [
        "sandbox/**",
        "apps/daemon/**",
        "packages/pidnap/**",
        ".github/workflows/sandbox-test.yml",
      ],
    },
    pull_request: {
      paths: [
        "sandbox/**",
        "apps/daemon/**",
        "packages/pidnap/**",
        ".github/workflows/sandbox-test.yml",
      ],
    },
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Leave empty for current branch.",
          required: false,
          type: "string",
          default: "",
        },
      },
    },
  },
  jobs: {
    // Build + Docker tests in one job — avoids cross-runner Depot registry pull issues
    "build-and-docker-tests": {
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        fly_image_tag: "${{ steps.metadata.outputs.fly_image_tag }}",
      },
      steps: [
        {
          name: "Checkout code",
          ...uses("actions/checkout@v4", {
            ref: "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}",
          }),
        },
        {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@v4",
        },
        {
          name: "Setup Node",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        {
          name: "Install dependencies",
          run: "pnpm install",
        },
        ...utils.setupDoppler({ config: "dev" }),
        ...utils.setupDepot,
        {
          name: "Build sandbox image",
          env: {
            SANDBOX_BUILD_PLATFORM: "linux/amd64,linux/arm64",
            SANDBOX_UPDATE_DOPPLER: "false",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "echo '::group::Build sandbox image'",
            "time doppler run -- pnpm sandbox build",
            "echo '::endgroup::'",
          ].join("\n"),
        },
        {
          id: "metadata",
          name: "Export build metadata",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "set -euo pipefail",
            'short_sha="$(git rev-parse --short=7 HEAD)"',
            'fly_registry_app="$(doppler secrets get SANDBOX_FLY_REGISTRY_APP --plain)"',
            'image_tag="iterate-sandbox:sha-${short_sha}"',
            'fly_image_tag="registry.fly.io/${fly_registry_app}:sha-${short_sha}"',
            'echo "image_tag=${image_tag}" >> "$GITHUB_OUTPUT"',
            'echo "fly_image_tag=${fly_image_tag}" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
        {
          name: "Run Docker provider tests",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "docker",
            SANDBOX_TEST_SNAPSHOT_ID: "${{ steps.metadata.outputs.image_tag }}",
            DOCKER_DEFAULT_IMAGE: "${{ steps.metadata.outputs.image_tag }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
          },
          run: "pnpm sandbox test:docker",
        },
        {
          name: "Run Fly provider tests",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "fly",
            SANDBOX_TEST_SNAPSHOT_ID: "${{ steps.metadata.outputs.fly_image_tag }}",
            FLY_DEFAULT_IMAGE: "${{ steps.metadata.outputs.fly_image_tag }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm sandbox test test/provider-base-image.test.ts --maxWorkers=1",
        },
        {
          name: "Upload Docker test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "docker-provider-test-logs",
            path: "sandbox/test-results",
            "retention-days": 7,
          }),
        },
        {
          name: "Upload Fly test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "fly-provider-test-logs",
            path: "sandbox/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
