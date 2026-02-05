import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox Docker image and run local Docker tests.
 *
 * Image build runs in reusable build-docker-image workflow.
 * Tests then pull that image from Depot into local Docker daemon.
 */
export default workflow({
  name: "Local Docker Tests",
  permissions: {
    contents: "read",
    "id-token": "write", // Required for Depot OIDC authentication
  },
  on: {
    push: {
      branches: ["main"],
      paths: [
        "apps/os/sandbox/**",
        "apps/os/backend/providers/local-docker.ts",
        "apps/daemon/**",
        "packages/pidnap/**",
        ".github/workflows/local-docker-test.yml",
      ],
    },
    pull_request: {
      paths: [
        "apps/os/sandbox/**",
        "apps/os/backend/providers/local-docker.ts",
        "apps/daemon/**",
        "packages/pidnap/**",
        ".github/workflows/local-docker-test.yml",
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
        docker_platform: {
          description: "Build platform(s): linux/amd64, linux/arm64, or linux/amd64,linux/arm64",
          required: false,
          type: "string",
          default: "",
        },
        image_name: {
          description: "Docker image name/tag to use",
          required: false,
          type: "string",
          default: "iterate-sandbox:test",
        },
      },
    },
    workflow_call: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Uses workflow ref if empty.",
          required: false,
          type: "string",
          default: "",
        },
        docker_platform: {
          description: "Build platform(s): linux/amd64, linux/arm64, or linux/amd64,linux/arm64",
          required: false,
          type: "string",
          default: "",
        },
        image_name: {
          description: "Docker image name/tag to use",
          required: false,
          type: "string",
          default: "iterate-sandbox:test",
        },
      },
      outputs: {
        test_result: {
          description: "Test result (success or failure)",
          value: "${{ jobs.test.outputs.test_result }}",
        },
      },
    },
  },
  jobs: {
    "build-image": {
      uses: "./.github/workflows/build-docker-image.yml",
      with: {
        ref: "${{ inputs.ref }}",
        docker_platform: "${{ inputs.docker_platform || 'linux/amd64,linux/arm64' }}",
        image_name: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
        doppler_config: "dev",
      },
      // @ts-expect-error - secrets inherit
      secrets: "inherit",
    },
    test: {
      needs: ["build-image"],
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        test_result: "${{ steps.test.outcome }}",
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
          name: "Pull image from Depot to local Docker",
          env: {
            IMAGE_REF: "${{ needs.build-image.outputs.image_ref }}",
            TARGET_IMAGE: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
            TARGET_PLATFORM:
              "${{ (inputs.docker_platform != '' && !contains(inputs.docker_platform, ',')) && inputs.docker_platform || (github.repository_owner == 'iterate' && 'linux/arm64' || 'linux/amd64') }}",
          },
          run: [
            "set -euo pipefail",
            'project_id="${IMAGE_REF#registry.depot.dev/}"',
            'project_id="${project_id%%:*}"',
            'save_tag="${IMAGE_REF##*:}"',
            'if [ -z "$project_id" ] || [ -z "$save_tag" ]; then',
            '  echo "Invalid Depot image ref: $IMAGE_REF" >&2',
            "  exit 1",
            "fi",
            'depot pull --project "$project_id" "$save_tag" --platform "$TARGET_PLATFORM" -t "$TARGET_IMAGE"',
            'docker image inspect "$TARGET_IMAGE" > /dev/null',
          ].join("\n"),
        },
        {
          id: "test",
          name: "Run Local Docker Tests",
          env: {
            RUN_LOCAL_DOCKER_TESTS: "true",
            LOCAL_DOCKER_IMAGE_NAME: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
          },
          run: "pnpm os docker:test",
        },
        {
          name: "Upload test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "local-docker-test-logs",
            path: "apps/os/sandbox/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
