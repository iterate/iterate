import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox image once, then:
 * 1) run Docker-provider tests,
 * 2) run Fly-provider tests,
 * 3) upload same image to Daytona,
 * then run Daytona-provider tests.
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
        image_name: {
          description: "Docker image name/tag to use",
          required: false,
          type: "string",
          default: "iterate-sandbox:ci",
        },
      },
    },
  },
  jobs: {
    "build-image": {
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        image_tag: "${{ steps.metadata.outputs.image_tag }}",
        git_sha: "${{ steps.metadata.outputs.git_sha }}",
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
          run: [
            "set -euo pipefail",
            'short_sha="$(git rev-parse --short=7 HEAD)"',
            'git_sha="$(git rev-parse HEAD)"',
            'image_tag="iterate-sandbox:sha-${short_sha}"',
            'fly_image_tag="registry.fly.io/iterate-sandbox-image:sha-${short_sha}"',
            'echo "image_tag=${image_tag}" >> "$GITHUB_OUTPUT"',
            'echo "git_sha=${git_sha}" >> "$GITHUB_OUTPUT"',
            'echo "fly_image_tag=${fly_image_tag}" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
    },

    "docker-provider-tests": {
      needs: ["build-image"],
      ...utils.runsOnDepotUbuntuForContainerThings,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        ...utils.setupDepot,
        {
          name: "Pull built image from Depot registry",
          env: {
            IMAGE_TAG: "${{ needs.build-image.outputs.image_tag }}",
          },
          run: [
            "set -euo pipefail",
            'short_sha="$(git rev-parse --short=7 HEAD)"',
            'depot_project_id="$(jq -r .id depot.json)"',
            'depot pull "registry.depot.dev/${depot_project_id}:sha-${short_sha}"',
            'docker tag "registry.depot.dev/${depot_project_id}:sha-${short_sha}" "$IMAGE_TAG"',
          ].join("\n"),
        },
        {
          name: "Run Docker provider tests",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "docker",
            SANDBOX_TEST_SNAPSHOT_ID: "${{ needs.build-image.outputs.image_tag }}",
            DOCKER_DEFAULT_IMAGE: "${{ needs.build-image.outputs.image_tag }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
          },
          run: "pnpm sandbox test:docker",
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
      ],
    },

    "fly-provider-tests": {
      needs: ["build-image"],
      ...utils.runsOnDepotUbuntuForContainerThings,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Run Fly provider tests",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "fly",
            SANDBOX_TEST_SNAPSHOT_ID: "${{ needs.build-image.outputs.fly_image_tag }}",
            FLY_DEFAULT_IMAGE: "${{ needs.build-image.outputs.fly_image_tag }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm sandbox test test/provider-base-image.test.ts --maxWorkers=1",
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

    "upload-daytona-snapshot": {
      needs: ["build-image"],
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        snapshot_name: "${{ steps.push.outputs.snapshot_name }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        ...utils.setupDepot,
        {
          name: "Pull built image from Depot registry",
          env: {
            IMAGE_TAG: "${{ needs.build-image.outputs.image_tag }}",
          },
          run: [
            "set -euo pipefail",
            'short_sha="$(git rev-parse --short=7 HEAD)"',
            'depot_project_id="$(jq -r .id depot.json)"',
            // Daytona snapshots must always be amd64
            'depot pull --platform linux/amd64 "registry.depot.dev/${depot_project_id}:sha-${short_sha}"',
            'docker tag "registry.depot.dev/${depot_project_id}:sha-${short_sha}" "$IMAGE_TAG"',
          ].join("\n"),
        },
        {
          name: "Install and configure Daytona CLI",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            'ARCH=$(uname -m); if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; elif [ "$ARCH" = "x86_64" ]; then ARCH="amd64"; fi',
            'for i in 1 2 3; do curl -sfLo daytona "https://download.daytona.io/cli/latest/daytona-linux-$ARCH" && break; echo "Attempt $i failed, retrying in 5s..."; sleep 5; done',
            "test -f daytona || { echo 'Failed to download Daytona CLI after 3 attempts'; exit 1; }",
            "sudo chmod +x daytona && sudo mv daytona /usr/local/bin/",
            "daytona version",
            "mkdir -p ~/.config/daytona",
            `doppler run -- bash -c 'jq -n \\
              --arg apiKey "$DAYTONA_API_KEY" \\
              --arg orgId "$DAYTONA_ORG_ID" \\
              "{activeProfile: \\"ci\\", profiles: [{id: \\"ci\\", name: \\"ci\\", api: {url: \\"https://app.daytona.io/api\\", key: \\$apiKey}, activeOrganizationId: \\$orgId}]}" \\
              > ~/.config/daytona/config.json'`,
            "daytona snapshot list --limit 1",
          ].join("\n"),
        },
        {
          id: "push",
          name: "Upload snapshot to Daytona",
          env: {
            IMAGE_TAG: "${{ needs.build-image.outputs.image_tag }}",
            CI: "true",
          },
          run: [
            "set -euo pipefail",
            'short_sha="$(git rev-parse --short=7 HEAD)"',
            'snapshot_name="iterate-sandbox-sha-${short_sha}"',
            'pnpm sandbox daytona:push --no-update-doppler --name "$snapshot_name" --image "$IMAGE_TAG" | tee /tmp/push-output.txt',
            'snapshot_name=$(grep -m 1 "^snapshot_name=" /tmp/push-output.txt | sed "s/^snapshot_name=//")',
            'echo "snapshot_name=$snapshot_name" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
    },

    "daytona-provider-tests": {
      needs: ["upload-daytona-snapshot"],
      if: "${{ needs.upload-daytona-snapshot.result == 'success' }}",
      ...utils.runsOnDepotUbuntuForContainerThings,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Run Daytona provider tests",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "daytona",
            SANDBOX_TEST_SNAPSHOT_ID: "${{ needs.upload-daytona-snapshot.outputs.snapshot_name }}",
            DAYTONA_DEFAULT_SNAPSHOT: "${{ needs.upload-daytona-snapshot.outputs.snapshot_name }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "pnpm sandbox test:daytona",
        },
        {
          name: "Upload Daytona test results",
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
