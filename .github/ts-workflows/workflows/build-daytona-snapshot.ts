import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build and push a Daytona snapshot.
 *
 * The Docker image is built using `pnpm os docker:build` (same as build-docker-image.yml)
 * then pushed to Daytona. Both steps must run in the same job since Daytona needs
 * the image in the local Docker daemon.
 *
 * Usage:
 *   build-daytona-snapshot:
 *     uses: ./.github/workflows/build-daytona-snapshot.yml
 *     secrets: inherit
 *     with:
 *       doppler_config: dev  # or prd
 *
 * Then depend on it and use the output:
 *   my-job:
 *     needs: [build-daytona-snapshot]
 *     env:
 *       DAYTONA_SNAPSHOT_NAME: ${{ needs.build-daytona-snapshot.outputs.snapshot_name }}
 */
export default workflow({
  name: "Build Daytona Snapshot",
  permissions: {
    contents: "read",
    "id-token": "write", // Required for Depot OIDC authentication
  },
  on: {
    // Directly invokable for testing any commit
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
    // Reusable by other workflows
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
          value: "${{ jobs.build.outputs.snapshot_name }}",
        },
        git_sha: {
          description: "Git SHA that was built",
          value: "${{ jobs.build.outputs.git_sha }}",
        },
      },
    },
  },
  jobs: {
    build: {
      // Must use AMD64 runner - Daytona requires AMD64 images and QEMU emulation segfaults
      "runs-on": "ubuntu-24.04",
      outputs: {
        snapshot_name: "${{ steps.push.outputs.snapshot_name }}",
        git_sha: "${{ steps.push.outputs.git_sha }}",
      },
      steps: [
        // Checkout with configurable ref
        {
          name: "Checkout code",
          ...uses("actions/checkout@v4", {
            ref: "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}",
          }),
        },
        // Setup pnpm
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
        // Setup Doppler
        ...utils.setupDoppler({ config: "${{ inputs.doppler_config }}" }),
        // Install and configure Daytona CLI
        {
          name: "Install and configure Daytona CLI",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            // Install CLI
            'ARCH=$(uname -m); if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; elif [ "$ARCH" = "x86_64" ]; then ARCH="amd64"; fi',
            'curl -sfLo daytona "https://download.daytona.io/cli/latest/daytona-linux-$ARCH"',
            "sudo chmod +x daytona && sudo mv daytona /usr/local/bin/",
            "daytona version",
            // Configure CLI with API key (CLI doesn't use env vars, needs config file)
            "mkdir -p ~/.config/daytona",
            `doppler run -- bash -c 'cat > ~/.config/daytona/config.json << EOF
{
  "activeProfile": "ci",
  "profiles": [{
    "id": "ci",
    "name": "ci",
    "api": {
      "url": "https://app.daytona.io/api",
      "key": "$DAYTONA_API_KEY"
    },
    "activeOrganizationId": "$DAYTONA_ORG_ID"
  }]
}
EOF'`,
            // Verify auth works
            "daytona snapshot list --limit 1",
          ].join("\n"),
        },
        // Setup Depot CLI
        ...utils.setupDepot,
        // Build sandbox image (uses same script as build-sandbox-image.yml)
        {
          name: "Build sandbox image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "iterate-sandbox:ci",
            // Daytona requires AMD64 images regardless of runner architecture
            SANDBOX_BUILD_PLATFORM: "linux/amd64",
          },
          run: [
            "echo '::group::Build timing'",
            "time pnpm os docker:build",
            "echo '::endgroup::'",
          ].join("\n"),
        },
        // Push to Daytona
        {
          id: "push",
          name: "Push Daytona snapshot",
          env: {
            CI: "true",
            LOCAL_DOCKER_IMAGE_NAME: "iterate-sandbox:ci",
            SANDBOX_ITERATE_REPO_REF: "${{ github.sha }}",
          },
          run: [
            "set -euo pipefail",
            "output_file=$(mktemp)",
            "git_sha=$(git rev-parse HEAD)",
            'snapshot_name="iterate-sandbox-${git_sha}"',
            // CLI is configured via config file, no doppler run needed
            // Pass --image explicitly to use the :ci tagged image (script appends :local otherwise)
            'pnpm os daytona:build --no-update-doppler --name "$snapshot_name" --image "$LOCAL_DOCKER_IMAGE_NAME" | tee "$output_file"',
            "snapshot_name=$(grep -m 1 '^snapshot_name=' \"$output_file\" | sed 's/^snapshot_name=//')",
            'echo "snapshot_name=$snapshot_name" >> "$GITHUB_OUTPUT"',
            'echo "git_sha=$git_sha" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
    },
  },
});
