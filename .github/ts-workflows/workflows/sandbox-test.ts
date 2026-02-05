import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Fast sandbox smoke test workflow.
 *
 * This workflow intentionally runs only Docker provider base-image coverage.
 * Daytona provider coverage lives in `daytona-test.yml` to avoid duplicate
 * snapshot builds and cross-workflow contention.
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
          name: "Run Docker Provider Base Image Test",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "docker",
            SANDBOX_TEST_SNAPSHOT_ID: "iterate-sandbox:ci",
            SANDBOX_TEST_BASE_DOCKER_IMAGE: "iterate-sandbox:ci",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
          },
          run: "pnpm sandbox test test/provider-base-image.test.ts --maxWorkers=1",
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
  },
});
