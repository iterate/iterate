import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "dx",
  on: {
    push: {
      branches: ["main", "**/*dx*"],
    },
    workflow_dispatch: {},
  },
  env: {
    SLACK_CLIENT_ID: "fake123",
    DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
  },
  jobs: {
    dx: {
      ...utils.runsOnDepotUbuntuForContainerThings,
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
        { run: "pnpm docker:up" },
        ...utils.setupDoppler({ config: "dev_test" }),
        {
          name: "Install Playwright browsers",
          run: "pnpm exec playwright install && pnpm exec playwright install-deps",
        },
        {
          name: "DX Setup",
          run: "tsx scripts/dx.ts setup",
        },
        {
          name: "DX Bootstrap (create org/project/machine)",
          run: "tsx scripts/dx.ts bootstrap",
        },
        {
          name: "DX OS HMR Check",
          run: "tsx scripts/dx.ts os-hmr",
        },
        {
          name: "DX Daemon Sync Check",
          run: "tsx scripts/dx.ts daemon-sync",
        },
        {
          name: "DX Cleanup",
          if: "always()",
          run: "tsx scripts/dx.ts cleanup",
        },
        {
          name: "Upload results",
          if: "always()",
          ...uses("actions/upload-artifact@v4", {
            name: "dx-results",
            path: "test-results",
          }),
        },
      ],
    },
  },
});
