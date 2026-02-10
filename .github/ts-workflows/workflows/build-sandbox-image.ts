import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox image using Depot and push to Fly + Depot registries.
 *
 * This is the SINGLE code path for building the sandbox image.
 * All other workflows should call this workflow rather than building directly.
 *
 * Tags use the format: sha-{shortSha} (no -dirty in CI since tree is always clean).
 * Pushes to both Fly registry and Depot registry automatically.
 */
export default workflow({
  name: "Build Sandbox Image",
  permissions: {
    contents: "read",
    "id-token": "write", // Required for Depot OIDC authentication
  },
  on: {
    workflow_call: {
      inputs: {
        ref: {
          description: "Git ref to checkout (branch, tag, or SHA). Uses workflow ref if empty.",
          required: false,
          type: "string",
          default: "",
        },
        docker_platform: {
          description: "Target platform(s): linux/amd64, linux/arm64, or linux/amd64,linux/arm64",
          required: false,
          type: "string",
          default: "linux/amd64,linux/arm64",
        },
        skip_load: {
          description: "Skip --load into local Docker daemon (faster if image not needed locally)",
          required: false,
          type: "boolean",
          default: false,
        },
        doppler_config: {
          description: "Doppler config (dev, stg, prd)",
          required: false,
          type: "string",
          default: "dev",
        },
        update_doppler: {
          description: "Update Doppler FLY_DEFAULT_IMAGE after Fly push",
          required: false,
          type: "boolean",
          default: false,
        },
        doppler_configs_to_update: {
          description: "Comma-separated Doppler configs to update (e.g. dev,stg,prd)",
          required: false,
          type: "string",
          default: "",
        },
      },
      outputs: {
        image_tag: {
          description: "Local image tag (iterate-sandbox:sha-{shortSha})",
          value: "${{ jobs.build.outputs.image_tag }}",
        },
        fly_image_tag: {
          description: "Fly registry image tag",
          value: "${{ jobs.build.outputs.fly_image_tag }}",
        },
        git_sha: {
          description: "Git SHA that was built",
          value: "${{ jobs.build.outputs.git_sha }}",
        },
      },
    },
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to build (branch, tag, or SHA). Leave empty for current branch.",
          required: false,
          type: "string",
          default: "",
        },
        docker_platform: {
          description: "Target platform(s): linux/amd64, linux/arm64, or linux/amd64,linux/arm64",
          required: false,
          type: "string",
          default: "linux/amd64,linux/arm64",
        },
        skip_load: {
          description: "Skip --load into local Docker daemon",
          required: false,
          type: "boolean",
          default: false,
        },
        doppler_config: {
          description: "Doppler config (dev, stg, prd)",
          required: false,
          type: "string",
          default: "dev",
        },
        update_doppler: {
          description: "Update Doppler FLY_DEFAULT_IMAGE after Fly push",
          required: false,
          type: "boolean",
          default: false,
        },
        doppler_configs_to_update: {
          description: "Comma-separated Doppler configs to update (e.g. dev,stg,prd)",
          required: false,
          type: "string",
          default: "",
        },
      },
    },
  },
  jobs: {
    build: {
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        image_tag: "${{ steps.output.outputs.image_tag }}",
        fly_image_tag: "${{ steps.output.outputs.fly_image_tag }}",
        git_sha: "${{ steps.output.outputs.git_sha }}",
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
        ...utils.setupDoppler({ config: "${{ inputs.doppler_config }}" }),
        ...utils.setupDepot,
        {
          name: "Build sandbox image",
          env: {
            SANDBOX_BUILD_PLATFORM: "${{ inputs.docker_platform }}",
            SANDBOX_SKIP_LOAD: "${{ inputs.skip_load && 'true' || 'false' }}",
            SANDBOX_UPDATE_DOPPLER: "${{ inputs.update_doppler && 'true' || 'false' }}",
            SANDBOX_DOPPLER_CONFIGS: "${{ inputs.doppler_configs_to_update }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "echo '::group::Build sandbox image'",
            "time doppler run -- pnpm sandbox build",
            "echo '::endgroup::'",
          ].join("\n"),
        },
        {
          id: "output",
          name: "Export outputs",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "set -euo pipefail",
            'git_sha="$(git rev-parse HEAD)"',
            'short_sha="$(git rev-parse --short=7 HEAD)"',
            'fly_registry_app="$(doppler secrets get SANDBOX_FLY_REGISTRY_APP --plain 2>/dev/null || echo iterate-sandbox-image)"',
            'image_tag="iterate-sandbox:sha-${short_sha}"',
            'fly_image_tag="registry.fly.io/${fly_registry_app}:sha-${short_sha}"',
            'echo "image_tag=${image_tag}" >> "$GITHUB_OUTPUT"',
            'echo "fly_image_tag=${fly_image_tag}" >> "$GITHUB_OUTPUT"',
            'echo "git_sha=${git_sha}" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
    },
  },
});
