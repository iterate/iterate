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
          id: "check-image",
          name: "Check if image exists",
          run: [
            "set -euo pipefail",
            'IMAGE_NAME="ghcr.io/iterate/sandbox-cache:sha-${{ github.sha }}"',
            'echo "image_name=$IMAGE_NAME" >> $GITHUB_OUTPUT',
            "# Check if image exists in registry (manifest inspect returns 0 if exists)",
            'if docker manifest inspect "$IMAGE_NAME" > /dev/null 2>&1; then',
            '  echo "exists=true" >> $GITHUB_OUTPUT',
            '  echo "Image already exists: $IMAGE_NAME"',
            "else",
            '  echo "exists=false" >> $GITHUB_OUTPUT',
            '  echo "Image not found, will build: $IMAGE_NAME"',
            "fi",
          ].join("\n"),
        },
        {
          id: "build",
          name: "Build Docker image (if needed)",
          if: "steps.check-image.outputs.exists != 'true'",
          env: {
            SANDBOX_BUILD_PLATFORM:
              "${{ github.repository_owner == 'iterate' && 'linux/arm64' || 'linux/amd64' }}",
            // Use local buildx with registry cache instead of remote Depot builders
            DOCKER_BUILD_MODE: "local",
            // Push to registry instead of loading locally (avoids 55s tarball overhead)
            DOCKER_OUTPUT_MODE: "push",
          },
          run: "pnpm os docker:build",
        },
        {
          name: "Pull image from registry",
          run: "docker pull ${{ steps.check-image.outputs.image_name }}",
        },
        {
          name: "Run Local Docker Tests",
          env: {
            RUN_LOCAL_DOCKER_TESTS: "true",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
            // Use the pre-pulled image
            LOCAL_DOCKER_IMAGE_NAME: "${{ steps.check-image.outputs.image_name }}",
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
