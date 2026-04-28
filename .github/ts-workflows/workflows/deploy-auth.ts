import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Deploy Auth Worker",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  concurrency: {
    group: "auth-${{ github.ref_name || inputs.stage || 'prd' }}",
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
        stage: {
          description: "Doppler config to deploy for manual runs.",
          required: false,
          type: "string",
          default: "prd",
        },
      },
    },
  },
  jobs: {
    variables: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      outputs: {
        stage: "${{ steps.vars.outputs.stage }}",
      },
      steps: [
        {
          id: "vars",
          name: "Resolve workflow variables",
          run: "echo \"stage=${{ github.event_name == 'push' && 'prd' || inputs.stage || 'prd' }}\" >> \"$GITHUB_OUTPUT\"",
        },
      ],
    },
    deploy: {
      needs: ["variables"],
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.getSetupRepo({
          ref: "${{ inputs.ref || github.sha }}",
        }),
        ...utils.setupDoppler({
          config: "${{ needs.variables.outputs.stage }}",
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
