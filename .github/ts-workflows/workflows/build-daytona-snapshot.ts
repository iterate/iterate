import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build and push a Daytona snapshot.
 *
 * Docker image build runs in reusable build-docker-image workflow (multi-arch).
 * This workflow pulls the built linux/amd64 image to local Docker, then pushes to Daytona.
 */
export default workflow({
  name: "Build Daytona Snapshot",
  permissions: {
    contents: "read",
    "id-token": "write", // Required for Depot OIDC authentication
  },
  on: {
    // DISABLED: PR builds are too slow while Daytona snapshot creation depends on local image flow.
    // TODO: Re-enable when Daytona supports creating snapshots directly from registry images.
    // pull_request: {
    //   types: ["opened", "synchronize"],
    // },
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
      },
      outputs: {
        snapshot_name: {
          description: "The name of the built snapshot (iterate-sandbox-{commitSha})",
          value: "${{ jobs.push-snapshot.outputs.snapshot_name }}",
        },
        git_sha: {
          description: "Git SHA that was built",
          value: "${{ jobs.push-snapshot.outputs.git_sha }}",
        },
      },
    },
  },
  jobs: {
    "build-image": {
      uses: "./.github/workflows/build-docker-image.yml",
      with: {
        ref: "${{ inputs.ref }}",
        image_name: "iterate-sandbox:ci",
        doppler_config: "${{ inputs.doppler_config || 'dev' }}",
      },
      // @ts-expect-error - secrets inherit
      secrets: "inherit",
    },
    "push-snapshot": {
      needs: ["build-image"],
      // Keep AMD64 builder so local Docker is natively compatible with Daytona image expectations.
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04' || 'ubuntu-24.04' }}",
      outputs: {
        snapshot_name: "${{ steps.push.outputs.snapshot_name }}",
        git_sha: "${{ steps.push.outputs.git_sha }}",
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
            'curl -sfLo daytona "https://download.daytona.io/cli/latest/daytona-linux-$ARCH"',
            "sudo chmod +x daytona && sudo mv daytona /usr/local/bin/",
            "daytona version",
            // Super crufty but reliable: writing config directly works; `daytona login --api-key` has been flaky in CI.
            "mkdir -p ~/.config/daytona",
            `doppler run -- bash -c 'jq -n \\
              --arg apiKey "$DAYTONA_API_KEY" \\
              --arg orgId "$DAYTONA_ORG_ID" \\
              "{activeProfile: \\"ci\\", profiles: [{id: \\"ci\\", name: \\"ci\\", api: {url: \\"https://app.daytona.io/api\\", key: \\$apiKey}, activeOrganizationId: \\$orgId}]}" \\
              > ~/.config/daytona/config.json'`,
            "daytona snapshot list --limit 1",
          ].join("\n"),
        },
        ...utils.setupDepot,
        {
          name: "Pull built image from Depot",
          env: {
            IMAGE_REF: "${{ needs.build-image.outputs.image_ref }}",
            TARGET_IMAGE: "iterate-sandbox:ci",
          },
          run: [
            "set -euo pipefail",
            'project_id="${IMAGE_REF#registry.depot.dev/}"',
            'project_id="${project_id%%:*}"',
            'save_tag="${IMAGE_REF##*:}"',
            'if [ -z "$project_id" ] || [ -z "$save_tag" ]; then',
            '  echo "Invalid Depot image ref: $IMAGE_REF" >&2',
            "  exit 1",
            "fi",
            'depot pull --project "$project_id" "$save_tag" --platform linux/amd64 -t "$TARGET_IMAGE"',
            'docker image inspect "$TARGET_IMAGE" > /dev/null',
          ].join("\n"),
        },
        {
          id: "push",
          name: "Push Daytona snapshot",
          uses: "nick-fields/retry@v3",
          env: {
            CI: "true",
            LOCAL_DOCKER_IMAGE_NAME: "iterate-sandbox:ci",
            SANDBOX_ITERATE_REPO_REF: "${{ needs.build-image.outputs.git_sha }}",
          },
          with: {
            timeout_minutes: 10,
            max_attempts: 3,
            retry_wait_seconds: 30,
            command: [
              "set -euo pipefail",
              "output_file=$(mktemp)",
              "git_sha=$(git rev-parse HEAD)",
              'snapshot_name="iterate-sandbox-${git_sha}"',
              'pnpm os daytona:build --no-update-doppler --name "$snapshot_name" --image "$LOCAL_DOCKER_IMAGE_NAME" | tee "$output_file"',
              "snapshot_name=$(grep -m 1 '^snapshot_name=' \"$output_file\" | sed 's/^snapshot_name=//')",
              'echo "snapshot_name=$snapshot_name" >> "$GITHUB_OUTPUT"',
              'echo "git_sha=$git_sha" >> "$GITHUB_OUTPUT"',
            ].join("\n"),
          },
        },
      ],
    },
  },
});
