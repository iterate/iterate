import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Flake Detection",
  on: {
    push: {
      branches: ["**/*ciflak*"],
    },
    workflow_dispatch: {},
  },
  jobs: {
    "flake-detection": {
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Install Playwright Browsers",
          run: "pnpm exec playwright install chromium --with-deps",
          "working-directory": "e2e",
        },
        {
          name: "Run E2E Tests with Repeats",
          id: "e2e",
          "continue-on-error": true,
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm e2e --repeat-each=10 --reporter=json > e2e-results.json 2>&1 || true",
          "working-directory": "e2e",
        },
        {
          name: "Generate Flaky Test Report",
          id: "report",
          run: "node analyze-flaky-tests.cjs e2e-results.json flaky-report.md",
          "working-directory": "e2e",
        },
        {
          name: "Upload Flaky Test Report",
          if: "always()",
          uses: "actions/upload-artifact@v4",
          with: {
            name: "flaky-test-report",
            path: "e2e/flaky-report.md",
            "retention-days": 30,
          },
        },
      ],
    },
  },
});
