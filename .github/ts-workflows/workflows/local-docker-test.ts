import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Two parallel tracks:
 *
 * 1. Daytona build: Creates a Daytona snapshot using their native --dockerfile
 *    builder. This is the production path for sandbox creation.
 *
 * 2. Docker + tests: Builds image locally (no registry push) and runs local
 *    Docker integration tests. Tests the same Dockerfile in a different env.
 *
 * Both tracks run in parallel since they're independent.
 */
export default workflow({
  name: "Local Docker Tests",
  permissions: {
    contents: "read",
  },
  on: {
    push: {
      branches: ["main"],
      paths: [
        "apps/os/sandbox/**",
        "apps/os/backend/providers/local-docker.ts",
        "apps/daemon/**",
        ".github/workflows/local-docker-test.yml",
      ],
    },
    pull_request: {
      paths: [
        "apps/os/sandbox/**",
        "apps/os/backend/providers/local-docker.ts",
        "apps/daemon/**",
        ".github/workflows/local-docker-test.yml",
      ],
    },
    workflow_dispatch: {},
  },
  jobs: {
    // ============ Track 1: Daytona build ============
    "build-daytona-snapshot": {
      uses: "./.github/workflows/build-snapshot.yml",
      // @ts-expect-error - secrets inherit
      secrets: "inherit",
      with: {
        doppler_config: "dev",
      },
    },

    // ============ Track 2: Docker build + tests ============
    "build-sandbox-image": {
      uses: "./.github/workflows/build-sandbox-image.yml",
      // @ts-expect-error - secrets inherit
      secrets: "inherit",
    },
    test: {
      needs: ["build-sandbox-image"],
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Run Local Docker Tests",
          env: {
            RUN_LOCAL_DOCKER_TESTS: "true",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
            LOCAL_DOCKER_IMAGE_NAME: "${{ needs.build-sandbox-image.outputs.image_ref }}",
          },
          run: "pnpm os docker:build:test",
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
