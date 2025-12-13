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
          value: "${{ jobs.deploy-os.outputs.worker_url }}",
        },
      },
    },
  },
  permissions: {
    contents: "read",
    deployments: "write",
  },
  jobs: {
    "deploy-os": {
      name: "deploy-os ${{ inputs.stage }}",
      "timeout-minutes": 15,
      ...utils.runsOn,
      outputs: {
        worker_url: "${{ steps.alchemy_deploy.outputs.worker_url }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
        {
          name: "Enable QEMU",
          uses: "docker/setup-qemu-action@v3",
          with: {
            platforms: "all",
          },
        },
        {
          id: "alchemy_deploy",
          name: "Deploy using Alchemy",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            STAGE: "${{ inputs.stage }}",
          },
          run: "pnpm run deploy",
          "working-directory": "apps/os",
        },
      ],
    },
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
          "working-directory": "estates/iterate/apps/website",
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
