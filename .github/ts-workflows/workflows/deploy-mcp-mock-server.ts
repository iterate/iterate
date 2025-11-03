import { workflow } from "@jlarky/gha-ts/workflow-types";

export default workflow({
  name: "Deploy Mock MCP Server",
  on: {
    push: {
      branches: ["main"],
      paths: ["apps/mcp-mock-server/**", ".github/workflows/deploy-mcp-mock-server.yml"],
    },
    pull_request: {
      paths: ["apps/mcp-mock-server/**", ".github/workflows/deploy-mcp-mock-server.yml"],
    },
    workflow_dispatch: {
      inputs: {
        stage: {
          description: "Deployment stage (stg or prd)",
          required: true,
          type: "choice",
          options: ["stg", "prd"],
          default: "stg",
        },
      },
    },
  },
  permissions: {
    contents: "read",
    deployments: "write",
  },
  jobs: {
    deploy: {
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
          name: "Setup Node.js",
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
          name: "Deploy Mock MCP Server",
          "working-directory": "apps/mcp-mock-server",
          run: "pnpm run deploy",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            STAGE: "${{ steps.get_stage.outputs.stage }}",
          },
        },
      ],
    },
  },
});
