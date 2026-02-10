import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox image and push to Daytona as a snapshot on the same runner.
 *
 * Can also reuse an existing local image by passing image_tag and build_image=false.
 * Snapshot name format: iterate-sandbox-sha-{shortSha}
 */
export default workflow({
  name: "Push Daytona Snapshot",
  permissions: {
    contents: "read",
    "id-token": "write",
  },
  on: {
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to build (branch, tag, or SHA). Leave empty for current branch.",
          required: false,
          type: "string",
          default: "",
        },
        doppler_config: {
          description: "Doppler config to use (dev, prd, etc.)",
          required: false,
          type: "string",
          default: "dev",
        },
        image_tag: {
          description: "Local Docker image tag to push (from build-sandbox-image output)",
          required: false,
          type: "string",
          default: "",
        },
        build_image: {
          description: "Build sandbox image in this same job before pushing snapshot",
          required: false,
          type: "boolean",
          default: true,
        },
        docker_platform: {
          description: "Sandbox image build platform",
          required: false,
          type: "string",
          default: "linux/amd64",
        },
        update_fly_doppler: {
          description: "Update Doppler FLY_DEFAULT_IMAGE after build",
          required: false,
          type: "boolean",
          default: false,
        },
        fly_doppler_configs_to_update: {
          description: "Comma-separated Doppler configs to update for FLY_DEFAULT_IMAGE",
          required: false,
          type: "string",
          default: "",
        },
        update_doppler: {
          description: "Update Doppler DAYTONA_DEFAULT_SNAPSHOT after push",
          required: false,
          type: "boolean",
          default: false,
        },
      },
    },
    workflow_call: {
      inputs: {
        ref: {
          description: "Git ref to checkout (branch, tag, or SHA). Uses workflow ref if empty.",
          required: false,
          type: "string",
          default: "",
        },
        doppler_config: {
          description: "Doppler config to use (dev, prd, etc.)",
          required: true,
          type: "string",
        },
        image_tag: {
          description: "Local Docker image tag to push (from build-sandbox-image output)",
          required: false,
          type: "string",
          default: "",
        },
        build_image: {
          description: "Build sandbox image in this same job before pushing snapshot",
          required: false,
          type: "boolean",
          default: true,
        },
        docker_platform: {
          description: "Sandbox image build platform",
          required: false,
          type: "string",
          default: "linux/amd64",
        },
        update_fly_doppler: {
          description: "Update Doppler FLY_DEFAULT_IMAGE after build",
          required: false,
          type: "boolean",
          default: false,
        },
        fly_doppler_configs_to_update: {
          description: "Comma-separated Doppler configs to update for FLY_DEFAULT_IMAGE",
          required: false,
          type: "string",
          default: "",
        },
        update_doppler: {
          description: "Update Doppler DAYTONA_DEFAULT_SNAPSHOT after push",
          required: false,
          type: "boolean",
          default: false,
        },
      },
      outputs: {
        snapshot_name: {
          description: "The name of the pushed snapshot (iterate-sandbox-sha-{shortSha})",
          value: "${{ jobs.push.outputs.snapshot_name }}",
        },
      },
    },
  },
  jobs: {
    push: {
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        snapshot_name: "${{ steps.push.outputs.snapshot_name }}",
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
        ...utils.setupDoppler({ config: "${{ inputs.doppler_config || 'dev' }}" }),
        ...utils.setupDepot,
        {
          if: "${{ inputs.build_image }}",
          name: "Build sandbox image",
          env: {
            SANDBOX_BUILD_PLATFORM: "${{ inputs.docker_platform }}",
            SANDBOX_SKIP_LOAD: "false",
            SANDBOX_UPDATE_DOPPLER: "${{ inputs.update_fly_doppler && 'true' || 'false' }}",
            SANDBOX_DOPPLER_CONFIGS: "${{ inputs.fly_doppler_configs_to_update }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "echo '::group::Build sandbox image'",
            "time doppler run -- pnpm sandbox build",
            "echo '::endgroup::'",
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
          name: "Push Daytona snapshot",
          uses: "nick-fields/retry@v3",
          env: {
            CI: "true",
          },
          with: {
            timeout_minutes: 10,
            max_attempts: 3,
            retry_wait_seconds: 30,
            command: [
              "set -euo pipefail",
              'short_sha="$(git rev-parse --short=7 HEAD)"',
              'snapshot_name="iterate-sandbox-sha-${short_sha}"',
              'image_tag="${{ inputs.image_tag }}"',
              '[ -z "$image_tag" ] && image_tag="iterate-sandbox:sha-${short_sha}"',
              '[ "${{ inputs.build_image }}" = "true" ] || [ -n "${{ inputs.image_tag }}" ] || { echo "image_tag is required when build_image=false"; exit 1; }',
              'update_flag=""',
              '${{ inputs.update_doppler }} || update_flag="--no-update-doppler"',
              'pnpm sandbox daytona:push --name "$snapshot_name" --image "$image_tag" $update_flag | tee /tmp/push-output.txt',
              'snapshot_name=$(grep -m 1 "^snapshot_name=" /tmp/push-output.txt | sed "s/^snapshot_name=//")',
              'echo "snapshot_name=$snapshot_name" >> "$GITHUB_OUTPUT"',
            ].join("\n"),
          },
        },
      ],
    },
  },
});
