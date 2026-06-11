import { workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflareAppSharedPaths } from "../../../scripts/preview/apps.ts";
import * as utils from "../utils/index.ts";

// The tunnel gateway (tunnels.iterate.com) is a single prd worker, not a
// preview-slotted app — deploy it from main like auth/semaphore.
export default workflow({
  name: "Deploy Tunnels Gateway",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  concurrency: {
    group: "tunnels-${{ github.ref_name || 'prd' }}",
    "cancel-in-progress": true,
  },
  on: {
    push: {
      branches: ["main"],
      paths: ["apps/tunnels/**", ...cloudflareAppSharedPaths],
    },
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to deploy. Leave empty for the current branch or commit.",
          required: false,
          type: "string",
          default: "",
        },
      },
    },
  },
  jobs: {
    deploy: {
      ...utils.runsOnDepotUbuntu,
      steps: [
        ...utils.getSetupRepo({
          ref: "${{ inputs.ref || github.sha }}",
        }),
        ...utils.setupDoppler({
          config: "prd",
          project: "tunnels",
        }),
        {
          name: "Deploy apps/tunnels",
          "working-directory": "apps/tunnels",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm alchemy:up",
        },
      ],
    },
  },
});
