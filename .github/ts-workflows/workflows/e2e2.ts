import { uses, workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "e2e2",
  on: {
    push: {},
  },
  jobs: {
    run: {
      ...utils.runsOn,
      steps: [
        { uses: "actions/checkout@v4" },
        { uses: "pnpm/action-setup@v4" },
        {
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        { run: "pnpm install" },
        { uses: "dopplerhq/cli-action@v2" },
        {
          name: "Setup Doppler",
          run: "doppler setup --project os2 --config dev",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
        },
        {
          name: "Install Playwright browsers",
          "working-directory": "e2e",
          run: "pnpm exec playwright install && pnpm exec playwright install-deps",
        },
        { run: "pnpm os2 e2e" },
        {
          name: "upload e2e logs",
          if: "failure()",
          run: "ls -A ./e2e",
          //   ...uses("actions/upload-artifact@v4", {
          //     name: "e2e-logs",
          //     path: "apps/os/e2e-ignoreme",
          //   }),
        },
      ],
    },
  },
});
