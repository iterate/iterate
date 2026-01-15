import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Flake Detection",
  on: {
    push: {
      branches: ["**/*flak*"],
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
        },
        {
          name: "Run Tests with Repeats",
          "continue-on-error": true,
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "PLAYWRIGHT_JSON_OUTPUT_FILE=spec-results.json pnpm spec --repeat-each=10 --reporter=json || true",
        },
        {
          name: "Generate Flaky Test Report",
          id: "report",
          run: "node spec/analyze-flaky-tests.cjs spec-results.json spec/flaky-report.md",
        },
        {
          name: "Upload Flaky Test Report",
          if: "always()",
          uses: "actions/upload-artifact@v4",
          with: {
            name: "flaky-test-report",
            path: "spec/flaky-report.md",
            "retention-days": 30,
          },
        },
      ],
    },
  },
});
