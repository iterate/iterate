import dedent from "dedent";
import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

const shardTotal = 1;

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
      "timeout-minutes": 60,
      ...utils.runsOn,
      strategy: {
        "fail-fast": false,
        matrix: {
          shardIndex: Array.from({ length: shardTotal }, (_, i) => i + 1),
        },
      },
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
          "continue-on-error": true,
          run: dedent`
            mkdir -p test-results
            pnpm spec --repeat-each=10 --reporter=json --shard=$\{{ matrix.shardIndex }}/${shardTotal}
          `,
          env: {
            PLAYWRIGHT_JSON_OUTPUT_FILE: "test-results/spec-results.json",
          },
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
            name: "flaky-test-results-${{ matrix.shardIndex }}",
            path: "test-results",
            "retention-days": 30,
          }),
        },
      ],
    },
  },
});
