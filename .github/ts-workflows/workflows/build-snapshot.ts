import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Reusable workflow to build a Daytona snapshot.
 * Call this from other workflows to avoid building the same snapshot multiple times.
 *
 * Usage:
 *   build-snapshot:
 *     uses: ./.github/workflows/build-snapshot.yml
 *     secrets: inherit
 *     with:
 *       doppler_config: dev  # or prd
 *
 * Then depend on it and use the output:
 *   my-job:
 *     needs: [build-snapshot]
 *     env:
 *       DAYTONA_SNAPSHOT_NAME: ${{ needs.build-snapshot.outputs.snapshot_name }}
 */
export default workflow({
  name: "Build Daytona Snapshot",
  on: {
    workflow_call: {
      inputs: {
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
      },
    },
  },
  jobs: {
    build: {
      // Must use AMD64 runner - Daytona requires AMD64 images and QEMU emulation segfaults
      "runs-on": "ubuntu-24.04",
      outputs: {
        snapshot_name: "${{ steps.build.outputs.snapshot_name }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.doppler_config }}" }),
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
        uses("docker/setup-buildx-action@v3"),
        {
          name: "Build local sandbox image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "ghcr.io/iterate/sandbox:ci",
            // Daytona requires AMD64 images regardless of runner architecture
            SANDBOX_BUILD_PLATFORM: "linux/amd64",
          },
          run: "pnpm os docker:build",
        },
        {
          id: "build",
          name: "Build and push Daytona snapshot",
          env: {
            CI: "true",
            LOCAL_DOCKER_IMAGE_NAME: "ghcr.io/iterate/sandbox:ci",
            SANDBOX_ITERATE_REPO_REF: "${{ github.sha }}",
          },
          run: [
            "set -euo pipefail",
            "output_file=$(mktemp)",
            "snapshot_name=iterate-sandbox-${{ github.sha }}",
            // CLI is configured via config file, no doppler run needed
            // Pass --image explicitly to use the :ci tagged image (script appends :local otherwise)
            'pnpm os daytona:build --no-update-doppler --name "$snapshot_name" --image "$LOCAL_DOCKER_IMAGE_NAME" | tee "$output_file"',
            "snapshot_name=$(grep -m 1 '^snapshot_name=' \"$output_file\" | sed 's/^snapshot_name=//')",
            'echo "snapshot_name=$snapshot_name" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
    },
  },
});
