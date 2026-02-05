import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox Docker image using Depot.
 *
 * This is the SINGLE code path for building the sandbox Docker image.
 * All other workflows should call this workflow rather than building directly.
 *
 * Features:
 * - Depot layer caching (shared between CI and local dev via project ID)
 * - Configurable platform (linux/amd64, linux/arm64, or both)
 * - Configurable ref (branch, tag, or SHA) for testing any commit
 * - OIDC authentication (no secrets needed)
 */
export default workflow({
  name: "Build Docker Image",
  permissions: {
    contents: "read",
    "id-token": "write", // Required for Depot OIDC authentication
  },
  on: {
    // Reusable by other workflows
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
        image_name: {
          description: "Docker image name/tag",
          required: false,
          type: "string",
          default: "iterate-sandbox:ci",
        },
        doppler_config: {
          description: "Doppler config (dev, stg, prd)",
          required: false,
          type: "string",
          default: "dev",
        },
      },
      outputs: {
        image_ref: {
          description: "Built image reference",
          value: "${{ jobs.build.outputs.image_ref }}",
        },
        git_sha: {
          description: "Git SHA that was built",
          value: "${{ jobs.build.outputs.git_sha }}",
        },
      },
    },
    // Directly invokable for testing any commit
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
        image_name: {
          description: "Docker image name/tag",
          required: false,
          type: "string",
          default: "iterate-sandbox:ci",
        },
        doppler_config: {
          description: "Doppler config (dev, stg, prd)",
          required: false,
          type: "string",
          default: "dev",
        },
      },
    },
  },
  jobs: {
    build: {
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        image_ref: "${{ steps.output.outputs.image_ref }}",
        git_sha: "${{ steps.output.outputs.git_sha }}",
      },
      steps: [
        // Checkout with configurable ref
        {
          name: "Checkout code",
          ...uses("actions/checkout@v4", {
            // Use input ref if provided, otherwise fall back to PR head SHA or workflow SHA
            ref: "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}",
          }),
        },
        // Setup pnpm (no Doppler here - it's in setupDoppler)
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
          id: "build_meta",
          name: "Compute build metadata",
          run: [
            "git_sha=$(git rev-parse HEAD)",
            "depot_project_id=$(node -e \"const fs=require('node:fs'); const id=JSON.parse(fs.readFileSync('depot.json','utf8')).id || ''; process.stdout.write(id)\")",
            'if [ -z "$depot_project_id" ]; then echo "Missing depot.json project id" >&2; exit 1; fi',
            'echo "git_sha=$git_sha" >> $GITHUB_OUTPUT',
            'echo "depot_project_id=$depot_project_id" >> $GITHUB_OUTPUT',
            'echo "depot_save_tag=sha-$git_sha" >> $GITHUB_OUTPUT',
          ].join("\n"),
        },
        {
          name: "Install dependencies",
          run: "pnpm install",
        },
        // Setup Doppler with configurable config
        ...utils.setupDoppler({ config: "${{ inputs.doppler_config }}" }),
        // Setup Depot CLI
        ...utils.setupDepot,
        // Build the image
        {
          name: "Build sandbox image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "${{ inputs.image_name }}",
            SANDBOX_BUILD_PLATFORM: "${{ inputs.docker_platform }}",
            DEPOT_PROJECT_ID: "${{ steps.build_meta.outputs.depot_project_id }}",
            DEPOT_SAVE_TAG: "${{ steps.build_meta.outputs.depot_save_tag }}",
          },
          run: "pnpm os docker:build",
        },
        // Export outputs
        {
          id: "output",
          name: "Export outputs",
          run: [
            'echo "image_ref=registry.depot.dev/${{ steps.build_meta.outputs.depot_project_id }}:${{ steps.build_meta.outputs.depot_save_tag }}" >> $GITHUB_OUTPUT',
            'echo "git_sha=${{ steps.build_meta.outputs.git_sha }}" >> $GITHUB_OUTPUT',
          ].join("\n"),
        },
      ],
    },
  },
});
