import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Combined sandbox integration tests for both Docker and Daytona providers.
 *
 * Test flow:
 * 1. Build Docker image (shared by both paths)
 * 2. In parallel:
 *    a. Run Docker provider tests (fast - local container)
 *    b. Push to Daytona as snapshot → Run Daytona provider tests
 *
 * This ensures both providers are tested on every PR that touches sandbox code.
 *
 * Individual provider tests can also be run via:
 * - local-docker-test.yml (Docker only)
 * - daytona-test.yml (Daytona only)
 *
 * Environment variables for tests (see sandbox/test/helpers.ts):
 * - RUN_SANDBOX_TESTS: Enable sandbox tests (set to "true")
 * - SANDBOX_TEST_PROVIDER: "docker" | "daytona"
 * - SANDBOX_TEST_SNAPSHOT_ID: Image/snapshot to test (defaults vary by provider)
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
      paths: ["sandbox/**", "apps/daemon/**", ".github/workflows/sandbox-test.yml"],
    },
    pull_request: {
      paths: ["sandbox/**", "apps/daemon/**", ".github/workflows/sandbox-test.yml"],
    },
    workflow_dispatch: {},
  },
  jobs: {
    // ============ Docker Provider Path ============
    // Fast path: build image locally and test

    "docker-test": {
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        uses("docker/setup-buildx-action@v3"),
        {
          name: "Build Docker image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "iterate-sandbox:ci",
            SANDBOX_BUILD_PLATFORM:
              "${{ github.repository_owner == 'iterate' && 'linux/arm64' || 'linux/amd64' }}",
          },
          run: "pnpm docker:build",
        },
        {
          name: "Run Docker Provider Tests",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "docker",
            SANDBOX_TEST_SNAPSHOT_ID: "iterate-sandbox:ci",
            SANDBOX_TEST_BASE_DOCKER_IMAGE: "iterate-sandbox:ci",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
          },
          run: "pnpm sandbox test -- --maxWorkers=1",
        },
        {
          name: "Upload test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "docker-test-logs",
            path: "sandbox/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },

    // ============ Daytona Provider Path ============
    // Slower path: build image, push snapshot, then test

    "daytona-build": {
      uses: "./.github/workflows/build-daytona-snapshot.yml",
      secrets: "inherit",
      with: {
        doppler_config: "dev",
      },
    },

    "daytona-test": {
      // Must use AMD64 runner to match Daytona's requirements
      "runs-on": "ubuntu-24.04",
      needs: ["daytona-build"],
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Run Daytona Provider Tests",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "daytona",
            SANDBOX_TEST_SNAPSHOT_ID: "${{ needs.daytona-build.outputs.snapshot_name }}",
            SANDBOX_TEST_BASE_DAYTONA_SNAPSHOT: "${{ needs.daytona-build.outputs.snapshot_name }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm sandbox test -- --maxWorkers=1",
        },
        {
          name: "Upload test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "daytona-test-logs",
            path: "sandbox/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
