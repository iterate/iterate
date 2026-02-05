import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

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
    workflow_dispatch: {},
  },
  jobs: {
    test: {
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        uses("docker/setup-buildx-action@v3"),
        {
          name: "build-docker-image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "ghcr.io/iterate/sandbox:ci",
            SANDBOX_BUILD_PLATFORM:
              "${{ github.repository_owner == 'iterate' && 'linux/arm64' || 'linux/amd64' }}",
          },
          run: "pnpm os docker:build",
        },
        {
          name: "Run Local Docker Tests",
          env: {
            RUN_LOCAL_DOCKER_TESTS: "true",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
            LOCAL_DOCKER_IMAGE_NAME: "ghcr.io/iterate/sandbox:ci",
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
