import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../../utils/index.ts";
import { setupRepoWithoutPnpmAction } from "./paths.ts";

export default workflow({
  name: "jonasland-sandbox-image",
  permissions: {
    contents: "read",
    "id-token": "write",
  },
  on: {
    workflow_call: {
      inputs: {
        ref: {
          description: "Git ref to build (branch, tag, or SHA). Leave empty to use caller SHA.",
          required: false,
          type: "string",
          default: "",
        },
        doppler_config: {
          description: "Doppler config (dev, stg, prd).",
          required: false,
          type: "string",
          default: "dev",
        },
      },
      outputs: {
        image: {
          description: "Fly registry image ref for jonasland sandbox",
          value: "${{ jobs.build.outputs.image }}",
        },
        fly_image_tag: {
          description: "Fly registry image ref",
          value: "${{ jobs.build.outputs.fly_image_tag }}",
        },
        depot_image_tag: {
          description: "Depot registry image ref",
          value: "${{ jobs.build.outputs.depot_image_tag }}",
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
        doppler_config: {
          description: "Doppler config (dev, stg, prd).",
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
        image: "${{ steps.output.outputs.image }}",
        fly_image_tag: "${{ steps.output.outputs.fly_image_tag }}",
        depot_image_tag: "${{ steps.output.outputs.depot_image_tag }}",
        git_sha: "${{ steps.output.outputs.git_sha }}",
      },
      steps: [
        ...setupRepoWithoutPnpmAction,
        ...utils.setupDoppler({ config: "${{ inputs.doppler_config }}" }),
        ...utils.setupDepot,
        {
          name: "Build jonasland sandbox image",
          env: {
            JONASLAND_BUILD_PLATFORM: "linux/amd64,linux/arm64",
            JONASLAND_SKIP_LOAD: "true",
            JONASLAND_PUSH_FLY_REGISTRY: "true",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm --filter ./jonasland/sandbox build",
        },
        {
          id: "output",
          name: "Export image outputs",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "set -euo pipefail",
            'doppler run -- pnpm --filter ./jonasland/sandbox exec tsx scripts/image-refs.ts --format=github-output >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
    },
  },
});
