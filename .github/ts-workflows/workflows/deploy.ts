import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Deploy to Cloudflare",
  on: {
    // this should be called from ci.ts (/ci.yml)
    workflow_call: {
      inputs: {
        stage: {
          description:
            "The stage to deploy to. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          required: true,
          type: "string",
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
    "deploy-website": {
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}",
      if: "inputs.stage == 'prd'",
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
        {
          name: "Deploy Website",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "pnpm run deploy",
          "working-directory": "apps/iterate-com",
        },
      ],
    },
    "deploy-mcp-mock-server": {
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}",
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
        {
          name: "Deploy Mock MCP Server",
          "working-directory": "apps/mcp-mock-server",
          run: "pnpm run deploy",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            STAGE: "${{ inputs.stage }}",
          },
        },
      ],
    },
  },
} satisfies Workflow;
