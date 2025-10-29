import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Test",
  on: {
    push: {
      branches: ["main"],
    },
    pull_request: {},
  },
  jobs: {
    test: {
      ...utils.runsOn,
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
          name: "Install Doppler CLI",
          uses: "dopplerhq/cli-action@v2",
        },
        {
          name: "Setup Doppler",
          run: "doppler setup --config dev --project os",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
        },
        {
          name: "Run Tests",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm test",
        },
      ],
    },
  },
});
