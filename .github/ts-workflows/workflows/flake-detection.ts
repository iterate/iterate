import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Flake Detection",
  on: {
    push: {
      branches: ["**/*flak*"],
    },
    workflow_dispatch: {},
  },
  env: {
    SLACK_CLIENT_ID: "fake123",
    DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
  },
  jobs: {
    "flake-detection": {
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        { run: "pnpm docker:up" },
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Install Playwright Browsers",
          run: "pnpm exec playwright install chromium --with-deps",
        },
        {
          name: "Run Tests with Repeats",
          run: "mkdir -p test-results && PLAYWRIGHT_JSON_OUTPUT_FILE=test-results/spec-results.json pnpm spec --repeat-each=10 --reporter=json",
          "continue-on-error": true,
        },
        {
          name: "Generate Flaky Test Report",
          if: "always()",
          run: "node spec/analyze-flaky-tests.cjs test-results/spec-results.json test-results/flaky-report.md",
        },
        {
          name: "Upload Test Results",
          if: "always()",
          ...uses("actions/upload-artifact@v4", {
            name: "flaky-test-results",
            path: "test-results",
            "retention-days": 30,
          }),
        },
      ],
    },
  },
});
