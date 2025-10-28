import type { Workflow } from "@jlarky/gha-ts/workflow-types";

export default {
  name: "Deploy to Cloudflare",
  on: {
    push: {
      branches: ["main", "mmkal/25/10/28/runonboardingagainststaging"],
    },
    workflow_dispatch: {
      inputs: {
        stage: {
          description:
            "The stage to deploy to. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          required: true,
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
      steps: [
        {
          id: "get_stage",
          name: "Get stage",
          run: "echo \"stage=${{ inputs.stage || 'stg' }}\" >> $GITHUB_OUTPUT",
        },
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
        },
        {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@v4",
        },
        {
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        {
          name: "Install dependencies",
          run: "pnpm install",
        },
        {
          name: "Install Doppler CLI",
          uses: "dopplerhq/cli-action@v2",
        },
        {
          name: "Setup Doppler",
          run: "doppler setup --config ${{ steps.get_stage.outputs.stage }} --project os",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
        },
        {
          name: "Enable QEMU",
          uses: "docker/setup-qemu-action@v3",
          with: {
            platforms: "all",
          },
        },
        {
          name: "Deploy OS",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            STAGE: "${{ steps.get_stage.outputs.stage }}",
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
        {
          id: "get_stage",
          name: "Get stage",
          run: "echo \"stage=${{ inputs.stage || 'stg' }}\" >> $GITHUB_OUTPUT",
        },
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
        },
        {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@v4",
        },
        {
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        {
          name: "Install dependencies",
          run: "pnpm install",
        },
        {
          name: "Install Doppler CLI",
          uses: "dopplerhq/cli-action@v2",
        },
        {
          name: "Setup Doppler",
          run: "doppler setup --config ${{ steps.get_stage.outputs.stage }} --project os",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
        },
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
  },
} satisfies Workflow;
