import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox Docker image and run local Docker tests.
 *
 * Build and test must run in the same job because tests need
 * the image in the local Docker daemon (can't share between jobs).
 *
 * Can be triggered:
 * - Automatically on push/PR to main with relevant path changes
 * - Manually via workflow_dispatch to test any commit
 * - Called by other workflows via workflow_call
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
        "sandbox/**",
        "apps/os/backend/providers/local-docker.ts",
        "apps/daemon/**",
        "packages/pidnap/**",
        ".github/workflows/local-docker-test.yml",
      ],
    },
    pull_request: {
      paths: [
        "sandbox/**",
        "apps/os/backend/providers/local-docker.ts",
        "apps/daemon/**",
        "packages/pidnap/**",
        ".github/workflows/local-docker-test.yml",
      ],
    },
    // Directly invokable for testing any commit
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Leave empty for current branch.",
          required: false,
          type: "string",
          default: "",
        },
        docker_platform: {
          description: "Build platform (linux/amd64 or linux/arm64)",
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
    // Callable by other workflows
    workflow_call: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Uses workflow ref if empty.",
          required: false,
          type: "string",
          default: "",
        },
        docker_platform: {
          description: "Build platform (linux/amd64 or linux/arm64). Auto-detects if empty.",
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
          value: "${{ jobs.build-and-test.outputs.test_result }}",
        },
      },
    },
  },
  jobs: {
    "build-and-test": {
      ...utils.runsOn,
      outputs: {
        test_result: "${{ steps.test.outcome }}",
      },
      steps: [
        // Checkout with configurable ref
        {
          name: "Checkout code",
          ...uses("actions/checkout@v4", {
            ref: "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}",
          }),
        },
        // Setup pnpm
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
        // Setup Doppler
        ...utils.setupDoppler({ config: "dev" }),
        // Setup Depot CLI
        ...utils.setupDepot,
        // Build image
        {
          name: "Build Docker image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
            // Use input platform if provided, otherwise auto-detect based on runner
            SANDBOX_BUILD_PLATFORM:
              "${{ inputs.docker_platform || (github.repository_owner == 'iterate' && 'linux/arm64' || 'linux/amd64') }}",
          },
          run: [
            "echo '::group::Build timing'",
            "time pnpm docker:build",
            "echo '::endgroup::'",
          ].join("\n"),
        },
        // Run smoke test
        {
          id: "test",
          name: "Run Local Docker Provider Base Image Test",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "docker",
            SANDBOX_TEST_SNAPSHOT_ID: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
            SANDBOX_TEST_BASE_DOCKER_IMAGE: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
          },
          run: "pnpm sandbox test test/provider-base-image.test.ts --maxWorkers=1",
        },
        // Upload test artifacts on failure
        {
          name: "Upload test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "local-docker-test-logs",
            path: "sandbox/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
