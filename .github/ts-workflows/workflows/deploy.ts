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
          uses: "nick-fields/retry@v3",
          with: {
            timeout_minutes: 10,
            max_attempts: 3,
            // This sometimes flakes: db:migrate currently uses unpooled postgres client and can exhaust
            // PlanetScale connection slots transiently. Retry smooths over that until migration path is fixed.
            command: "cd apps/os && pnpm run deploy:prd",
          },
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DAYTONA_SNAPSHOT_NAME: "${{ inputs.daytona_snapshot_name }}",
            VITE_DAYTONA_SNAPSHOT_NAME: "${{ inputs.daytona_snapshot_name }}",
          },
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
  },
} satisfies Workflow;
