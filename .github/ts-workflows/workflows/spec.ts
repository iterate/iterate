import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import dedent from "dedent";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "specs",
  on: {
    push: {},
  },
  env: {
    SLACK_CLIENT_ID: "fake123",
    DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
  },
  jobs: {
    specs: {
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
        {
          name: "Install Doppler CLI",
          run: [
            'for i in 1 2 3; do curl -sfLS https://cli.doppler.com/install.sh | sh -s -- --no-package-manager && break; echo "Attempt $i failed, retrying in 5s..."; sleep 5; done',
            "doppler --version || { echo 'Failed to install Doppler CLI after 3 attempts'; exit 1; }",
          ].join("\n"),
        },
        {
          name: "Setup Doppler",
          run: "doppler setup --project os --config dev_test",
        },
        {
          name: "Install Playwright browsers",
          run: "pnpm exec playwright install && pnpm exec playwright install-deps",
        },
        {
          name: "Run specs",
          run: dedent`
            set -o pipefail
            mkdir -p test-results
            # tee everything to a log file but filter out WebServer logs which are noisy
            pnpm spec | tee test-results/spec.txt | grep -v WebServer
          `,
        },
        {
          name: "upload logs",
          if: "always()",
          ...uses("actions/upload-artifact@v4", {
            name: "spec-results",
            path: "test-results",
          }),
        },
      ],
    },
  },
});
