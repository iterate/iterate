import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../../utils/index.ts";
import { checkoutRefExpression } from "./paths.ts";

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
        ...utils.getSetupRepo({ ref: checkoutRefExpression }),
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
            'git_sha="$(git rev-parse HEAD)"',
            'short_sha="$(git rev-parse --short=7 HEAD)"',
            'tag_suffix="jonasland-sha-${short_sha}"',
            "depot_project_id=\"$(node -e \"const fs=require('node:fs'); const c=JSON.parse(fs.readFileSync('depot.json','utf8')); if(!c.id){process.exit(1)}; process.stdout.write(c.id)\")\"",
            'jonasland_fly_registry_app="$(doppler secrets get JONASLAND_SANDBOX_FLY_REGISTRY_APP --plain 2>/dev/null || true)"',
            'if [ -z "${jonasland_fly_registry_app}" ]; then jonasland_fly_registry_app="$(doppler secrets get SANDBOX_FLY_REGISTRY_APP --plain)"; fi',
            'fly_image_tag="registry.fly.io/${jonasland_fly_registry_app}:${tag_suffix}"',
            'depot_image_tag="registry.depot.dev/${depot_project_id}:${tag_suffix}"',
            'echo "image=${fly_image_tag}" >> "$GITHUB_OUTPUT"',
            'echo "fly_image_tag=${fly_image_tag}" >> "$GITHUB_OUTPUT"',
            'echo "depot_image_tag=${depot_image_tag}" >> "$GITHUB_OUTPUT"',
            'echo "git_sha=${git_sha}" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
    },
  },
});
