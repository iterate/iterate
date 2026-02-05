import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Test sandbox against Daytona provider.
 *
 * This workflow:
 * 1. Builds a Docker image and pushes it to Daytona as a snapshot
 * 2. Runs sandbox integration tests against the Daytona provider
 *
 * Triggered on PRs/pushes that touch sandbox code, or manually via workflow_dispatch.
 *
 * Environment variables for tests:
 * - RUN_SANDBOX_TESTS=true: Enable sandbox integration tests
 * - SANDBOX_TEST_PROVIDER=daytona: Use Daytona provider
 * - SANDBOX_TEST_SNAPSHOT_ID: Snapshot name from build step
 */
export default workflow({
  name: "Daytona Provider Tests",
  permissions: {
    contents: "read",
    "id-token": "write",
  },
  on: {
    push: {
      branches: ["main"],
      paths: ["sandbox/**", "apps/daemon/**", ".github/workflows/daytona-test.yml"],
    },
    pull_request: {
      paths: ["sandbox/**", "apps/daemon/**", ".github/workflows/daytona-test.yml"],
    },
    workflow_dispatch: {
      inputs: {
        snapshot_name: {
          description: "Existing snapshot name to test (skips build if provided)",
          required: false,
          type: "string",
        },
      },
    },
  },
  jobs: {
    // Build step - creates Daytona snapshot
    "build-snapshot": {
      uses: "./.github/workflows/build-daytona-snapshot.yml",
      if: "${{ github.event.inputs.snapshot_name == '' }}",
      secrets: "inherit",
      with: {
        doppler_config: "dev",
      },
    },

    // Test against Daytona
    test: {
      // Must use AMD64 runner to match Daytona's requirements
      "runs-on": "ubuntu-24.04",
      needs: ["build-snapshot"],
      if: "${{ always() && (needs.build-snapshot.result == 'success' || github.event.inputs.snapshot_name != '') }}",
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Run Daytona Provider Base Image Test",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "daytona",
            SANDBOX_TEST_SNAPSHOT_ID:
              "${{ github.event.inputs.snapshot_name || needs.build-snapshot.outputs.snapshot_name }}",
            SANDBOX_TEST_BASE_DAYTONA_SNAPSHOT:
              "${{ github.event.inputs.snapshot_name || needs.build-snapshot.outputs.snapshot_name }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          ...uses("nick-fields/retry@v3", {
            timeout_minutes: 10,
            max_attempts: 3,
            retry_wait_seconds: 30,
            command:
              "doppler run -- pnpm --filter @iterate-com/sandbox exec vitest run test/provider-base-image.test.ts --maxWorkers=1",
          }),
        },
        {
          name: "Upload test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "daytona-provider-test-logs",
            path: "sandbox/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
