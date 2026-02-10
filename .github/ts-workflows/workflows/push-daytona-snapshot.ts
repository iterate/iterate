import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Push a pre-built sandbox image to Daytona as a snapshot.
 *
 * Requires the image to already exist in the local Docker daemon
 * (i.e. build-sandbox-image must have run with skip_load=false first).
 *
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
