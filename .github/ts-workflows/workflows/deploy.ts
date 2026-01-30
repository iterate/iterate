import dedent from "dedent";
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
        daytona_snapshot_name: {
          description: "The Daytona snapshot name to deploy with (iterate-sandbox-{commitSha})",
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
    "deploy-os": {
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}",
      if: "inputs.stage == 'prd'",
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
        {
          name: "Deploy apps/os",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DAYTONA_SNAPSHOT_NAME: "${{ inputs.daytona_snapshot_name }}",
          },
          run: "pnpm run deploy:prd",
          "working-directory": "apps/os",
        },
      ],
    },
    "deploy-iterate-com": {
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}",
      if: "inputs.stage == 'prd'",
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
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
    "poke-machines-pull": {
      "runs-on": "ubuntu-24.04",
      needs: "deploy-os",
      if: "inputs.stage == 'prd'",
      steps: [
        {
          name: "Poke machines to pull iterate repo",
          env: {
            SERVICE_AUTH_TOKEN: "${{ secrets.SERVICE_AUTH_TOKEN }}",
          },
          run: dedent`
            curl -sf -X POST https://os.iterate.com/api/service/poke-machines-pull \\
              -H "Authorization: Bearer $SERVICE_AUTH_TOKEN" \\
              -H "Content-Type: application/json"
          `,
        },
      ],
    },
  },
} satisfies Workflow;
