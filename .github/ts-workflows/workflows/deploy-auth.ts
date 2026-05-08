import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Deploy Auth Worker",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  concurrency: {
    group: "auth-${{ github.ref_name || 'prd' }}",
    "cancel-in-progress": true,
  },
  on: {
    push: {
      branches: ["main"],
      paths: ["apps/auth/**", "apps/auth-contract/**"],
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
          project: "auth",
        }),
        {
          name: "Deploy apps/auth",
          "working-directory": "apps/auth",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm alchemy:up",
        },
      ],
    },
  },
});
