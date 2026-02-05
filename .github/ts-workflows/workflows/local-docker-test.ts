import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Local Docker Tests",
  permissions: {
    contents: "read",
    packages: "write", // for ghcr.io cache push/pull
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
    test: {
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        ...utils.setupBuildx,
        ...utils.loginGhcr,
        {
          id: "build",
          name: "build-docker-image",
          env: {
            SANDBOX_BUILD_PLATFORM:
              "${{ github.repository_owner == 'iterate' && 'linux/arm64' || 'linux/amd64' }}",
            // Use local buildx with registry cache instead of remote Depot builders
            DOCKER_BUILD_MODE: "local",
            // Push to registry instead of loading locally (avoids 55s tarball overhead)
            DOCKER_OUTPUT_MODE: "push",
          },
          run: [
            "set -euo pipefail",
            "output=$(pnpm os docker:build)",
            'echo "$output"',
            "image_name=$(echo \"$output\" | grep -E '^image_name=' | sed 's/^image_name=//')",
            'echo "image_name=$image_name" >> $GITHUB_OUTPUT',
          ].join("\n"),
        },
        {
          name: "Run Local Docker Tests",
          env: {
            RUN_LOCAL_DOCKER_TESTS: "true",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
            // Pull image from registry instead of using local image
            LOCAL_DOCKER_IMAGE_NAME: "${{ steps.build.outputs.image_name }}",
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
