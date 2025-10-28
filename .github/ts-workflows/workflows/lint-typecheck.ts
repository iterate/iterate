import { workflow } from "@jlarky/gha-ts/workflow-types";

export default workflow({
  name: "Lint and Typecheck",
  on: {
    push: {
      branches: ["main"],
    },
    pull_request: null,
  },
  jobs: {
    "lint-typecheck": {
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}",
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
        },
        {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@v4",
        },
        {
          name: "Setup Node",
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
          name: "Run Lint",
          run: "pnpm lint:check",
        },
        {
          name: "Run Typecheck",
          run: "pnpm typecheck",
        },
      ],
    },
  },
});
