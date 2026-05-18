import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Deploy to Cloudflare",
  on: {
    // this should be called from ci.ts (/ci.yml)
    workflow_call: {
      inputs: {
        deploy_iterate_com: {
          description: "Whether to deploy apps/iterate-com",
          required: false,
          type: "boolean",
          default: true,
        },
      },
      outputs: {
        worker_url: {
          description: "The URL of the deployed worker.",
          value: "",
        },
      },
    },
  },
  permissions: {
    contents: "read",
    deployments: "write",
  },
  jobs: {
    "deploy-iterate-com": {
      ...utils.runsOnDepotUbuntu,
      if: "inputs.deploy_iterate_com",
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "prd" }),
        {
          name: "Deploy apps/iterate-com",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "pnpm run deploy",
          "working-directory": "apps/iterate-com",
        },
      ],
    },
  },
} satisfies Workflow;
